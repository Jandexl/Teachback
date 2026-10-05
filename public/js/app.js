import { h, ICONS } from './dom.js';
import { ask, nudge, dropStale } from './api.js';
import { Dictation, speechSupported } from './speech.js';
import { Recorder, recorderSupported } from './recorder.js';
import { STUDENTS, STUDENT_IDS, FACES } from './students.js';
import { SAMPLE } from './sample.js';

const app = document.getElementById('app');

// ---------------- state ----------------

const state = {
  screen: 'start', // start | loading | present | grading | results | selfquiz | report
  fileName: '',
  slides: [], // { n, text, image?, title? }
  current: 0,
  log: [], // one entry per slide, see newSlideLog()
  draft: '', // what is in the text box right now
  callOn: null, // the classmate you called on (their raised hand), or null to answer the room
  mode: 'full', // 'full' (every slide) or 'reteach' (only your weak slides)
  order: [], // slide indexes to present, in order
  pos: 0, // position in `order`
  attempts: [], // class scores so far: { pct, mode, slides }, to show before and after
  busy: '', // message while waiting for the AI
  error: null, // { message, retry? }
  quiz: null, // { classQuiz, selfQuiz }
  quizRound: 0, // goes up each time you present again, so every attempt gets a fresh quiz
  pastQuestions: [], // every quiz question used so far, so new quizzes do not repeat them
  examAnswers: [],
  selfAnswers: {},
  selfSubmitted: false,
  selfReasons: {}, // your one-sentence "why" for each question you missed
  selfShown: {}, // explanations you have opened
  selfBlankWarned: false,
  selfSkipped: false, // you went to the report without taking your own quiz
  selfParked: false, // skipped: your own quiz is not prepared unless you ask for it
  verifyFailed: false, // the answer check could not run, so the class score is less certain
  report: null,
  listening: false,
  // 'live': words appear as you talk (Chrome, Edge). 'record': record, then Gemini writes it out
  // (Brave, Firefox and others). Brave has no working live speech, so it starts in 'record'.
  voiceMode: speechSupported && !navigator.brave ? 'live' : recorderSupported ? 'record' : 'none',
  recordSecs: 0,
  fromMemory: false, // "Present from memory": the slide text is hidden while you explain
  learnFirst: false, // "Learn first": a study card before you explain each slide (for new topics)
  pages: {}, // which question / section is open on screens shown one item at a time
  learnChosen: false, // you picked "new to this" or "already know it" on the start screen
  cards: {}, // slide index -> { status: 'loading' | 'ready' | 'error', card, error }
};

const MAX_ROUNDS = 6; // answer rounds per slide (enough to call on each raised hand), so one slide cannot go on forever
// "Following" means your explanation worked; "Got it from the slide" means they understood
// from the slide itself, not from you, so it never counts as your teaching.
const MOOD_LABELS = { confused: 'Confused', unsure: 'Not sure yet', following: 'Following', slide: 'From the slide' };

// One entry per slide.
// open: { studentId: their question } for raised hands.
// beliefs: { studentId: wrong idea } for classmates holding a misconception right now.
// misconceptions: every misconception voiced on this slide, and whether you corrected it.
// readAloud: you mostly read the slide out loud instead of explaining it.
// Every wrong idea gets an id, so it can be corrected on any slide and checked in the quiz.
let beliefCount = 0;

function newSlideLog(n) {
  return { n, said: '', phase: 'explain', feed: [], open: {}, moods: {}, round: 0, beliefs: {}, misconceptions: [], readAloud: false };
}

const dictation = new Dictation({
  onText: (text) => {
    state.draft = text;
    noteWriting();
    const box = document.getElementById('draft');
    if (box) {
      box.value = text;
      box.scrollTop = box.scrollHeight;
    }
  },
  onState: (on) => {
    state.listening = on;
    updateMicButton();
  },
  onError: (message, code) => {
    if (code === 'network' && recorderSupported) {
      state.voiceMode = 'record';
      showError('Live voice is not available in this browser, so TeachBack switched to phrase mode: press Talk and your words appear each time you pause.');
      return;
    }
    showError(message + ' You can also type instead.');
  },
});

// Recording mode: phrases are written out by Gemini while you keep talking.
const voice = { base: '', texts: [], pending: 0, session: 0, errorShown: false, quiet: false };

const recorder = new Recorder({
  onState: (on) => {
    state.listening = on;
    state.recordSecs = 0;
    render();
  },
  onTick: (secs) => {
    if (secs === state.recordSecs) return;
    state.recordSecs = secs;
    updateMicButton();
  },
  onLevel: (level, speaking) => updateMeter(level, speaking),
  onQuiet: () => {
    voice.quiet = true;
    updateVoiceStatus();
  },
  onClip: (audio, seq) => transcribeClip(audio, seq),
});

function startRecording() {
  voice.base = state.draft.trim();
  voice.texts = [];
  voice.session++;
  voice.errorShown = false;
  voice.quiet = false;
  recorder.start().catch((err) => showError(err.message));
}

function stopRecording() {
  const clips = recorder.stop();
  if (!clips && !voice.pending) {
    showError('No speech was heard. Check that your microphone is on and selected, then try again, or type instead.');
  }
}

async function transcribeClip(audio, seq) {
  const session = voice.session;
  voice.pending++;
  updateVoiceStatus();
  const previous = [voice.base, ...voice.texts.slice(0, seq).filter(Boolean)].join(' ').slice(-300);
  try {
    const { text } = await ask('transcribe', { audio, previous });
    if (session === voice.session) voice.texts[seq] = text;
  } catch (err) {
    if (/needs a Gemini key/.test(err.message)) {
      // Voice cannot work in this browser without the key: switch to typing for good.
      recorder.cancel();
      state.voiceMode = 'none';
      showError(err.message);
    } else if (session === voice.session && !voice.errorShown) {
      voice.errorShown = true;
      showError(`Part of what you said could not be written out: ${err.message} You can type the missing part.`);
    }
  } finally {
    if (session === voice.session) {
      voice.pending--;
      applyVoiceText();
    }
  }
}

function applyVoiceText() {
  state.draft = [voice.base, ...voice.texts.filter(Boolean)].filter(Boolean).join(' ');
  noteWriting();
  if (!state.listening && voice.pending === 0) {
    render(); // unlock the buttons
    return;
  }
  const box = document.getElementById('draft');
  if (box) {
    box.value = state.draft;
    box.scrollTop = box.scrollHeight;
  }
  updateVoiceStatus();
}

function voiceStatusText() {
  if (state.voiceMode !== 'record') return '';
  if (state.listening && voice.quiet) return 'Can’t hear you yet. Check the microphone is selected in Windows sound settings and allowed for this site.';
  if (state.listening) return voice.pending ? 'Listening… writing out your last phrase.' : 'Listening… each phrase appears after you pause.';
  if (voice.pending) return 'Writing out the last thing you said…';
  return '';
}

function updateVoiceStatus() {
  const el = document.getElementById('voice-status');
  if (el) el.textContent = voiceStatusText();
}

function updateMeter(level, speaking) {
  const meter = document.getElementById('meter');
  if (!meter) return;
  const bars = meter.children;
  const shape = [0.55, 0.85, 1, 0.8, 0.6];
  for (let i = 0; i < bars.length; i++) {
    const h = Math.max(0.15, Math.min(1, level * shape[i] * (0.85 + Math.random() * 0.3)));
    bars[i].style.transform = `scaleY(${h})`;
  }
  meter.classList.toggle('is-speaking', speaking);
}

// ---------------- helpers ----------------

const slideLog = () => state.log[state.current];
const material = () => state.slides.map((s) => ({ n: s.n, text: s.text }));
// Quizzes and the report only cover slides you presented (skipped slides are left out).
const presentedSlides = () => state.slides.filter((_, i) => state.log[i]?.said);
const quizMaterial = () => presentedSlides().map((s) => ({ n: s.n, text: s.text }));
const quizKey = () => presentedSlides().map((s) => s.n).join(',');
const skippedSlides = () => state.slides.filter((_, i) => state.log[i]?.skipped && !state.log[i]?.said).map((s) => s.n);
const history = (upTo = state.log.length) =>
  state.log.slice(0, upTo).map((l) => ({
    n: l.n,
    said: l.said,
    conversation: conversationOf(l),
    open: Object.entries(l.open).map(([student, text]) => ({ student, text })),
    readAloud: Boolean(l.readAloud),
    misconceptions: l.misconceptions || [],
  }));

// What the class remembers while you present a slide: every OTHER slide you have explained,
// in slide order. When re-teaching, that includes slides from the first pass that come later.
const classHistory = () => history().filter((h, i) => i !== state.current && h.said);

const conversationOf = (log) =>
  log.feed.filter((m) => m.from !== 'note').map((m) => ({ who: m.from === 'you' ? 'you' : m.student, text: m.text }));

