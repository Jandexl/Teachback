// Featherless.ai: the main AI for the classmates, quizzes and report.
// Featherless hosts open models (DeepSeek, Kimi, GLM...) behind an OpenAI-compatible API.
//
// - The model is picked automatically from the ones your key can use (fast models first),
//   or set FEATHERLESS_MODEL in .env to choose one yourself.
// - Your plan allows a few requests at the same time, so requests wait in line here
//   (one at a time) instead of being refused.
// - If Featherless fails, the caller falls back to Gemini, so the class keeps going.

const API = 'https://api.featherless.ai/v1';
const TIMEOUT_MS = { minimal: 30000, low: 40000, medium: 60000 };

// Fast, strong instruction-following families first. Reasoning-only models ("R1",
// "thinking") are skipped because they think for a long time before answering.
const PREFERENCE = [/deepseek-v\d+(\.\d+)?-flash/i, /glm-\d+(\.\d+)?-flash/i, /glm-\d/i, /deepseek-v\d/i, /kimi-k\d/i, /qwen3?.*instruct/i, /llama.*instruct/i];
const SKIP = /(r1|reason|thinking|vision|-vl|embed|coder|math|guard|base$)/i;

export class FeatherlessError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'auth' | 'model' | 'busy' | 'timeout' | 'context' | 'other'
  }
}

// Well-known models on Featherless (DeepSeek, Kimi and GLM families, as on the Chat plan),
// tried one by one if the model list cannot be read or has no match.
const KNOWN_MODELS = [
  'deepseek-ai/DeepSeek-V4.1-Flash', // fastest in real tests (2-7s per class turn)
  'zai-org/GLM-5.3-Flash',
  'zai-org/GLM-5.3',
  'zai-org/GLM-4.6',
  'moonshotai/Kimi-K2-Instruct-0905',
  'moonshotai/Kimi-K2-Instruct',
  'deepseek-ai/DeepSeek-V3.1',
  'deepseek-ai/DeepSeek-V3-0324',
  'zai-org/GLM-4.5',
  'Qwen/Qwen3-32B',
];

let modelIds = null;
let chosen = null;
let lastProblem = ''; // why no model could be picked, shown in the server window
const unavailable = new Set();
const noJsonMode = new Set(); // models that reject response_format
const noThinkingFlag = new Set(); // models that reject the "no thinking" setting

export const featherlessProblem = () => lastProblem;

// One request at a time. The plan has 4 "concurrent units", and a big model (GLM-5.3,
// DeepSeek-V4.1) uses all 4 for a single request, so a second request at the same time is
// always refused. Requests wait in line here instead. Live class requests go to the front
// of the line; background work (writing the quiz) waits behind them.
const MAX_AT_ONCE = 1;
const CONCURRENCY_WAIT_MS = 3000; // wait between tries when the plan's units are all in use
const CONCURRENCY_RETRIES = 15; // up to about 45 seconds
// If background work is already running when you ask for something (the report, a class
// turn), the background request is stopped so yours goes first, and it starts again later.
let running = 0;
let current = null; // the request using the slot right now: { background, pause }
const waiting = []; // { resolve, background }

class Paused extends Error {}

// The browser gave up on this request (for example it paused background work, or the tab
// was closed), so there is no point finishing it.
export class Cancelled extends Error {
  constructor() {
    super('The request was cancelled.');
    this.name = 'Cancelled';
  }
}

