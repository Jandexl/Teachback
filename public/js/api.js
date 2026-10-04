// Talks to our own server (/api/teach). The server holds the API keys.
//
// The AI plan answers one big request at a time, so the browser sends one at a time too
// (voice transcription is separate and always goes straight through). Background work,
// like preparing your own quiz while you read the results, steps aside the moment you ask
// for something: it is stopped, and started again once your request is done. This also
// works online, where each request may run on a different server.

let busy = false;
let active = null; // { isBackground, pause }
const waiting = []; // { resolve, isBackground }

// isBackground is checked each time, so background work becomes urgent the moment you are
// waiting for it (for example, you open your own quiz before it is ready).
function takeTurn(isBackground) {
  if (!busy) {
    busy = true;
    return Promise.resolve();
  }
  if (!isBackground() && active?.isBackground()) active.pause();
  return new Promise((resolve) => waiting.push({ resolve, isBackground }));
}

function endTurn() {
  // Urgent requests first, then background work, each in the order they were asked.
  const urgent = waiting.findIndex((w) => !w.isBackground());
  const next = urgent !== -1 ? waiting.splice(urgent, 1)[0] : waiting.shift();
  if (next) next.resolve(); // the turn passes straight to the next request
  else busy = false;
}

// Call after leaving a class: a request still running for it is stopped (on the server too),
// so the next class does not wait behind work nobody needs any more.
export function dropStale() {
  if (active?.stale?.()) active.pause(); // it then sees it is stale and gives up
}

// Call when a waiting background request has just become urgent.
export function nudge() {
  if (active?.isBackground() && waiting.some((w) => !w.isBackground())) active.pause();
}

// background: true, or a function that says whether it is still background work.
// stale: optional check; when it returns true the request is no longer needed (you started
// a new attempt, or skipped your quiz), so it is dropped instead of being sent or retried.
// maxPauses: give up (with "No longer needed.") instead of restarting after this many pauses.
export async function ask(task, payload, { background = false, stale = null, maxPauses = Infinity } = {}) {
  if (task === 'transcribe') return send(task, payload);
  const isBackground = typeof background === 'function' ? background : () => background;
  let pauses = 0;
  for (;;) {
    if (pauses > maxPauses) throw new Error('No longer needed.');
    if (stale?.()) throw new Error('No longer needed.');
    await takeTurn(isBackground);
    if (stale?.()) {
      endTurn();
      throw new Error('No longer needed.');
    }
    const controller = new AbortController();
    const me = { isBackground, stale, paused: false, pause: () => ((me.paused = true), controller.abort()) };
    active = me;
    try {
      return await send(task, payload, controller.signal);
    } catch (err) {
      if (!me.paused) throw err;
      pauses++;
      // Paused for something more urgent: wait in line and try again.
    } finally {
      if (active === me) active = null;
      endTurn();
    }
  }
}

async function send(task, payload, signal) {
  let res;
  try {
    res = await fetch('/api/teach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, payload }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Could not reach the TeachBack server. Check that it is running and you are online.');
  }
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    /* non-JSON error page */
  }
  if (!res.ok) throw new Error(data.error || `The server returned an error (${res.status}).`);
  return data;
}