// Only YOUR words: explanations and answers. Classmates' questions are left out on purpose,
// because they can contain hints, and the quiz must measure what you taught.
// own: leave out what you read off the slides (it does not count as your teaching).
function transcript({ own = false } = {}) {
  return state.log
    .filter((l) => l.said)
    .map((l) => {
      const answers = l.feed.filter((m) => m.from === 'you' && m.kind === 'answer' && !(own && m.readAloud)).map((m) => m.text);
      const lines = [`Slide ${l.n}: ${own && l.readAloud ? '(read from the slide)' : l.said}`];
      if (answers.length) lines.push(`Answering questions on slide ${l.n}: ${answers.join(' ')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// What you read off the slides instead of explaining (explanations and answers). Classmates
// heard it, but it does not count as your teaching in the quiz.
function readAloudText() {
  const texts = [];
  for (const l of state.log) {
    if (l.readAloud && l.said) texts.push(l.said);
    for (const m of l.feed) if (m.from === 'you' && m.kind === 'answer' && m.readAloud) texts.push(m.text);
  }
  return texts;
}

// Is the slide on screen right now (while explaining)? Anything you write or say while you
// can see it counts as possibly read, so copied slide words in it are not "from memory".
function slideVisible(log = slideLog()) {
  return !((state.fromMemory || log?.studyDone) && !log?.peek);
}
function noteWriting() {
  const log = state.screen === 'present' ? slideLog() : null;
  if (log && log.phase === 'explain' && slideVisible(log) && state.draft.trim()) log.sawSlide = true;
}

function set(patch) {
  Object.assign(state, patch);
  render();
}

function showError(message, retry) {
  state.error = { message, retry };
  state.busy = '';
  render();
}

// retry: what "Try again" does. For explaining and answering it starts over from what is in
// the text box now, so any fix you made after the error is what gets sent.
// gone(): true once you have left this class (started over, presented again, re-taught) or
// the work was replaced by newer work. Its late answer is then ignored, so it can never empty
// your new text box, unlock buttons early or show an old error.
async function run(busyMessage, work, retry = () => run(busyMessage, work, retry, replaced), replaced = () => false) {
  const round = state.quizRound;
  const gone = () => round !== state.quizRound || replaced();
  dictation.stop();
  state.error = null;
  set({ busy: busyMessage });
  try {
    await work(gone);
  } catch (err) {
    if (gone()) return;
    showError(err.message || 'Something went wrong.', retry);
    return;
  }
  if (gone()) return;
  set({ busy: '' });
}

// ---------------- actions ----------------

async function openFile(file) {
  state.error = null;
  set({ screen: 'loading', busy: 'Opening your slides…' });
  try {
    const { loadSlides } = await import('./pdf.js');
    const { slides, truncated } = await loadSlides(file, (i, n) => {
      const el = document.getElementById('busy-text');
      if (el) el.textContent = `Reading slide ${i} of ${n}…`;
    });
    if (!slides.length) throw new Error('This PDF has no pages.');
    const textChars = slides.reduce((sum, s) => sum + s.text.length, 0);
    if (textChars < 40) {
      throw new Error('No readable text was found in this PDF. If your slides are pictures or scans, add the key points as text and export again.');
    }
    startClass(file.name, slides);
    if (truncated) showError('Only the first 40 slides were loaded.');
  } catch (err) {
    state.screen = 'start';
    showError(err.message || 'This PDF could not be opened.');
  }
}

// Quizzes are written from the slides only:
// - your class's quiz when you end the class (nothing competes with the live class),
// - your own quiz in the background while you read the class results.
// Every new attempt (re-teach or present again) gets FRESH questions that avoid all earlier
// ones. Otherwise you could raise your score by repeating answers you saw on the results
// page, without understanding anything more.
const quizJobs = { class: null, self: null };

function prepareQuiz(which) {
  const slides = quizMaterial();
  const payload = { material: slides, which, background: which === 'self' };
  const avoid = [...state.pastQuestions, ...(which === 'self' ? (state.quiz?.classQuiz || []).map((q) => q.question) : [])];
  if (avoid.length) payload.avoid = avoid;
  // Re-teach: focus on the slides you actually re-taught this time (not skipped or restored ones).
  if (state.mode === 'reteach') payload.focusSlides = state.order.filter((i) => state.log[i]?.said && !state.log[i]?.restored).map((i) => state.slides[i].n);
  // Your own quiz is written while you read the results: it steps aside for anything you ask
  // for, and is dropped if you start a new attempt before it is done.
  const round = state.quizRound;
  const job = ask('quiz', payload, { background: selfIsBackground(which), stale: quizStale(which, round) });
  job.catch(() => {}); // errors are handled when the quiz is needed
  quizJobs[which] = { key: quizKey(), round: state.quizRound, job };
}

async function getQuiz(which) {
  const key = `${which}Quiz`;
  if (state.quiz?.[key]) return state.quiz[key];
  const round = state.quizRound;
  const job = quizJobs[which];
  if (!job || job.key !== quizKey() || job.round !== round) prepareQuiz(which);
  try {
    const out = await quizJobs[which].job;
    if (round !== state.quizRound) throw new Error('This quiz belongs to an earlier attempt.');
    state.quiz = { ...(state.quiz || {}), [key]: out[key] };
  } catch (err) {
    if (quizJobs[which]?.round === round) quizJobs[which] = null; // the next try starts a fresh request
    throw err;
  }
  return state.quiz[key];
}

// The fast model writes each quiz; then the strong model checks it against the slides
// (fixing wrong answer keys and dropping bad questions) before anyone answers it.
// If the check itself fails, the unchecked quiz is used so the class is never stuck.
const checkJobs = { class: null, self: null };

// Your own quiz is prepared in the background while you read the results, but becomes
// urgent when you open it. If you skip it, it is not prepared at all unless you ask again.
const selfIsBackground = (which) => (which === 'self' ? () => state.screen !== 'selfquiz' : false);
const quizStale = (which, round) => () => round !== state.quizRound || (which === 'self' && state.selfParked);

function checkedQuiz(which) {
  const key = `${which}Quiz`;
  if (state.quiz?.[`${which}Checked`]) return Promise.resolve(state.quiz[key]);
  const round = state.quizRound;
  if (!checkJobs[which] || checkJobs[which].round !== round) {
    const job = (async () => {
      const list = await getQuiz(which);
      let checked = list;
      let failed = false;
      try {
        ({ questions: checked } = await ask('checkQuiz', { material: quizMaterial(), questions: list, background: which === 'self' }, { background: selfIsBackground(which), stale: quizStale(which, round) }));
      } catch (err) {
        if (quizStale(which, round)()) throw err; // no longer needed: do not mark it checked
        console.warn('Quiz check skipped:', err.message);
        failed = true;
      }
      // You started a new attempt meanwhile: this quiz is no longer needed.
      if (round !== state.quizRound) throw new Error('This quiz belongs to an earlier attempt.');
      state.quiz = { ...state.quiz, [key]: checked, [`${which}Checked`]: true, [`${which}CheckFailed`]: failed };
      return state.quiz[key];
    })().finally(() => {
      if (checkJobs[which]?.job === job) checkJobs[which] = null;
    });
    checkJobs[which] = { round, job };
  }
  return checkJobs[which].job;
}

// A new attempt: the old quizzes are retired (and never asked again), and new ones are
// written at the end of this class.
function retireQuiz() {
  const used = [...(state.quiz?.classQuiz || []), ...(state.quiz?.selfQuiz || [])].map((q) => q.question);
  state.pastQuestions = [...state.pastQuestions, ...used].slice(-60);
  state.quizRound++;
  state.quiz = null;
  state.selfAnswers = {};
  state.selfSubmitted = false;
  state.selfSkipped = false;
  state.selfParked = false;
  state.selfReasons = {};
  state.selfShown = {};
  state.selfBlankWarned = false;
  state.pages = {}; // a new quiz and report start at their first question and section
}

function startClass(fileName, slides, { again = false } = {}) {
  dictation.stop();
  recorder.cancel();
  voice.session++;
  voice.pending = 0;
  if (again) retireQuiz();
  else Object.assign(state, { pastQuestions: [], quizRound: state.quizRound + 1 });
  dropStale();
  set({
    screen: 'present',
    fileName,
    slides,
    mode: 'full',
    cardSkips: 0,
    order: slides.map((_, i) => i),
    pos: 0,
    attempts: again ? state.attempts : [],
    current: 0,
    log: slides.map((s) => newSlideLog(s.n)),
    draft: '',
    callOn: null,
    busy: '',
    error: null,
    quiz: null,
    examAnswers: [],
    selfAnswers: {},
    selfSubmitted: false,
    selfSkipped: false,
    selfParked: false,
    selfReasons: {},
    selfShown: {},
    selfBlankWarned: false,
    report: null,
    pages: {},
    cards: again ? state.cards : {}, // same slides: keep the study cards
  });
  enterSlide();
}

function toggleMic() {
  if (state.voiceMode === 'record') {
    if (recorder.active) stopRecording();
    else startRecording();
    return;
  }
  if (state.listening) dictation.stop();
  else dictation.start(state.draft);
}

function finishExplaining() {
  const said = state.draft.trim();
  if (!said) {
    showError('Explain the slide first. Press Talk and explain out loud, or type your explanation.');
    return;
  }
  const log = slideLog();
  // Explained with the slide hidden: saying the slide's own words is recall, not reading.
  const recalled = !slideVisible(log) && !log.sawSlide;
  // Your words stay in the box until the class answers, so nothing is lost if Gemini fails.
  run('The class is thinking…', async (gone) => {
    const turn = await ask(
      'classTurn',
      {
      recalled,
      material: material(),
      slideIndex: state.current,
      slideText: state.slides[state.current].text,
      said,
      history: classHistory(),
      held: heldElsewhere(log),
      studyText: cardText(state.current),
      round: 0,
      },
      { stale: gone }
    );
    if (gone()) return;
    log.said = said;
    log.skipped = false;
    log.recalled = recalled;
    log.feed.push({ from: 'you', kind: 'explain', text: said });
    state.draft = '';
    applyTurn(log, turn);
    afterTurn();
  }, finishExplaining);
}

function sendAnswer() {
  const answer = state.draft.trim();
  if (!answer) {
    showError('Say or type your answer first.');
    return;
  }
  const log = slideLog();
  const calledOn = state.callOn && log.open[state.callOn] ? state.callOn : null;
  const open = Object.entries(log.open).map(([student, text]) => ({ student, text, belief: log.beliefs?.[student] || '' }));
  run(calledOn ? `${STUDENTS[calledOn].name} is listening…` : 'The class is listening…', async (gone) => {
    const turn = await ask(
      'classTurn',
      {
      material: material(),
      slideIndex: state.current,
      slideText: state.slides[state.current].text,
      said: log.said,
      history: classHistory(),
      conversation: conversationOf(log),
      open,
      answer,
      calledOn,
      held: heldElsewhere(log),
      studyText: cardText(state.current),
      round: log.round + 1,
      },
      { stale: gone }
    );
    if (gone()) return;
    log.round += 1;
    log.feed.push({ from: 'you', kind: 'answer', to: calledOn, text: answer });
    state.draft = '';
    state.callOn = null;
    applyTurn(log, turn);
    afterTurn();
  }, sendAnswer);
}

// Updates moods, raised hands and the chat from one class turn.
function applyTurn(log, { students = [], round = 0, readAloud = false, answerReadAloud = false, fixed = [] }) {
  const firstNew = log.feed.length;
  log.beliefs ||= {};
  log.misconceptions ||= [];
  if (round === 0) log.readAloud = Boolean(readAloud) && !log.recalled;
  if (answerReadAloud) {
    const last = log.feed.findLast((m) => m.from === 'you' && m.kind === 'answer');
    if (last) last.readAloud = true;
  }
  // Wrong ideas from earlier slides that you just corrected.
  for (const id of fixed) {
    for (const l of state.log) {
      const m = (l.misconceptions || []).find((x) => x.id === id && !x.corrected);
      if (!m) continue;
      Object.assign(m, { corrected: true, correctedOn: log.n });
      if (l.beliefs?.[m.student] === m.belief) delete l.beliefs[m.student];
    }
  }
  for (const st of students) {
    log.moods[st.id] = st.mood;
    // A classmate voiced a common wrong idea: you have to notice it and correct it.
    if (st.misconception) {
      log.beliefs[st.id] = st.misconception;
      log.misconceptions.push({ id: `B${++beliefCount}`, student: st.id, belief: st.misconception, corrected: false });
    }
    // Re-teaching: a wrong idea you never corrected came back, and is this slide's question again.
    if (st.holding) log.beliefs[st.id] = st.holding;
    if (st.corrected && log.beliefs[st.id]) {
      const m = log.misconceptions.find((x) => x.student === st.id && x.belief === log.beliefs[st.id] && !x.corrected);
      if (m) Object.assign(m, { corrected: true, correctedOn: log.n });
      delete log.beliefs[st.id];
    }
    if (st.say) log.feed.push({ from: 'student', student: st.id, text: st.say, question: st.handUp });
    if (st.handUp) log.open[st.id] = st.say || log.open[st.id];
    else delete log.open[st.id];
  }
  // What screen readers announce: the classmates' new replies.
  turnEffects = {
    announce: log.feed
      .slice(firstNew)
      .filter((m) => m.from === 'student')
      .map((m) => `${STUDENTS[m.student].name}: ${m.text}`)
      .join(' '),
  };
  const stillOpen = Object.keys(log.open);
  if (!stillOpen.length) {
    log.phase = 'done';
  } else if (log.round >= MAX_ROUNDS) {
    log.phase = 'done';
    log.feed.push({
      from: 'note',
      text: `${namesList(stillOpen)} still ${stillOpen.length > 1 ? 'have' : 'has'} a hand up. Their question stays unanswered, and your report will show it.`,
    });
  } else {
    log.phase = 'qa';
  }
}

// ---------- "Learn first" study cards ----------
// A short card per slide (meaning, example, why, common mistake, what the slides leave out),
// written only from your slides. You read it, press "I'm ready", and then explain the slide
// from memory with the slide hidden. Cards are written one slide ahead in the background,
// so the next one is usually ready when you get there.
// Write the next slide's card while you read this one, the quietest moment for the AI.
function prefetchNextCard(i) {
  if (state.screen !== 'present' || state.current !== i || !state.learnFirst || (state.cardSkips || 0) >= 2) return;
  const next = state.order[state.pos + 1];
  if (next !== undefined) requestCard(next);
}

function requestCard(i) {
  const existing = state.cards[i];
  if (existing?.status === 'ready') prefetchNextCard(i);
  if (existing && existing.status !== 'error') return;
  const slide = state.slides[i];
  const slidesNow = state.slides;
  state.cards[i] = { status: 'loading' };
  // Urgent while you are looking at this card; background work otherwise.
  const waitingForIt = () => state.screen === 'present' && state.current === i && Boolean(slideLog()?.studying);
  // A card written ahead can be paused (and restarted) by every class turn. After two pauses it
  // gives up instead of restarting again and again; it is asked for again when you get there.
  ask('study', { material: material(), slideIndex: i, slideText: slide.text }, { background: () => !waitingForIt(), stale: () => state.slides !== slidesNow, maxPauses: 2 })
    .then((card) => {
      if (state.slides !== slidesNow) return;
      state.cards[i] = { status: 'ready', card };
      prefetchNextCard(i);
    })
    .catch((err) => {
      if (state.slides !== slidesNow) return;
      state.cards[i] = { status: 'error', error: err.message };
    })
    .finally(() => {
      // Only redraw if you are waiting for this card; otherwise you may be typing.
      if (state.slides === slidesNow && state.current === i && state.screen === 'present' && slideLog()?.studying) render();
    });
}

function cardText(i) {
  const c = state.cards[i]?.card;
  return c ? [c.meaning, c.example, c.why, c.mistake].filter(Boolean).join(' ') : '';
}

// Called whenever a new slide comes up.
function enterSlide() {
  const log = slideLog();
  if (!state.learnFirst || !log || log.phase !== 'explain' || log.studyDone) return;
  log.studying = true;
  requestCard(state.current); // the next slide's card is written once this one is ready
  render();
  nudge();
}

function studySlide() {
  // The text box is hidden while you study, so stop listening (what you said is kept).
  dictation.stop();
  if (recorder.active) stopRecording();
  const log = slideLog();
  log.studying = true;
  requestCard(state.current);
  render();
  nudge();
}

function readyToExplain() {
  state.cardSkips = 0;
  const log = slideLog();
  Object.assign(log, { studying: false, studyDone: true, peek: false });
  render();
  document.getElementById('draft')?.focus();
}

function skipStudy() {
  slideLog().studying = false;
  state.cardSkips = (state.cardSkips || 0) + 1; // skipped twice in a row: stop writing cards ahead
  render();
}

function StudyCard(log) {
  const entry = state.cards[state.current];
  const actions = h(
    'div',
    { class: 'controls' },
    h('button', { class: 'btn btn-primary', onclick: readyToExplain, disabled: entry?.status === 'loading' }, 'I’m ready to explain it'),
    h('button', { class: 'btn btn-quiet', onclick: skipStudy }, log.studyDone ? 'Back to explaining' : 'Skip the card')
  );
  if (!entry || entry.status === 'loading') {
    return h('div', { class: 'study-card' }, h('h2', {}, 'Learn it first'), h('p', { class: 'hint', role: 'status' }, 'Writing a study card from this slide… Read the slide while you wait.'), actions);
  }
  if (entry.status === 'error') {
    return h(
      'div',
      { class: 'study-card' },
      h('h2', {}, 'Learn it first'),
      h('p', {}, `The study card could not be written: ${entry.error}`),
      h('div', { class: 'controls' }, h('button', { class: 'btn btn-primary', onclick: () => ((state.cards[state.current] = null), studySlide()) }, 'Try again'), h('button', { class: 'btn btn-quiet', onclick: skipStudy }, 'Skip the card'))
    );
  }
  const c = entry.card;
  const part = (title, text, cls = '') => text && h('section', { class: `study-part ${cls}` }, h('h3', {}, title), h('p', {}, text));
  return h(
    'div',
    { class: 'study-card' },
    h('h2', {}, 'Learn it first'),
    c.thin
      ? h('p', {}, c.gaps)
      : [
          part('What it means', c.meaning),
          part('An example', c.example),
          part('Why it works', c.why),
          part('Watch out for', c.mistake),
          part('Your slides don’t explain', c.gaps, 'study-gaps'),
        ],
    h('p', { class: 'fine' }, 'Next, this card and the slide hide, and you explain it in your own words.'),
    actions
  );
}

// After the class answers: read the replies out to screen readers, bring them into view on
// small screens (where the class sits below the text box), and put the cursor back in the
// text box on bigger screens so you can answer straight away.
let turnEffects = null;
const announcer = Object.assign(document.createElement('div'), { className: 'visually-hidden' });
announcer.setAttribute('aria-live', 'polite');
document.body.append(announcer);

function afterTurn() {
  turnEffects ||= { announce: '' };
  turnEffects.ready = true;
}

function applyTurnEffects() {
  if (!turnEffects?.ready || state.screen !== 'present' || state.busy) return;
  const { announce } = turnEffects;
  turnEffects = null;
  if (announce) {
    announcer.textContent = '';
    setTimeout(() => (announcer.textContent = announce), 50);
  }
  const small = window.matchMedia('(max-width: 900px)').matches;
  if (small) {
    document.querySelector('.feed li:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    document.getElementById('draft')?.focus({ preventScroll: true });
  }
}

function toggleCallOn(id) {
  const log = slideLog();
  if (log.phase !== 'qa' || !log.open[id]) return;
  set({ callOn: state.callOn === id ? null : id });
  document.getElementById('draft')?.focus();
}

// Skip a slide you don't need to present (a title, agenda or "thank you" slide). It is left
// out of the quiz and the report.
// True once this pass has something new to quiz: any slide presented (or, when re-teaching,
// any weak slide re-taught; the other slides only keep what you said last time).
function presentedSomething() {
  return state.mode === 'reteach' ? state.order.some((i) => state.log[i]?.said) : state.log.some((l) => l.said);
}
const NOTHING_PRESENTED = () =>
  state.mode === 'reteach'
    ? 'You have not re-taught any of your weak slides yet. Re-teach at least one, so your class has something new to be quizzed on.'
    : 'You have skipped every slide. Present at least one slide so your class has something to learn and be quizzed on.';

function skipSlide() {
  const log = slideLog();
  dictation.stop();
  recorder.cancel();
  const last = state.pos === state.order.length - 1;
  if (last && !presentedSomething()) {
    // Nothing presented: there would be nothing to quiz, so stay on this slide.
    showError(NOTHING_PRESENTED());
    return;
  }
  Object.assign(log, { skipped: true, phase: 'done' });
  state.draft = '';
  advance();
}

// Finish early: the quiz covers only the slides you presented.
function endClassNow() {
  // Nothing new presented (for example re-teaching, before re-teaching any slide): no new quiz.
  if (!presentedSomething()) return showError(NOTHING_PRESENTED());
  const left = state.order.length - state.pos - (slideLog().said ? 1 : 0);
  const unsent = state.draft.trim() ? ' What you typed but did not send will not count.' : '';
  const leftOut =
    left <= 0
      ? ''
      : state.mode === 'reteach'
        ? `The ${left} slide${left > 1 ? 's' : ''} you have not re-taught keep what you said last time.`
        : `The ${left} slide${left > 1 ? 's' : ''} you have not presented will be left out of the quiz.`;
  if (!confirm(`End the class now? ${leftOut}${unsent}`.trim())) return;
  dictation.stop();
  recorder.cancel(); // never keep the microphone on (or send clips) after the class ends
  const log = slideLog();
  const stillOpen = Object.keys(log.open);
  if (stillOpen.length && log.phase === 'qa') log.feed.push({ from: 'note', text: `You ended the class with ${namesList(stillOpen)}'s question unanswered.` });
  if (log.said) log.phase = 'done';
  state.callOn = null;
  endClass();
}

function nextSlide() {
  dictation.stop();
  const log = slideLog();
  const stillOpen = Object.keys(log.open);
  if (stillOpen.length && log.phase === 'qa') {
    log.feed.push({ from: 'note', text: `You moved on with ${namesList(stillOpen)}'s question unanswered.` });
  }
  log.phase = 'done';
  state.callOn = null;
  advance();
}

function advance() {
  if (state.pos < state.order.length - 1) {
    const pos = state.pos + 1;
    set({ pos, current: state.order[pos], draft: '', error: null });
    enterSlide();
  } else if (presentedSomething()) {
    endClass();
  } else {
    showError(NOTHING_PRESENTED());
  }
}

// ---------- re-teach mode ----------
// After the results, present only the slides your class struggled with, then the class
// takes a NEW quiz, mostly about those slides. Explanations from your other slides still
// count, so the new score shows whether re-teaching closed the gaps.

// A slide is weak if any classmate missed a quiz question about it, the report found
// something wrong or missing on it, or you moved on with a hand still up.
function weakSlides() {
  const weak = new Set();
  const qs = state.quiz?.classQuiz || [];
  for (const q of qs) {
    const allRight = STUDENT_IDS.every((st) => state.examAnswers.find((a) => a.id === q.id && a.student === st)?.choice === q.answer);
    if (!allRight && q.slide) weak.add(q.slide - 1);
  }
  for (const item of [...(state.report?.wrong || []), ...(state.report?.missed || [])]) if (item.slide) weak.add(item.slide - 1);
  // Slides behind questions YOU got wrong in your own quiz: you have not understood them yet.
  for (const q of selfMisses()) if (q.slide) weak.add(q.slide - 1);
  state.log.forEach((l, i) => {
    if (Object.keys(l.open || {}).length) weak.add(i); // left with a hand up
    if (l.readAloud) weak.add(i); // read the slide instead of explaining it
    if ((l.misconceptions || []).some((m) => !m.corrected)) weak.add(i); // a wrong idea was never corrected
  });
  // Only slides you presented: skipped slides, or ones after you ended the class, were your choice.
  return [...weak].filter((i) => i >= 0 && i < state.slides.length && state.log[i]?.said).sort((a, b) => a - b);
}

// Questions you got wrong (or left blank) in your own quiz.
function selfMisses() {
  if (!state.selfSubmitted) return [];
  return (state.quiz?.selfQuiz || []).filter((q) => state.selfAnswers[q.id] !== q.answer);
}

// What the class missed on a slide last time (concept names only, not the answers).
function missedOnSlide(index) {
  const concepts = new Set();
  for (const q of state.quiz?.classQuiz || []) {
    if (q.slide !== index + 1) continue;
    const allRight = STUDENT_IDS.every((st) => state.examAnswers.find((a) => a.id === q.id && a.student === st)?.choice === q.answer);
    if (!allRight && q.concept) concepts.add(q.concept);
  }
  for (const m of state.report?.missed || []) if (m.slide === index + 1 && m.concept) concepts.add(m.concept);
  return [...concepts].slice(0, 4);
}

// Other things to fix on a slide, shown when re-teaching it.
function otherFocus(index) {
  const l = state.log[index] || {};
  const notes = [];
  if (l.readAloud) notes.push('You read this slide out loud last time. Explain it in your own words.');
  for (const m of l.misconceptions || []) {
    if (!m.corrected) notes.push(`${STUDENTS[m.student].name} believed “${m.belief}” and you did not correct it.`);
  }
  return notes;
}

function startReteach() {
  const order = weakSlides();
  if (!order.length) return;
  dictation.stop();
  recorder.cancel();
  voice.session++;
  voice.pending = 0;
  // Remember what to work on before the old results are cleared.
  const focus = Object.fromEntries(
    order.map((i) => [
      i,
      { concepts: missedOnSlide(i), notes: otherFocus(i), self: [...new Set(selfMisses().filter((q) => q.slide === i + 1 && q.concept).map((q) => q.concept))] },
    ])
  );
  // A wrong idea you never corrected is still believed: it comes back when you re-teach the slide.
  const log = state.log.map((l, i) =>
    order.includes(i)
      ? { ...newSlideLog(l.n), focus: focus[i], previous: l, misconceptions: (l.misconceptions || []).filter((m) => !m.corrected).map((m) => ({ ...m })) }
      : l
  );
  retireQuiz();
  dropStale();
  set({
    screen: 'present',
    mode: 'reteach',
    order,
    pos: 0,
    current: order[0],
    log,
    draft: '',
    callOn: null,
    busy: '',
    error: null,
    examAnswers: [],
    report: null,
  });
  enterSlide();
}

// Each attempt also keeps its score per slide, so a re-teach can be compared fairly with
// the same slides last time (not with a quiz about different slides).
function recordAttempt(answers) {
  const { pct } = classScore(answers);
  const bySlide = {};
  for (const q of state.quiz?.classQuiz || []) {
    if (!q.slide) continue;
    const s = (bySlide[q.slide] ||= { right: 0, total: 0 });
    for (const st of STUDENT_IDS) {
      s.total++;
      if (answers.find((a) => a.id === q.id && a.student === st)?.choice === q.answer) s.right++;
    }
  }
  const total = (state.quiz?.classQuiz || []).length * STUDENT_IDS.length;
  state.attempts = [...state.attempts, { pct, total, mode: state.mode, slides: state.order.filter((i) => state.log[i]?.said && !state.log[i]?.restored).map((i) => state.slides[i].n), bySlide }];
}

// Score on some slides only: { pct, total }, or null when the quiz had no questions on them.
function slideScore(attempt, slides) {
  let right = 0;
  let total = 0;
  for (const n of slides) {
    right += attempt.bySlide?.[n]?.right || 0;
    total += attempt.bySlide?.[n]?.total || 0;
  }
  return total ? { pct: Math.round((right / total) * 100), total } : null;
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()];
}

const namesList = (ids) => {
  const names = ids.map((id) => STUDENTS[id].name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};

// The end of class: write the quiz, check it, then the class takes it. Each step is shown
// on screen as it happens, so the wait reads as progress.
function endClass() {
  dictation.stop();
  if (!transcript()) {
    showError('You have not explained any slides yet, so your classmates have nothing to be tested on.');
    return;
  }
  // Re-teach slides you skipped or did not reach keep what you said about them last time,
  // so they are still quizzed and still offered for re-teaching.
  const beforeRestore = state.log;
  state.log = state.log.map((l) => (!l.said && l.previous ? { ...l.previous, restored: true } : l));
  state.error = null;
  const round = state.quizRound;
  const gone = () => round !== state.quizRound; // you left this class while it was being graded
  set({ screen: 'grading', busy: '' });
  (async () => {
    try {
      await getQuiz('class');
      await checkedQuiz('class');
      if (gone()) return;
      // Send the questions without the correct answers, so the classmates cannot peek.
      const questions = state.quiz.classQuiz.map(({ id, question, options }) => ({ id, question, options }));
      const read = readAloudText().length > 0;
      const recalled = state.log.filter((l) => l.said && l.recalled).map((l) => l.said).join('\n');
      const { answers } = await ask(
        'exam',
        {
          questions,
          transcript: transcript(),
          ownTranscript: read ? transcript({ own: true }) : undefined,
          recalledTranscript: recalled,
          material: quizMaterial(),
          beliefs: heldBeliefs(),
        },
        { stale: gone }
      );
      if (gone()) return;
      // A quote must be real (checked above) AND actually teach the picked answer.
      // If this check fails, the answers are used as they are rather than blocking you.
      let verified = answers;
      state.verifyFailed = false;
      try {
        const check = await ask('verifyAnswers', { questions, answers }, { stale: gone });
        verified = check.answers;
        if (check.unchecked) state.verifyFailed = true; // some answers were not checked
      } catch (err) {
        console.warn('Answer check skipped:', err.message);
        state.verifyFailed = true;
      }
      if (gone()) return;
      // A wrong idea can never earn a point: if one somehow led to the right option, it counts as blank.
      verified = verified.map((a) => {
        const q = state.quiz.classQuiz.find((x) => x.id === a.id);
        return a.fromBelief && q && a.choice === q.answer ? { ...a, choice: null, quote: '', fromBelief: false, because: 'You never taught this clearly enough to answer.' } : a;
      });
      recordAttempt(verified);
      set({ examAnswers: verified, screen: 'results', busy: '' });
      // Write and check your own quiz while you read the results.
      if (!state.quiz?.selfChecked) checkedQuiz('self').catch(() => {});
    } catch (err) {
      if (gone()) return;
      state.log = beforeRestore; // back to the class exactly as you left it
      state.screen = 'present';
      showError(err.message, endClass);
    }
  })();
}

// Wrong ideas classmates voiced in this class that you never corrected. They still believe
// them when they take the quiz.
function heldBeliefs() {
  const held = [];
  for (const l of state.log) {
    for (const m of l.misconceptions || []) if (!m.corrected) held.push({ id: m.id, student: m.student, belief: m.belief, slide: l.n });
  }
  return held;
}

// The same, minus the ones being discussed on this slide right now (those are raised hands,
// sent separately). You can correct any of them on any slide.
function heldElsewhere(log) {
  return heldBeliefs().filter((b) => !(b.slide === log.n && log.beliefs?.[b.student] === b.belief));
}

function classScore(answers = state.examAnswers) {
  const qs = state.quiz?.classQuiz || [];
  if (!qs.length) return { pct: 0, perStudent: {} };
  const perStudent = {};
  for (const s of STUDENT_IDS) {
    const right = qs.filter((q) => answers.find((a) => a.id === q.id && a.student === s)?.choice === q.answer).length;
    perStudent[s] = right;
  }
  const total = Object.values(perStudent).reduce((a, b) => a + b, 0);
  return { pct: Math.round((total / (qs.length * STUDENT_IDS.length)) * 100), perStudent };
}

function selfScore() {
  const qs = state.quiz?.selfQuiz || [];
  if (!state.selfSubmitted || !qs.length) return null;
  const right = qs.filter((q) => state.selfAnswers[q.id] === q.answer).length;
  return { right, total: qs.length, pct: Math.round((right / qs.length) * 100) };
}

function buildReport() {
  const classResults = state.quiz.classQuiz.map((q) => ({
    question: q.question,
    correctAnswer: q.options[q.answer],
    concept: q.concept,
    slide: q.slide,
    // One short line per classmate keeps the report request small (and so faster).
    students: STUDENT_IDS.map((s) => {
      const a = state.examAnswers.find((x) => x.id === q.id && x.student === s);
      const name = STUDENTS[s].name;
      if (a?.choice === q.answer) return `${name}: right`;
      if (a?.fromSlide) return `${name}: blank (only had slide text you read out)`;
      if (a?.fromBelief) return `${name}: wrong (kept an uncorrected wrong idea)`;
      if (a && a.choice !== null) return `${name}: wrong, picked "${q.options[a.choice]}" from your words "${a.quote}"`;
      return `${name}: blank (never taught clearly)`;
    }),
  }));
  const selfResults = state.selfSubmitted
    ? state.quiz.selfQuiz.map((q) => ({
        question: q.question,
        correctAnswer: q.options[q.answer],
        yourAnswer: state.selfAnswers[q.id] === undefined ? 'left blank' : q.options[state.selfAnswers[q.id]],
        correct: state.selfAnswers[q.id] === q.answer,
        yourWhy: state.selfReasons[q.id] || '',
        slide: q.slide,
      }))
    : null;

  set({ screen: 'report', report: null });
  // Only the newest report counts: asking again (for example after taking your quiz) drops
  // one that is still being written, and so does leaving this class.
  const token = ++reportToken;
  const replaced = () => token !== reportToken;
  run(
    'Writing your learning report…',
    async (gone) => {
      const report = await ask('report', { material: quizMaterial(), history: history(), classResults, selfResults }, { stale: gone });
      if (!gone()) state.report = report;
    },
    undefined,
    replaced
  );
}
let reportToken = 0;

// Skipping your quiz unlocks the class answers (they no longer spoil anything) and writes the report.
function skipSelfQuiz() {
  state.selfSkipped = true;
  state.selfParked = true;
  buildReport();
}

function openSelfQuiz() {
  state.selfParked = false;
  if (state.screen !== 'selfquiz') state.selfFrom = state.screen; // where "Back" and errors return to
  set({ screen: 'selfquiz' });
  nudge(); // if it is still being prepared, it goes first now
}

function backToReport() {
  if (state.report || state.busy) set({ screen: 'report' }); // written already, or still being written
  else buildReport();
}

function presentAgain() {
  startClass(state.fileName, state.slides, { again: true });
}

function startOver() {
  dictation.stop();
  recorder.cancel();
  state.quizRound++; // anything still being prepared for this class is dropped
  dropStale();
  set({ screen: 'start', slides: [], log: [], fileName: '', error: null, learnChosen: false }); // a new topic: choose again
}

// ---------------- rendering ----------------

function render() {
  const screens = { start: Start, loading: Loading, present: Present, grading: Loading, results: Results, selfquiz: SelfQuiz, report: Report };
  const focus = focusKey(document.activeElement);
  const entering = state.screen !== lastScreen;
  lastScreen = state.screen;
  const view = (screens[state.screen] || Start)();
  // Entrance motion only when you arrive on a screen, never on every redraw.
  if (entering) view.classList.add('enter');
  app.replaceChildren(ErrorBar(), view);
  pageTurned = null;
  if (state.screen === 'present' && slideLog()) slideLog().seen = slideLog().feed.length; // shown now: no longer new
  if (entering) countUp();
  restoreFocus(focus);
  updateMicButton();
  applyTurnEffects();
}

let lastScreen = null;

// Scores count up from 0 when a results screen opens (numbers marked with data-count).
function countUp() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of app.querySelectorAll('[data-count]')) {
    const target = Number(el.dataset.count);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 900);
      el.textContent = `${Math.round(target * (1 - Math.pow(1 - t, 3)))}%`;
      if (t < 1) requestAnimationFrame(step);
    };
    el.textContent = '0%';
    requestAnimationFrame(step);
  }
}