async function takeSlot(background, signal) {
  if (signal?.aborted) throw new Cancelled();
  if (running < MAX_AT_ONCE) {
    running++;
    return;
  }
  if (!background && current?.background) current.pause();
  // The slot is handed over directly when it frees up (see freeSlot), so nobody can jump in.
  await new Promise((resolve, reject) => {
    const entry = { resolve, background };
    const firstBackground = waiting.findIndex((w) => w.background);
    if (!background && firstBackground !== -1) waiting.splice(firstBackground, 0, entry);
    else waiting.push(entry);
    const onAbort = () => {
      const i = waiting.indexOf(entry);
      if (i === -1) return; // already given the slot
      waiting.splice(i, 1);
      reject(new Cancelled());
    };
    entry.resolve = () => {
      signal?.removeEventListener('abort', onAbort); // no leftover listener once the slot is ours
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function freeSlot() {
  const next = waiting.shift();
  if (next) next.resolve(); // `running` stays the same: the slot passes to the next request
  else running--;
}

async function inLine(task, { background = false, signal } = {}) {
  for (;;) {
    await takeSlot(background, signal);
    const controller = new AbortController();
    const me = { background, paused: false, pause: () => ((me.paused = true), controller.abort()) };
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel);
    current = me;
    try {
      return await task(controller.signal);
    } catch (err) {
      if (signal?.aborted) throw new Cancelled();
      if (!me.paused) throw err;
      console.log('  Paused background quiz work so your request goes first. It will continue after.');
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (current === me) current = null;
      freeSlot();
    }
    // Paused: wait in line again behind the request that took over.
  }
}

export async function listFeatherlessModels({ key, fetchImpl = fetch }) {
  if (modelIds) return modelIds;
  let res;
  try {
    res = await fetchImpl(`${API}/models`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    lastProblem = 'could not reach api.featherless.ai (check your internet, VPN or Cloudflare settings)';
    return null;
  }
  if (!res.ok) {
    lastProblem = res.status === 401 || res.status === 403 ? `the model list was refused (${res.status}): the key may be wrong` : `the model list returned error ${res.status}`;
    return null;
  }
  try {
    const data = await res.json();
    // Accept the common shapes: {data:[...]}, {models:[...]}, or a plain list.
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const ids = list.map((m) => String(typeof m === 'string' ? m : m?.id || m?.name || '')).filter(Boolean);
    if (!ids.length) {
      lastProblem = 'the model list was empty or in an unknown format';
      return null;
    }
    modelIds = ids;
    return modelIds;
  } catch {
    lastProblem = 'the model list could not be read';
    return null;
  }
}

// Sends a tiny request to check a model really works on this key. Returns 'ok', 'auth' or 'no'.
async function probe(model, { key, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(15000), // never wait forever just to test a model
    });
    // Busy or a hiccup says nothing about whether the model exists: do not rule it out.
    if (res.status === 429 || res.status >= 500) {
      lastProblem = `${model} was busy (${res.status})`;
      return 'offline';
    }
    if (res.ok) return 'ok';
    let detail = '';
    try {
      const body = await res.json();
      detail = String(body?.error?.message || body?.message || body?.detail || '');
    } catch {
      /* ignore */
    }
    if (res.status === 401) {
      lastProblem = `Featherless rejected the key (401). ${detail}`.trim();
      return 'auth';
    }
    lastProblem = `${model} answered ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`;
    return 'no';
  } catch {
    lastProblem = 'could not reach api.featherless.ai (check your internet, VPN or Cloudflare settings)';
    return 'offline';
  }
}

export function rankFeatherlessModels(ids) {
  const score = (id) => {
    const i = PREFERENCE.findIndex((re) => re.test(id));
    if (i === -1) return -1;
    const version = Number((id.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]) || 0;
    return (PREFERENCE.length - i) * 1000 + version; // family first, then newest version
  };
  return ids
    .filter((id) => !SKIP.test(id.split('/').pop()) && score(id) >= 0)
    .sort((a, b) => score(b) - score(a));
}

export async function pickFeatherlessModel(opts) {
  if (opts.model && !unavailable.has(opts.model)) return opts.model;
  if (chosen && !unavailable.has(chosen)) return chosen;

  // 1. Best match from the model list (if it could be read).
  const ids = await listFeatherlessModels(opts);
  const ranked = rankFeatherlessModels(ids || []).filter((id) => !unavailable.has(id));
  if (ranked.length) {
    chosen = ranked[0];
    return chosen;
  }
  if (ids && !ranked.length) lastProblem = `none of the ${ids.length} listed models is a DeepSeek, Kimi or GLM chat model`;

  // 2. Otherwise test well-known models directly and use the first that answers.
  for (const model of KNOWN_MODELS) {
    if (unavailable.has(model)) continue;
    const result = await probe(model, opts);
    if (result === 'ok') {
      chosen = model;
      lastProblem = '';
      return chosen;
    }
    if (result === 'auth') return null; // a wrong key will not work for any model
    if (result === 'offline') return null; // try again on the next request; do not blame the model
    unavailable.add(model);
  }
  return null;
}

// ---------- switching between Featherless models ----------
// Each request tries up to 3 models in order (your chosen one first, then the backups).
// A model that is too slow or busy "rests" for a while, so the next requests go straight
// to the backup; when the rest is over, the first choice is tried again.
const MAX_MODELS_PER_REQUEST = 3;
const REST_AFTER_SLOW_MS = 3 * 60 * 1000;
const REST_AFTER_BUSY_MS = 60 * 1000;
const restingUntil = new Map(); // model -> time it can be used again
const badAnswers = new Map(); // model -> how many empty or unreadable answers it sent

const MAX_CHAIN = 4; // your model plus up to 3 strong backups
const MAX_SLOW_PER_REQUEST = 2; // two slow models in a row means Featherless itself is slow

// "Quality" jobs (writing quizzes, grading the class quiz, the learning report) use bigger,
// more accurate models: full versions, not "Flash". They are slower, which is fine because
// these jobs are not live. Set FEATHERLESS_QUALITY_MODEL in .env to choose one yourself.
const QUALITY_PREFERENCE = [/glm-\d+(\.\d+)?$/i, /kimi-k\d+(\.\d+)?$/i, /deepseek-v\d+(\.\d+)?$/i];
const KNOWN_QUALITY_MODELS = ['zai-org/GLM-5.3', 'moonshotai/Kimi-K3', 'deepseek-ai/DeepSeek-V4.1'];

export function rankQualityModels(ids) {
  const score = (id) => {
    const name = id.split('/').pop();
    const i = QUALITY_PREFERENCE.findIndex((re) => re.test(name));
    if (i === -1 || SKIP.test(name)) return -1;
    const version = Number((name.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]) || 0;
    return (QUALITY_PREFERENCE.length - i) * 1000 + version;
  };
  return ids.filter((id) => score(id) >= 0).sort((a, b) => score(b) - score(a));
}

export async function modelChain(opts, tier = 'main') {
  await listFeatherlessModels(opts); // so backups are models really on your plan
  const now = Date.now();
  const order = (list) => [...list.filter((m) => !(restingUntil.get(m) > now)), ...list.filter((m) => restingUntil.get(m) > now)];
  const first = await pickFeatherlessModel(opts);
  const backups = modelIds ? rankFeatherlessModels(modelIds) : KNOWN_MODELS;
  const main = [...new Set([first, opts.model, ...backups].filter((m) => m && !unavailable.has(m)))].slice(0, MAX_CHAIN);
  if (tier !== 'quality' && tier !== 'grading') return order(main);

  let quality = modelIds ? rankQualityModels(modelIds) : KNOWN_QUALITY_MODELS;
  // Grading the class quiz (many answers, each with a quote): Kimi first. In real runs GLM was
  // much slower at this one job and sometimes sent a broken answer; it is the next choice.
  if (tier === 'grading') quality = [...quality.filter((m) => /kimi/i.test(m)), ...quality.filter((m) => !/kimi/i.test(m))];
  // FEATHERLESS_QUALITY_MODEL goes first, except for grading, where Kimi stays first (in real
  // runs GLM took minutes on grading and sent broken answers).
  const preferred = tier === 'grading' && opts.qualityModel && !/kimi/i.test(opts.qualityModel) ? [...quality, opts.qualityModel] : [opts.qualityModel, ...quality];
  const best = [...new Set(preferred.filter((m) => m && !unavailable.has(m)))].slice(0, 2);
  // Strong models first; the fast class models stay as a last resort so the job still finishes.
  return [...order(best), ...order(main.filter((m) => !best.includes(m)))];
}

const short = (model) => model.split('/').pop();

// Sends one prompt and returns the parsed answer. `parse` turns the text into JSON;
// an answer that cannot be parsed counts as a failure and the next model is tried.
export async function featherlessChat(request, opts, parse = (t) => t) {
  const quality = request.tier === 'quality' || request.tier === 'grading';
  const chain = await modelChain(opts, quality ? request.tier : 'main');
  let lastError = null;
  let tried = 0;
  let slow = 0;
  for (const model of chain) {
    if (tried >= MAX_MODELS_PER_REQUEST || slow >= MAX_SLOW_PER_REQUEST) break;
    // If a time limit is set (REQUEST_TIME_LIMIT_SECONDS), stop early with a clear message
    // instead of being cut off; each model only gets the time that is left.
    const left = opts.deadline ? opts.deadline - Date.now() - 3000 : Infinity;
    if (left < 8000) {
      lastError = new FeatherlessError('Featherless models are slow right now.', 'timeout');
      break;
    }
    tried++;
    const timed = { ...request, wait: Math.min(request.wait || 45000, left) };
    try {
      const text = await inLine((signal) => send(timed, { ...opts, model, signal }), { background: request.background, signal: opts.signal });
      let out;
      try {
        out = parse(text);
      } catch {
        console.log(`  featherless ${short(model)}: answer was not valid JSON`);
        throw new FeatherlessError('The answer could not be read.', 'bad');
      }
      badAnswers.delete(model);
      if (!quality && chosen !== model) {
        if (chosen) console.log(`  Now using ${short(model)}.`);
        chosen = model;
      }
      return out;
    } catch (err) {
      if (!(err instanceof FeatherlessError)) throw err;
      lastError = err;
      if (err.kind === 'model') {
        unavailable.add(model); // not on your plan or not found: never try it again
        if (chosen === model) chosen = null;
      } else if (err.kind === 'timeout') {
        slow++;
        restingUntil.set(model, Date.now() + REST_AFTER_SLOW_MS);
      } else if (err.kind === 'empty' || err.kind === 'bad') {
        // A model that keeps sending empty or broken answers is dropped for this run,
        // so it stops wasting time on every request.
        const count = (badAnswers.get(model) || 0) + 1;
        badAnswers.set(model, count);
        if (count >= 2) {
          unavailable.add(model);
          if (chosen === model) chosen = null;
          console.log(`  ${short(model)} keeps sending ${err.kind === 'empty' ? 'empty' : 'unreadable'} answers, so it will not be used until restart.`);
        } else {
          restingUntil.set(model, Date.now() + REST_AFTER_BUSY_MS);
        }
      } else if (err.kind === 'busy') {
        restingUntil.set(model, Date.now() + REST_AFTER_BUSY_MS);
      } else {
        // A wrong key, a too-long request, or the plan being busy: another model will not help.
        throw err;
      }
      const next = chain[tried];
      if (next && tried < MAX_MODELS_PER_REQUEST && slow < MAX_SLOW_PER_REQUEST) console.log(`  Switching to ${short(next)}.`);
    }
  }
  if (/\b401\b/.test(lastProblem)) throw new FeatherlessError(lastProblem, 'auth');
  if (lastError?.kind === 'timeout') throw new FeatherlessError('Featherless models are slow right now.', 'timeout');
  if (lastError?.kind === 'busy') throw new FeatherlessError('Featherless is busy right now.', 'busy');
  if (lastError?.kind === 'bad' || lastError?.kind === 'empty') throw new FeatherlessError('The AI did not send a usable answer.', 'bad');
  throw new FeatherlessError(`No Featherless model could be used (${lastProblem || 'unknown reason'}).`, 'model');
}

async function send({ system, prompt, temperature = 0.7, thinking, wait, maxTokens }, { key, model, fetchImpl = fetch, signal, deadline }, retry = 0) {
  if (signal?.aborted) throw new Paused();
  const body = {
    model,
    messages: [
      { role: 'system', content: `${system}\nReply with JSON only, no other text.` },
      { role: 'user', content: prompt },
    ],
    temperature,
    max_tokens: maxTokens || 4096, // a cap keeps short tasks (class reactions) fast
  };
  if (!noJsonMode.has(model)) body.response_format = { type: 'json_object' };
  // Ask hybrid models (GLM, DeepSeek, Qwen) to skip long thinking for speed.
  if (!noThinkingFlag.has(model)) body.chat_template_kwargs = { enable_thinking: false, thinking: false };

  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop); // paused for a more urgent request
  // How long to wait before switching to the next model ("wait" is set per task).
  const timer = setTimeout(() => controller.abort(), wait || TIMEOUT_MS[thinking] || 45000);
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  // The time limit covers the whole answer, not just until it starts arriving: a model can
  // start replying quickly and then write very slowly.
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  };
  const tooSlow = () => {
    console.log(`  featherless ${short(model)}: too slow (no answer after ${took()})`);
    return new FeatherlessError('Featherless took too long to answer.', 'timeout');
  };
  let res;
  try {
    res = await fetchImpl(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    done();
    if (signal?.aborted) throw new Paused();
    if (err?.name === 'AbortError') throw tooSlow();
    console.log(`  featherless ${short(model)}: could not connect (${err?.message || 'network error'})`);
    throw new FeatherlessError('Could not reach Featherless.', 'busy');
  }

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = String(data?.error?.message || data?.message || data?.detail || '');
    } catch {
      /* ignore */
    }
    done();
    if (signal?.aborted) throw new Paused();
    const oneLine = detail.replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
    const concurrency = res.status === 429 && /concurren/i.test(detail);
    if (concurrency) {
      // Your plan's units are all in use (often by a request that is still finishing).
      // Switching models will not help; wait for the units to free up and try again.
      if (retry === 0) console.log(`  featherless ${short(model)}: plan is busy with another request, waiting for it to finish…`);
      if (retry < CONCURRENCY_RETRIES && !(deadline && Date.now() + CONCURRENCY_WAIT_MS > deadline - 5000)) {
        await new Promise((r) => setTimeout(r, CONCURRENCY_WAIT_MS));
        if (signal?.aborted) throw new Paused();
        return send({ system, prompt, temperature, thinking, wait, maxTokens }, { key, model, fetchImpl, signal, deadline }, retry + 1);
      }
      console.log(`  featherless: still busy after ${Math.round((CONCURRENCY_RETRIES * CONCURRENCY_WAIT_MS) / 1000)}s of waiting`);
      throw new FeatherlessError('Your Featherless plan is still busy with an earlier request. Wait a few seconds and press Try again.', 'concurrency');
    }
    console.log(`  featherless ${short(model)}: error ${res.status} after ${took()}${oneLine ? ` (${oneLine.slice(0, 110)})` : ''}`);
    if (res.status === 400 && body.response_format && /response_format|json/i.test(detail)) {
      noJsonMode.add(model);
      return send({ system, prompt, temperature, thinking, wait, maxTokens }, { key, model, fetchImpl, signal, deadline }, retry);
    }
    if (res.status === 400 && body.chat_template_kwargs && /chat_template|kwargs|thinking/i.test(detail)) {
      noThinkingFlag.add(model);
      return send({ system, prompt, temperature, thinking, wait, maxTokens }, { key, model, fetchImpl, signal, deadline }, retry);
    }
    if (res.status === 400 && /context|too long|maximum.*length|tokens/i.test(detail)) {
      throw new FeatherlessError('This is too long for your Featherless plan (32K limit).', 'context');
    }
    if (res.status === 401) throw new FeatherlessError('Featherless rejected the API key. Check FEATHERLESS_API_KEY.', 'auth');
    if (res.status === 403 || res.status === 404 || (res.status === 400 && /model|not found|not available|plan|subscription/i.test(detail))) {
      if (/suspend|cancel|banned|terms|abuse|disabled/i.test(detail)) throw new FeatherlessError(`Featherless refused: ${detail}`, 'auth');
      throw new FeatherlessError(detail || 'Model not available', 'model');
    }
    if (res.status === 429 && retry < 2) {
      // Rate limited: wait a moment and try again.
      await new Promise((r) => setTimeout(r, 1500 * (retry + 1)));
      return send({ system, prompt, temperature, thinking, wait, maxTokens }, { key, model, fetchImpl, signal, deadline }, retry + 1);
    }
    if (res.status === 429 || res.status >= 500) throw new FeatherlessError('Featherless is busy right now.', 'busy');
    throw new FeatherlessError(`Featherless returned an error (${res.status}). ${detail}`.trim(), 'other');
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    if (signal?.aborted) throw new Paused();
    if (controller.signal.aborted || err?.name === 'AbortError') throw tooSlow();
    console.log(`  featherless ${short(model)}: reply could not be read after ${took()}`);
    throw new FeatherlessError('Featherless sent a reply that could not be read.', 'bad');
  } finally {
    done();
  }
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  let text = String(message.content || '');
  // Some models still write their thinking first; keep only the answer.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Some "thinking" models put everything in a separate reasoning field and leave the
  // answer empty. If that field ends with the JSON we asked for, use it.
  if (!text) {
    const reasoning = String(message.reasoning_content || message.reasoning || '');
    const start = reasoning.indexOf('{');
    const end = reasoning.lastIndexOf('}');
    if (start !== -1 && end > start) text = reasoning.slice(start, end + 1);
  }
  if (!text) {
    const why = choice.finish_reason === 'length' ? 'it used up its length limit thinking' : `finish reason: ${choice.finish_reason || 'none'}`;
    console.log(`  featherless ${short(model)}: empty answer after ${took()} (${why})`);
    throw new FeatherlessError('Featherless returned an empty answer.', 'empty');
  }
  // Cut off at the length limit: the JSON is probably incomplete. Say so in the log.
  console.log(`  featherless ${short(model)}: answered in ${took()}${choice.finish_reason === 'length' ? ' (cut off at its length limit)' : ''}`);
  return text;
}