// One item at a time (a question, a report section), with Back / Next and a dot for each,
// so a long list fits on one screen without scrolling.
let pageTurned = null;
function pageIndex(key, n) {
  return Math.min(Math.max(0, state.pages[key] || 0), Math.max(0, n - 1));
}
function goPage(key, i) {
  state.pages[key] = i;
  pageTurned = key;
  render();
}
function Pager(key, items, { dot = () => '', label = (i) => `Question ${i + 1}` } = {}) {
  const n = items.length;
  const cur = pageIndex(key, n);
  return h(
    'div',
    { class: 'pager' },
    h(
      'div',
      { class: 'pager-items' },
      items.map((item, i) => h('div', { class: `pager-item${pageTurned === key && i === cur ? ' is-turned' : ''}`, hidden: i !== cur }, item))
    ),
    n > 1 &&
      h(
        'nav',
        { class: 'pager-nav', 'aria-label': 'Questions' },
        h('button', { type: 'button', class: 'btn btn-quiet btn-small', disabled: cur === 0, onclick: () => goPage(key, cur - 1) }, '← Back'),
        h(
          'ol',
          { class: 'pager-dots' },
          items.map((_, i) =>
            h('li', {}, h('button', { type: 'button', class: `dot${i === cur ? ' is-current' : ''}${dot(i)}`, 'aria-label': label(i), 'aria-current': i === cur ? 'step' : null, onclick: () => goPage(key, i) }))
          )
        ),
        h('button', { type: 'button', class: 'btn btn-quiet btn-small', disabled: cur === n - 1, onclick: () => goPage(key, cur + 1) }, 'Next →')
      )
  );
}

// The page is redrawn on every change. Keyboard and screen-reader users would lose their place,
// so the control that had focus gets it back (found again by its id, or its kind and label).
function focusKey(el) {
  if (!el || el === document.body || !app.contains(el)) return null;
  const key = el.id ? `#${el.id}` : `${el.tagName}|${el.name || ''}|${el.type === 'radio' ? el.value : ''}|${(el.textContent || '').trim().slice(0, 60)}`;
  const text = 'selectionStart' in el && typeof el.value === 'string' ? { start: el.selectionStart, end: el.selectionEnd } : null;
  return { key, text };
}

function restoreFocus(focus) {
  if (!focus || (document.activeElement && document.activeElement !== document.body)) return;
  const all = app.querySelectorAll('button, input, textarea, select, a[href], summary, [tabindex]');
  const el = [...all].find((x) => focusKey(x)?.key === focus.key);
  if (!el || el.disabled) return;
  el.focus({ preventScroll: true });
  if (focus.text && 'setSelectionRange' in el) {
    try {
      el.setSelectionRange(focus.text.start, focus.text.end);
    } catch {
      /* not a text field */
    }
  }
}

function ErrorBar() {
  if (!state.error) return h('div', { id: 'error', hidden: true });
  const { message, retry } = state.error;
  return h(
    'div',
    { id: 'error', class: 'error-bar', role: 'alert' },
    h('p', {}, message),
    h(
      'div',
      { class: 'error-actions' },
      retry && h('button', { class: 'btn btn-small', onclick: () => { state.error = null; retry(); } }, 'Try again'),
      h('button', { class: 'btn btn-small btn-quiet', onclick: () => set({ error: null }) }, 'Dismiss')
    )
  );
}

const MOOD_FACES = { confused: '?', unsure: '~', following: '✓', slide: '¶' };

function Avatar(id, { size = 'md', raised = false, mood = null } = {}) {
  const s = STUDENTS[id];
  return h(
    'span',
    { class: `avatar avatar-${size}${raised ? ' is-raised' : ''}`, style: { '--c': s.color }, 'aria-hidden': 'true' },
    h('span', { class: 'face', html: FACES[id] }),
    raised && h('span', { class: 'hand', html: ICONS.hand }),
    mood && h('span', { class: `mood mood-${mood}` }, MOOD_FACES[mood])
  );
}

function Start() {
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf,.ppt,.pptx',
    id: 'file',
    class: 'visually-hidden',
    disabled: !state.learnChosen,
    onchange: (e) => e.target.files[0] && openFile(e.target.files[0]),
  });
  const drop = h(
    'label',
    {
      for: 'file',
      class: 'dropzone',
      ondragover: (e) => {
        e.preventDefault();
        e.currentTarget.classList.add('is-over');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('is-over'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('is-over');
        if (!state.learnChosen) return showError('First choose whether you are new to this topic or already know it.');
        const file = e.dataTransfer.files[0];
        if (file) openFile(file);
      },
    },
    h('strong', {}, 'Upload your slides'),
    h('span', {}, 'PDF only. Saving from PowerPoint or Google Slides? Export as PDF first.')
  );

  return h(
    'main',
    { class: 'start' },
    h(
      'section',
      { class: 'start-hero' },
      h('p', { class: 'brand' }, 'TeachBack'),
      h('h1', { class: 'word-reveal', 'aria-label': 'Learn it by teaching it.' }, 'Learn it by teaching it.'.split(' ').map((w, i) => [h('span', { class: 'word', style: { '--i': i }, 'aria-hidden': 'true' }, w), ' '])),
      h(
        'p',
        { class: 'lede' },
        'Present your slides out loud to four AI classmates. They ask the questions you did not think of, take a quiz on what you taught, and show you exactly what you still need to learn.'
      ),
      // First choice: how well do you know this topic? It decides whether each slide opens on a study card.
      h(
        'fieldset',
        { class: 'topic-choice' },
        h('legend', {}, 'How well do you know this topic?'),
        h(
          'div',
          { class: 'choice-cards' },
          ChoiceCard('new', 'I’m new to this', 'Read a short study card before you explain each slide.'),
          ChoiceCard('know', 'I already know it', 'Go straight to explaining each slide.')
        )
      ),
      h(
        'div',
        { class: `start-actions${state.learnChosen ? '' : ' is-waiting'}` },
        fileInput,
        drop,
        h('button', { class: 'btn btn-quiet', disabled: !state.learnChosen, onclick: () => startClass(SAMPLE.fileName, SAMPLE.slides) }, 'Try a sample lesson on photosynthesis')
      ),
      !state.learnChosen && h('p', { class: 'hint choose-first' }, 'Choose one above to start.'),
      h('p', { class: 'fine' }, 'Your PDF stays on this device. Slide text and what you say are sent to the AI to run the class, and are not stored.'),
      state.voiceMode === 'none' && h('p', { class: 'hint' }, 'Voice input is not available in this browser. You can type instead.')
    ),
    h(
      'section',
      { class: 'start-class', 'aria-label': 'Your classmates' },
      h(
        'div',
        { class: 'chalkboard', 'aria-hidden': 'true' },
        h('p', { class: 'chalk-small' }, 'Today’s teacher:'),
        h('p', { class: 'chalk-big' }, 'You'),
        h('span', { class: 'chalk-line', html: '<svg viewBox="0 0 120 12"><path d="M3 8c20-5 40-6 60-3s38 2 54-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>' }),
        h('span', { class: 'chalk-doodle', html: CHALK_DOODLE })
      ),
      h('h2', {}, 'Meet your class'),
      // The four classmates at their desks. Their questions pop up one at a time, on a loop.
      h(
        'ul',
        { class: 'start-desks' },
        [
          ['mika', 'Wait, why do plants need light?'],
          ['rafa', 'How do you know that?'],
          ['iya', 'What if the sun went out?'],
          ['dev', 'Is that like how we get energy?'],
        ].map(([id, text], i) =>
          h(
            'li',
            { class: 'seat', style: { '--i': i, '--c': STUDENTS[id].color } },
            h('p', { class: 'seat-bubble', 'aria-hidden': 'true' }, text),
            Avatar(id, { size: 'lg' }),
            h('span', { class: 'desk-top', 'aria-hidden': 'true' }),
            h('strong', {}, STUDENTS[id].name),
            h('span', { class: 'seat-role' }, STUDENTS[id].role)
          )
        )
      )
    )
  );
}

const CHALK_DOODLE =
  '<svg viewBox="0 0 160 90" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="28" cy="26" r="12"/><path d="M28 6v-4M28 50v-4M8 26H4M52 26h-4M14 12l-3-3M42 12l3-3M14 40l-3 3M42 40l3 3"/>' +
  '<path d="M70 30c10-8 22-8 30 0"/><path d="M96 24l4 6-7 2"/>' +
  '<path d="M118 62c0-14 8-22 16-22s16 8 16 22M134 62V82M126 72l8-6 8 6"/>' +
  '<path d="M64 70h20M74 60v20"/></svg>';

// The class hard at work: each classmate at a desk, writing.
function WritingClass(size = 'lg') {
  return h(
    'div',
    { class: `loading-class loading-class-${size}`, 'aria-hidden': 'true' },
    STUDENT_IDS.map((id, i) =>
      h('div', { class: 'seat', style: { '--i': i } }, Avatar(id, { size }), h('span', { class: 'desk-top' }, h('span', { class: 'paper' }, h('i'), h('i'), h('i')), h('span', { class: 'pencil' })))
    )
  );
}

function ChoiceCard(value, title, text) {
  const selected = state.learnChosen && state.learnFirst === (value === 'new');
  return h(
    'label',
    { class: `choice-card${selected ? ' is-selected' : ''}` },
    h('input', {
      type: 'radio',
      name: 'topic',
      value,
      checked: selected,
      onchange: () => set({ learnChosen: true, learnFirst: value === 'new' }),
    }),
    h('strong', {}, title),
    h('span', {}, text)
  );
}

function Loading() {
  const grading = state.screen === 'grading';
  return h(
    'main',
    { class: 'loading' },
    WritingClass(),
    h('p', { id: 'busy-text', role: 'status' }, grading ? 'Your classmates are taking the quiz…' : state.busy || 'Working…'),
    grading && h('p', { class: 'hint' }, 'This can take a minute or two.')
  );
}

const STEPS = ['Teach', 'Class quiz', 'Your quiz', 'Report'];
const STEP_OF = { present: 0, grading: 1, results: 1, selfquiz: 2, report: 3 };

// Where you are in the session: teach, class quiz, your quiz, report.
function Steps() {
  const at = STEP_OF[state.screen] ?? 0;
  return h(
    'ol',
    { class: 'steps', 'aria-label': 'Steps' },
    STEPS.map((label, i) =>
      h('li', { class: i < at ? 'is-done' : i === at ? 'is-now' : '', 'aria-current': i === at ? 'step' : null }, h('span', { class: 'step-n' }, String(i + 1).padStart(2, '0')), h('span', { class: 'step-label' }, label))
    )
  );
}

// A score as a ring that fills up, with the number in the middle.
function Ring(pct, { size = 'lg', label = '' } = {}) {
  const tone = pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'low';
  return h(
    'div',
    { class: `ring ring-${size} ring-${tone}`, role: 'img', 'aria-label': `${label} ${pct}%`.trim() },
    h('span', { class: 'ring-svg', html: `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52" pathLength="100"/><circle class="ring-fill" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${Math.max(0.01, pct)} 100"/></svg>` }),
    h('span', { class: size === 'lg' ? 'score-big' : 'score-mid', 'data-count': pct, 'aria-hidden': 'true' }, `${pct}%`)
  );
}

function Header(extra) {
  return h(
    'header',
    { class: 'topbar' },
    h('button', { class: 'brand brand-button', onclick: () => confirm('Leave this class? Your progress will be lost.') && startOver() }, 'TeachBack'),
    h('span', { class: 'topbar-file' }, state.fileName),
    Steps(),
    extra
  );
}

function Present() {
  const slide = state.slides[state.current];
  const log = slideLog();
  const isLast = state.pos === state.order.length - 1;
  const recording = state.voiceMode === 'record' && state.listening;
  const busy = Boolean(state.busy);
  const writing = state.voiceMode === 'record' && voice.pending > 0;
  const locked = busy || recording || writing;
  const openIds = STUDENT_IDS.filter((id) => log.open[id]);
  const calledOn = state.callOn && log.open[state.callOn] ? state.callOn : null;

  // "Present from memory": only the slide's title shows while you explain. Explaining without
  // notes makes you recall the ideas yourself, which is one of the best ways to learn them.
  // Also after a study card: you explain from memory, with the slide hidden.
  const hidden = (state.fromMemory || log.studyDone) && !log.peek && log.phase === 'explain' && !log.studying;
  const board = h(
    'figure',
    { class: `board${hidden ? ' is-hidden' : ''}` },
    hidden
      ? h(
          'div',
          { class: 'text-slide memory-slide' },
          h('h2', {}, slide.title || `Slide ${slide.n}`),
          h('p', {}, 'The slide is hidden. Explain it from memory, in your own words.'),
          h(
            'div',
            { class: 'controls' },
            h('button', { class: 'btn btn-small btn-quiet', onclick: () => ((log.peek = true), render()), disabled: locked }, 'Peek at the slide'),
            log.studyDone && h('button', { class: 'btn btn-small btn-quiet', onclick: studySlide, disabled: locked }, 'See the study card again')
          )
        )
      : slide.image
        ? h('img', { src: slide.image, alt: `Slide ${slide.n}: ${slide.text.slice(0, 140)}` })
        : h('div', { class: 'text-slide' }, h('h2', {}, slide.title || `Slide ${slide.n}`), slide.text.split('\n').slice(1).map((line) => h('p', {}, line))),
    h(
      'figcaption',
      {},
      h('span', {}, state.mode === 'reteach' ? `Slide ${slide.n} · re-teaching ${state.pos + 1} of ${state.order.length}` : `Slide ${slide.n} of ${state.slides.length}`),
      h(
        'label',
        { class: 'memory-toggle' },
        h('input', { type: 'checkbox', checked: state.fromMemory, onchange: (e) => set({ fromMemory: e.target.checked }) }),
        h('span', {}, 'Present from memory')
      )
    )
  );

  let prompt;
  if (log.phase === 'explain') {
    prompt =
      state.mode === 'reteach'
        ? h(
            'div',
            { class: 'prompt-block' },
            h('p', { class: 'prompt' }, 'Explain this slide again, more clearly this time.'),
            log.focus?.concepts?.length && h('p', { class: 'reteach-focus' }, h('strong', {}, 'Last time your class missed: '), log.focus.concepts.join(', ')),
            log.focus?.self?.length && h('p', { class: 'reteach-focus' }, h('strong', {}, 'In your own quiz you missed: '), log.focus.self.join(', ')),
            (log.focus?.notes || []).map((n) => h('p', { class: 'reteach-focus' }, n)),
            !log.focus?.concepts?.length && !log.focus?.notes?.length && !log.focus?.self?.length && h('p', { class: 'reteach-focus' }, 'Last time your class left with questions on this slide.')
          )
        : h('p', { class: 'prompt' }, log.studyDone ? 'Now explain it to the class in your own words, without the card.' : 'Explain this slide to the class in your own words.');
  } else if (log.phase === 'qa') {
    prompt = h(
      'div',
      { class: 'prompt-block' },
      calledOn
        ? h(
            'p',
            { class: 'prompt' },
            Avatar(calledOn, { size: 'sm' }),
            h('span', {}, h('strong', {}, `You called on ${STUDENTS[calledOn].name}: `), log.open[calledOn])
          )
        : h('p', { class: 'prompt' }, `${openIds.length > 1 ? `${openIds.length} hands are up` : '1 hand is up'}. Answer the class, or call on someone.`),
      h(
        'ul',
        { class: 'open-questions', 'aria-label': 'Raised hands' },
        openIds.map((id) =>
          h(
            'li',
            {},
            h(
              'button',
              {
                class: `open-q${calledOn === id ? ' is-called' : ''}`,
                onclick: () => toggleCallOn(id),
                disabled: locked,
                'aria-pressed': String(calledOn === id),
              },
              Avatar(id, { size: 'sm' }),
              h('span', {}, h('strong', {}, `${STUDENTS[id].name}: `), log.open[id]),
              h('span', { class: 'open-q-action' }, calledOn === id ? 'Called on' : 'Call on')
            )
          )
        )
      ),
      h('p', { class: 'queue-note' }, calledOn ? `Only ${STUDENTS[calledOn].name} is answering, but everyone hears you.` : 'Your answer goes to everyone with a hand up. Answer several questions at once if you like.')
    );
  } else {
    const waiting = Object.keys(log.open || {}).length;
    prompt = h(
      'p',
      { class: 'prompt' },
      isLast
        ? 'That was the last slide. End the class to see how much they learned from you.'
        : waiting
          ? 'Time to move on. Questions still open will show in your report.'
          : 'All hands are down. Move on when you are ready.'
    );
  }

  const canType = log.phase !== 'done';
  const draft = h('textarea', {
    id: 'draft',
    rows: 3,
    placeholder:
      state.voiceMode === 'live'
        ? 'Press Talk and start speaking. Your words appear here, and you can fix them.'
        : state.voiceMode === 'record'
          ? 'Press Talk and speak. Each phrase appears here when you pause, and you can fix words after.'
          : 'Type what you would say out loud.',
    disabled: !canType || busy,
    readonly: recording || writing, // words are arriving; you can fix them after
    'aria-label': log.phase === 'qa' ? 'Your answer' : 'Your explanation',
    oninput: (e) => {
      state.draft = e.target.value;
      noteWriting();
    },
  });
  draft.value = state.draft;

  const controls = h(
    'div',
    { class: 'controls' },
    canType &&
      state.voiceMode !== 'none' &&
      h('button', { id: 'mic', class: 'btn btn-mic', onclick: toggleMic, disabled: busy || (writing && !recording), 'aria-pressed': 'false' }),
    log.phase === 'explain' && h('button', { class: 'btn btn-primary', onclick: finishExplaining, disabled: locked }, 'Done explaining'),
    log.phase === 'explain' && h('button', { class: 'btn btn-quiet', onclick: skipSlide, disabled: locked }, isLast ? 'Skip it and end the class' : 'Skip this slide'),
    log.phase === 'qa' &&
      h('button', { class: 'btn btn-primary', onclick: sendAnswer, disabled: locked }, calledOn ? `Answer ${STUDENTS[calledOn].name}` : 'Answer the class'),
    log.phase !== 'explain' &&
      h(
        'button',
        { class: log.phase === 'done' ? 'btn btn-primary' : 'btn btn-quiet', onclick: nextSlide, disabled: locked },
        isLast ? 'End class and start the quiz' : log.phase === 'qa' ? 'Move on anyway' : 'Next slide'
      )
  );

  const feed = h(
    'ol',
    { class: 'feed' },
    log.feed.length === 0 && h('li', { class: 'feed-empty' }, 'Your classmates are listening.'),
    log.feed.map((m, i) => {
      const fresh = i >= (log.seen ?? 0) ? ' is-new' : ''; // pops in once, when it arrives
      if (m.from === 'note') return h('li', { class: `msg msg-note${fresh}` }, m.text);
      if (m.from === 'you') {
        const label = m.kind === 'answer' ? (m.to ? `You, to ${STUDENTS[m.to].name}` : 'You, to the class') : 'You';
        return h('li', { class: `msg msg-you${fresh}` }, h('span', { class: 'msg-who' }, label), h('p', {}, m.text));
      }
      const s = STUDENTS[m.student];
      return h(
        'li',
        { class: `msg msg-student${m.question ? ' is-question' : ''}${fresh}`, style: { '--c': s.color, '--d': `${Math.max(0, i - (log.seen ?? 0)) * 0.12}s` } },
        Avatar(m.student, { size: 'sm' }),
        h('div', {}, h('span', { class: 'msg-who' }, s.name), h('p', {}, m.text))
      );
    }),
    busy && h('li', { class: 'msg msg-note', role: 'status' }, state.busy)
  );

  const desks = h(
    'ul',
    { class: 'desks' },
    STUDENT_IDS.map((id) => {
      const raised = Boolean(log.open[id]);
      const mood = log.moods[id];
      const content = [
        Avatar(id, { raised, mood }),
        h('span', { class: 'desk-name' }, STUDENTS[id].name),
        h('span', { class: 'desk-mood' }, mood ? MOOD_LABELS[mood] : ' '),
      ];
      return h(
        'li',
        {},
        raised && log.phase === 'qa'
          ? h(
              'button',
              {
                class: `desk desk-button${calledOn === id ? ' is-called' : ''}`,
                onclick: () => toggleCallOn(id),
                disabled: locked,
                title: `Call on ${STUDENTS[id].name}`,
                'aria-label': `Call on ${STUDENTS[id].name}${mood ? `, ${MOOD_LABELS[mood].toLowerCase()}` : ''}`,
              },
              content
            )
          : h('div', { class: 'desk', role: 'group', 'aria-label': `${STUDENTS[id].name}${mood ? `, ${MOOD_LABELS[mood].toLowerCase()}` : ''}` }, content)
      );
    })
  );

  const progress = h(
    'ol',
    { class: 'progress', 'aria-label': 'Slides' },
    state.slides.map((s, i) => {
      const inPlan = state.order.includes(i);
      const pos = state.order.indexOf(i);
      const cls = !inPlan || state.log[i]?.skipped ? 'is-skipped' : pos < state.pos ? 'is-done' : pos === state.pos ? 'is-current' : '';
      return h('li', { class: cls, 'aria-current': i === state.current ? 'step' : null }, h('span', { class: 'visually-hidden' }, `Slide ${s.n}${inPlan ? '' : ' (not re-taught)'}`));
    })
  );

  return h(
    'div',
    { class: 'present' },
    Header([state.mode === 'reteach' && h('span', { class: 'mode-tag' }, `Re-teaching ${state.order.length} weak slide${state.order.length > 1 ? 's' : ''}`), progress]),
    h(
      'main',
      { class: 'present-grid' },
      h(
        'section',
        { class: 'stage' },
        board,
        h(
          'div',
          { class: 'speak' },
          log.studying && log.phase === 'explain'
            ? StudyCard(log)
            : [
                // Not sure about this slide? A study card first, any time before you explain it.
                log.phase === 'explain' &&
                  !log.studyDone &&
                  !busy &&
                  h(
                    'div',
                    { class: 'study-offer' },
                    h('div', {}, h('strong', {}, 'New to this slide?'), h('span', {}, 'Read a short study card before you explain it.')),
                    h('button', { class: 'btn btn-study', onclick: studySlide, disabled: locked }, 'Study this slide first')
                  ),
                prompt,
                canType && draft,
                canType && h('p', { id: 'voice-status', class: 'voice-status', role: 'status' }, voiceStatusText()),
                controls,
                // New to this slide? A study card first, any time before you explain it.

                !isLast && presentedSomething() && !busy && h('button', { class: 'link-button end-now', onclick: endClassNow, disabled: locked }, 'End the class now'),
              ]
        )
      ),
      h('aside', { class: `classroom${log.feed.length > (log.seen ?? 0) ? ' is-fresh' : ''}`, 'aria-label': 'Your classmates' }, desks, feed)
    )
  );
}

function updateMicButton() {
  const btn = document.getElementById('mic');
  if (!btn) return;
  btn.innerHTML = '';
  const secs = state.recordSecs;
  const clock = state.voiceMode === 'record' && state.listening ? ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '';
  btn.append(h('span', { class: 'icon', html: state.listening ? ICONS.stop : ICONS.mic }), (state.listening ? 'Stop' : 'Talk') + clock);
  if (state.voiceMode === 'record' && state.listening) {
    btn.append(h('span', { id: 'meter', class: 'meter', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i')));
  }
  btn.classList.toggle('is-live', state.listening);
  btn.setAttribute('aria-pressed', String(state.listening));
}

// The correct answers stay hidden until you take (or skip) your own quiz. Your quiz covers
// the same ideas, so seeing the answers first would make your own score look better than
// your real understanding.
const answersRevealed = () => state.selfSubmitted || state.selfSkipped;

function Results() {
  const { pct, perStudent } = classScore();
  const qs = state.quiz.classQuiz;
  const revealed = answersRevealed();

  return h(
    'div',
    { class: 'page' },
    Header(),
    h(
      'main',
      { class: 'results split' },
      h(
        'aside',
        { class: 'split-aside' },
      h(
        'section',
        { class: 'score-hero' },
        h('p', { class: 'score-label' }, state.attempts.length < 2 ? 'Your class scored' : state.attempts.at(-1).mode === 'reteach' ? 'After re-teaching, your class scored' : 'This time, your class scored'),
        Ring(pct, { label: 'Your class scored' }),
        ScoreHistory(),
        h(
          'p',
          { class: 'lede' },
          'A blank means you never taught it clearly. A wrong answer means you taught it wrong.'
        ),
        // Per-classmate scores could hint at answers, so they appear with the answers.
        revealed &&
          h(
            'ul',
            { class: 'scoreboard' },
            STUDENT_IDS.map((id) => h('li', {}, Avatar(id), h('span', {}, STUDENTS[id].name), h('strong', {}, `${perStudent[id]}/${qs.length}`)))
          ),
        skippedSlides().length > 0 &&
          h('p', { class: 'hint' }, `You skipped slide${skippedSlides().length > 1 ? 's' : ''} ${skippedSlides().join(', ')}, so ${skippedSlides().length > 1 ? 'they were' : 'it was'} left out of the quiz.`)
      ),
      NextStep(revealed)
      ),
      h(
        'section',
        { class: 'questions split-main' },
        h('h2', {}, 'How they answered'),
        !revealed &&
          h(
            'p',
            { class: 'answers-hidden' },
            'The correct answers appear after you take your own quiz.'
          ),
        (state.quiz.classCheckFailed || state.verifyFailed) &&
          h(
            'p',
            { class: 'hint check-skipped' },
            'Some results could not be double-checked this time, so the score may be slightly off.'
          ),
        Pager('results', qs.map((q, i) => QuestionResult(q, i, revealed)), {
          // After the reveal, each dot shows how the class did on that question.
          dot: (i) => {
            if (!revealed) return '';
            const right = state.examAnswers.filter((a) => a.id === qs[i].id && a.choice === qs[i].answer).length;
            return right === STUDENT_IDS.length ? ' is-right' : right === 0 ? ' is-wrong' : ' is-part';
          },
        })
      )
    )
  );
}

function NextStep(revealed) {
  return revealed
        ? h(
            'section',
            { class: 'next-step' },
            h('h2', {}, 'What next?'),
            h(
              'div',
              { class: 'next-actions' },
              h('button', { class: 'btn btn-primary', onclick: backToReport }, 'Back to my learning report'),
              weakSlides().length > 0 && h('button', { class: 'link-button', onclick: startReteach, disabled: Boolean(state.busy) }, 'Re-teach my weak slides now')
            )
          )
        : h(
            'section',
            { class: 'next-step' },
            h('h2', {}, 'Now check yourself'),
            h('p', {}, 'Five new questions to check your own understanding. About two minutes.'),
            h(
              'div',
              { class: 'next-actions' },
              h('button', { class: 'btn btn-primary', onclick: openSelfQuiz }, 'Take my quiz'),
              h('button', { class: 'link-button', onclick: skipSelfQuiz }, 'Skip to my learning report')
            )
          );
}

// Before and after: every class result so far, so you can see whether re-teaching worked.
// Before and after, comparing like with like:
// - after a re-teach: only the slides you re-taught, against the last attempt that had
//   questions on those slides;
// - after presenting everything again: the whole class, against the last full class.
function ScoreHistory() {
  const a = state.attempts;
  if (a.length < 2) return null;
  const latest = a[a.length - 1];
  const earlier = a.slice(0, -1).reverse();
  let prev;
  let now;
  let scope;
  if (latest.mode === 'reteach') {
    // Only re-taught slides that BOTH quizzes asked about, so the two numbers cover the same slides.
    const common = (x) => latest.slides.filter((n) => x.bySlide?.[n]?.total && latest.bySlide?.[n]?.total);
    const match = earlier.find((x) => common(x).length);
    const slides = match ? common(match) : [];
    now = slides.length ? slideScore(latest, slides) : null;
    prev = slides.length ? slideScore(match, slides) : null;
    scope = `On the re-taught slide${slides.length > 1 ? 's' : ''} both quizzes asked about (${slides.join(', ')})`;
  } else {
    const match = earlier.find((x) => x.mode === 'full');
    now = { pct: latest.pct, total: latest.total };
    prev = match && { pct: match.pct, total: match.total };
    scope = 'The whole class';
  }
  const list = h(
    'ol',
    { class: 'attempts', 'aria-label': 'Your class scores so far' },
    a.map((x, i) => h('li', { class: i === a.length - 1 ? 'is-latest' : '' }, h('strong', {}, `${x.pct}%`), h('span', {}, i === 0 ? 'First try' : x.mode === 'reteach' ? `Re-taught slide${x.slides.length > 1 ? 's' : ''} ${x.slides.join(', ')}` : 'Full class again')))
  );
  if (!now || !prev) {
    return h('div', { class: 'score-history' }, list, h('p', { class: 'fair-compare' }, 'There is no earlier quiz on the same slides to compare with yet.'));
  }
  const diff = now.pct - prev.pct;
  // Each question is answered by 4 classmates.
  const questions = (x) => Math.round((x.total || 0) / STUDENT_IDS.length);
  const few = questions(prev) < 2 || questions(now) < 2;
  const message =
    now.pct === 100 && diff > 0
      ? `Up ${diff} points. Your class got every question from your words.`
      : diff > 0
        ? `Up ${diff} points. ${latest.mode === 'reteach' ? 'Re-teaching closed some gaps.' : 'Your explanations got clearer.'}`
        : diff === 0
          ? 'The same as before. Try a different way to explain it: an example, an analogy, or the steps in order.'
          : `Down ${-diff} points. Something that was clear before got muddled; check the answers below.`;
  return h(
    'div',
    { class: `score-history ${diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : ''}` },
    list,
    h('p', { class: 'fair-compare' }, h('strong', {}, `${scope}: ${prev.pct}% → ${now.pct}%`), ` (${questions(prev)} question${questions(prev) === 1 ? '' : 's'} before, ${questions(now)} now)`),
    h('p', {}, message),
    few && h('p', { class: 'fresh-note' }, 'This is based on very few questions, so treat it as a rough sign, not a final score.'),
    null
  );
}

function ReteachButton({ primary = false, disabled = false } = {}) {
  const weak = weakSlides();
  if (!weak.length) return h('p', { class: 'hint' }, 'Your class answered everything correctly. Nothing to re-teach.');
  return h(
    'button',
    { class: primary ? 'btn btn-primary' : 'btn btn-quiet', onclick: startReteach, disabled },
    `Re-teach my weak slides (${weak.map((i) => i + 1).join(', ')})`
  );
}

function QuestionResult(q, i, revealed = true) {
  const answers = STUDENT_IDS.map((s) => ({ s, a: state.examAnswers.find((x) => x.id === q.id && x.student === s) }));
  const blank = (a) => a?.choice === null || a?.choice === undefined;
  const right = answers.filter(({ a }) => a?.choice === q.answer);
  const missed = answers.filter(({ a }) => a?.choice !== q.answer);
  // Before your quiz every blank gets the same reason: some reasons quote words that point to the answer.
  const blankReason = (a) => (revealed && a?.because) || 'You never taught this clearly enough to answer.';
  // Before your own quiz, nothing here may hint at the correct option: no right/wrong marks,
  // no picked options, and no quotes behind answers. Only who answered and who left it blank.
  const chip = ({ s, a }) => {
    if (!revealed) return h('li', { class: 'chip is-neutral' }, Avatar(s, { size: 'sm' }), `${STUDENTS[s].name} ${blank(a) ? 'left it blank' : 'answered'}`);
    const ok = a?.choice === q.answer;
    const label = blank(a) ? (a?.fromSlide ? 'only had the slide' : 'left it blank') : ok ? 'got it right' : `picked “${q.options[a.choice]}”`;
    return h('li', { class: ok ? 'chip is-right' : 'chip is-wrong' }, Avatar(s, { size: 'sm' }), `${STUDENTS[s].name} ${label}`);
  };
  const reasons = revealed ? missed : answers.filter(({ a }) => blank(a));
  return h(
    'article',
    { class: 'qcard' },
    h('h3', {}, `${i + 1}. ${q.question}`),
    revealed
      ? h('p', { class: 'qcard-answer' }, 'Correct answer: ', h('strong', {}, q.options[q.answer]), q.slide ? ` (slide ${q.slide})` : '')
      : q.slide && h('p', { class: 'qcard-answer' }, `From slide ${q.slide}`),
    h('ul', { class: 'chips' }, answers.map(chip)),
    h(
      'ul',
      { class: 'traces' },
      revealed && right.length > 0 && h('li', {}, h('strong', {}, 'Learned from you: '), right[0].a.quote ? `“${right[0].a.quote}”` : 'your explanation'),
      // Classmates with the same reason share one line.
      groupBy(reasons, ({ a }) => (blank(a) ? blankReason(a) : a.because)).map(([reason, group]) => h('li', {}, h('strong', {}, `${namesList(group.map((g) => g.s))}: `), reason))
    ),
    revealed && missed.length > 0 && h('p', { class: 'should-have' }, h('strong', {}, 'What you could have said: '), q.explanation)
  );
}

// Your own quiz is written while you read the class results; if it is not ready yet,
// show a short wait and fill it in when it arrives.
let selfQuizLoading = false;
function loadSelfQuiz() {
  if (selfQuizLoading) return;
  selfQuizLoading = true;
  const round = state.quizRound;
  checkedQuiz('self')
    .then(() => state.screen === 'selfquiz' && render())
    .catch((err) => {
      // Only if you are still waiting for it on this screen, in this class.
      if (round !== state.quizRound || state.screen !== 'selfquiz') return;
      state.screen = state.selfFrom || 'results';
      showError(err.message, openSelfQuiz);
    })
    .finally(() => (selfQuizLoading = false));
}

// After checking: a right answer shows its explanation. For a wrong (or blank) one, you first
// write one sentence on why the correct answer is right, then the explanation appears.
function SelfExplanation(q) {
  if (state.selfAnswers[q.id] === q.answer || state.selfShown[q.id]) {
    return [
      state.selfReasons[q.id] && h('p', { class: 'self-reason' }, h('strong', {}, 'You said: '), state.selfReasons[q.id]),
      h('p', { class: 'explain' }, q.explanation),
    ];
  }
  const show = (reason) => {
    state.selfReasons[q.id] = reason;
    state.selfShown[q.id] = true;
    render();
  };
  const box = h('textarea', {
    rows: 2,
    class: 'reason-box',
    'aria-label': `Why is “${q.options[q.answer]}” the right answer?`,
    placeholder: 'One sentence, in your own words. A guess is fine.',
    oninput: (e) => (state.selfReasons[q.id] = e.target.value),
  });
  box.value = state.selfReasons[q.id] || '';
  return h(
    'div',
    { class: 'reason' },
    h('p', {}, h('strong', {}, `Before you see why: why is “${q.options[q.answer]}” right?`)),
    box,
    h(
      'div',
      { class: 'controls' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-small btn-primary',
          onclick: () => {
            const reason = (state.selfReasons[q.id] || '').trim();
            if (!reason) return box.focus();
            show(reason);
          },
        },
        'Show the explanation'
      ),
      h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => show('') }, 'I don’t know')
    )
  );
}

function SelfQuiz() {
  if (!state.quiz?.selfChecked) {
    loadSelfQuiz();
    return h(
      'main',
      { class: 'loading' },
      WritingClass(),
      h('p', { role: 'status' }, 'Finishing your questions…'),
      // It keeps being written in the background; open it again whenever you like.
      h('button', { class: 'link-button', onclick: () => set({ screen: state.selfFrom || 'results' }) }, 'Back')
    );
  }
  const qs = state.quiz.selfQuiz;
  const score = selfScore();
  return h(
    'div',
    { class: 'page' },
    Header(),
    h(
      'main',
      { class: 'selfquiz' },
      h('h1', {}, 'Your turn'),
      h('p', { class: 'lede' }, 'New questions on the same topic.'),
      h(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            const blank = qs.filter((q) => state.selfAnswers[q.id] === undefined).length;
            // A blank answer is usually a slip: say so once, then allow it.
            if (blank && !state.selfBlankWarned) {
              set({ selfBlankWarned: true });
              return;
            }
            state.pages.self = 0; // start the review at question 1
            set({ selfSubmitted: true });
          },
        },
        Pager(
          'self',
          qs.map((q, i) =>
          h(
            'fieldset',
            { class: 'qcard' },
            h('legend', {}, `${i + 1}. ${q.question}`),
            q.options.map((opt, j) => {
              const chosen = state.selfAnswers[q.id] === j;
              const mark = state.selfSubmitted ? (j === q.answer ? ' is-right' : chosen ? ' is-wrong' : '') : '';
              return h(
                'label',
                { class: `option${mark}` },
                h('input', {
                  type: 'radio',
                  name: q.id,
                  value: j,
                  checked: chosen,
                  disabled: state.selfSubmitted,
                  onchange: () => {
                    state.selfAnswers[q.id] = j;
                    render(); // the dot for this question fills in (and "You left N blank" stays right)
                  },
                }),
                h('span', {}, opt)
              );
            }),
            state.selfSubmitted && SelfExplanation(q)
          )
          ),
          {
            dot: (i) => {
              const q = qs[i];
              if (state.selfSubmitted) return state.selfAnswers[q.id] === q.answer ? ' is-right' : ' is-wrong';
              return state.selfAnswers[q.id] !== undefined ? ' is-done' : '';
            },
          }
        ),
        score
          ? h(
              'div',
              { class: 'next-actions' },
              h('p', { class: 'self-score' }, `You got ${score.right} of ${score.total}.`),
              score.right < score.total && h('p', { class: 'hint' }, 'For each one you missed, say why the right answer is right, then see the explanation.'),
              h('button', { type: 'button', class: 'btn btn-primary', onclick: buildReport }, 'See my learning report')
            )
          : h(
              'div',
              { class: 'next-actions' },
              state.selfBlankWarned &&
                h('p', { class: 'hint', role: 'alert' }, `You left ${qs.filter((q) => state.selfAnswers[q.id] === undefined).length} blank. Answer them, or press Check my answers again to leave them blank.`),
              h('button', { type: 'submit', class: 'btn btn-primary' }, 'Check my answers')
            )
      )
    )
  );
}

function verdict(classPct, selfPct) {
  const taught = classPct >= 80 ? 'high' : classPct >= 45 ? 'mid' : 'low';
  if (selfPct === null) {
    return {
      high: 'You explained the lesson clearly.',
      mid: 'Your class learned part of the lesson, but your explanation had gaps.',
      low: 'Your class learned very little from your explanation.',
    }[taught];
  }
  const knows = selfPct >= 70;
  if (knows && taught === 'high') return 'You understand it and you can explain it.';
  if (knows) return 'You know it, but your explanation left gaps for your class.';
  if (taught === 'high') return 'You explained the slides well, but some ideas have not sunk in yet.';
  return 'This topic needs another pass before your test.';
}

function Report() {
  const { pct } = classScore();
  const self = selfScore();
  const r = state.report;

  const section = (title, items, render) =>
    items && items.length ? h('section', { class: 'report-section' }, h('h2', {}, title), h('ul', {}, items.map((x) => h('li', {}, render(x))))) : null;
  const slideTag = (n) => (n ? h('span', { class: 'slide-tag' }, `Slide ${n}`) : null);

  return h(
    'div',
    { class: 'page' },
    Header(),
    h(
      'main',
      { class: 'report split' },
      h(
        'aside',
        { class: 'split-aside' },
      h('h1', {}, 'Your learning report'),
      h(
        'div',
        { class: 'two-scores' },
        h('div', {}, Ring(pct, { size: 'md', label: 'How well you taught' }), h('p', { class: 'score-label' }, 'How well you taught')),
        self
          ? h(
              'div',
              {},
              Ring(self.pct, { size: 'md', label: 'How well you understand' }),
              h('p', { class: 'score-label' }, 'How well you understand'),
              state.selfSkipped && h('p', { class: 'hint' }, 'Taken after you saw the answers, so it may be a little high.')
            )
          : h(
              'div',
              { class: 'skipped' },
              h('p', { class: 'score-label' }, 'How well you understand'),
              h('p', {}, 'You skipped your quiz, so this report can only judge your teaching.'),
              h('button', { class: 'btn btn-primary btn-small', onclick: openSelfQuiz }, 'Take my quiz')
            )
      ),
      // A quiz taken after seeing the answers is shown, but does not decide the verdict.
      h('p', { class: 'verdict' }, verdict(pct, self && !state.selfSkipped ? self.pct : null)),
      skippedSlides().length > 0 && h('p', { class: 'hint' }, `Slides you skipped (${skippedSlides().join(', ')}) are not part of this report.`),
      r && h('p', { class: 'lede' }, r.headline),
      ReportActions()
      ),
      h('section', { class: 'split-main' }, r ? ReportTabs([
        section('What you got wrong', r.wrong, (x) => [
          slideTag(x.slide),
          // Only quotes found word for word in what you said are shown as "You said".
          x.youSaid ? h('p', {}, h('strong', {}, 'You said: '), `“${x.youSaid}”`) : null,
          h('p', {}, h('strong', {}, x.youSaid ? 'Actually: ' : 'What is correct: '), x.correct),
        ]),
      section('What you missed', r.missed, (x) => [slideTag(x.slide), h('p', {}, h('strong', {}, x.concept), x.why ? `: ${x.why}` : '')]),
        section('Misconceptions in your class', r.misconceptions, (x) => [
          slideTag(x.slide),
          h(
            'p',
            { class: x.corrected ? 'fixed-yes' : 'fixed-no' },
            x.corrected ? `✓ You corrected it${x.correctedOn && x.correctedOn !== x.slide ? ` later, on slide ${x.correctedOn}` : ''}` : '✗ You did not correct it'
          ),
          h('p', {}, h('strong', {}, `${x.name} believed: `), `“${x.belief}”`),
          x.correct && h('p', {}, h('strong', {}, 'Actually: '), x.correct),
        ]),
      section('“Why” you could not explain yet', r.why, (x) => [slideTag(x.slide), h('p', {}, h('strong', {}, x.question)), h('p', {}, x.strongAnswer)]),
        section('Explain it in your own words', r.ownWords, (x) => [
          slideTag(x.slide),
          h('p', {}, 'You mostly read this slide out loud instead of explaining it.'),
          h('p', {}, h('strong', {}, 'Try: '), x.tip),
        ]),
      section('Questions to prepare for', r.struggled, (x) => [h('p', {}, h('strong', {}, x.question)), h('p', {}, x.strongAnswer)]),
      section('Fix these slides', r.slideFixes, (x) => [slideTag(x.slide), h('p', {}, x.fix)]),
      section('What went well', r.strengths, (x) => h('p', {}, x)),
        r.nextSteps.length > 0 && h('section', { class: 'report-section report-next' }, h('h2', {}, 'What to do next'), h('ol', {}, r.nextSteps.map((x) => h('li', {}, x)))),
      ]) : h('div', { class: 'report-wait' }, WritingClass('md'), h('p', { role: 'status' }, state.busy || 'The report could not be written. Use Try again above.')))
    )
  );
}

function ReportActions() {
  const r = state.report;
  return [
      h(
        'div',
        { class: 'next-actions' },
        // While the report is being written, starting a new attempt would mix the two up.
        ReteachButton({ primary: true, disabled: Boolean(state.busy) }),
        h('button', { class: 'btn btn-quiet', onclick: () => set({ screen: 'results' }) }, 'See how your class answered')
      ),
      // Things you do now and then: small, so the next step above stands out.
      h(
        'div',
        { class: 'more-actions' },
        h('button', { class: 'link-button', onclick: presentAgain, disabled: Boolean(state.busy) }, 'Present every slide again'),
        r && h('button', { class: 'link-button', onclick: () => window.print() }, 'Print report'),
        h('button', { class: 'link-button', onclick: () => confirm('Start with new slides? This class and its report will be lost.') && startOver() }, 'Start with new slides')
      ),
  ];
}

// Report sections as tabs: one section on screen at a time.
function ReportTabs(sections) {
  const list = sections.filter(Boolean);
  if (!list.length) return h('p', { class: 'hint' }, 'Nothing to fix here. Well done.');
  const cur = pageIndex('report', list.length);
  const title = (el) => el.querySelector('h2')?.textContent || '';
  return h(
    'div',
    { class: 'tabs' },
    h(
      'div',
      { class: 'tab-list', role: 'tablist', 'aria-label': 'Report sections' },
      list.map((el, i) => h('button', { type: 'button', role: 'tab', class: `tab${i === cur ? ' is-current' : ''}`, 'aria-selected': String(i === cur), onclick: () => goPage('report', i) }, title(el)))
    ),
    h('div', { class: `tab-panel${pageTurned === 'report' ? ' is-turned' : ''}`, role: 'tabpanel' }, list[cur])
  );
}

// Refreshing or closing the tab loses the class, so ask first once you have presented something.
window.addEventListener('beforeunload', (e) => {
  const started = state.screen !== 'start' && state.log.some((l) => l.said);
  if (!started) return;
  e.preventDefault();
  e.returnValue = '';
});

render();
