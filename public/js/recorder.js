// Voice input for browsers without live speech-to-text (Brave, Firefox, Opera, some networks).
// It listens to the microphone, shows a live level meter, and every time you pause it cuts
// that phrase into a small WAV clip. The server asks Gemini to write each clip out, so your
// words appear phrase by phrase while you keep talking. Audio is never stored.

export const recorderSupported = Boolean(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));

const RATE = 16000; // clip sample rate sent to Gemini
const PAUSE_MS = 900; // a pause this long ends a phrase
const MIN_PHRASE_MS = 4000; // shorter phrases wait for more speech (keeps requests within free limits)
const MAX_PHRASE_MS = 15000; // long phrases are cut here even without a pause
const MAX_RECORDING_MS = 5 * 60 * 1000;
const QUIET_WARNING_MS = 4000;

export class Recorder {
  constructor({ onState = () => {}, onLevel = () => {}, onClip = () => {}, onQuiet = () => {}, onTick = () => {} } = {}) {
    Object.assign(this, { onState, onLevel, onClip, onQuiet, onTick });
    this.active = false;
  }

  async start() {
    // Already on, or still waiting for microphone permission: a second click does nothing.
    if (this.active || this.starting) return;
    // Stop or cancel while waiting for permission changes this token, so the microphone the
    // browser then hands over is switched straight off instead of being left on.
    const token = (this.token = (this.token || 0) + 1);
    this.starting = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      this.starting = false;
      if (token !== this.token) return;
      throw new Error('Microphone access was blocked. Allow the microphone for this site in your browser settings, or type instead.');
    }
    if (token !== this.token) {
      stream.getTracks().forEach((t) => t.stop());
      this.starting = false;
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this.starting = false;
    if (token !== this.token) {
      stream.getTracks().forEach((t) => t.stop());
      this.ctx.close().catch(() => {});
      return;
    }
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination); // required for the processor to run; it outputs silence

    this.seq = 0;
    this.buffers = [];
    this.phraseStart = performance.now();
    this.lastVoice = 0;
    this.phraseHasVoice = false;
    this.heardAnything = false;
    this.warned = false; // the "can't hear you" hint can show again on every new recording
    this.noiseFloor = 0.01;
    this.startedAt = performance.now();
    this.active = true;

    this.node.onaudioprocess = (e) => this.#process(e.inputBuffer.getChannelData(0));
    this.onState(true);
  }

  #process(input) {
    if (!this.active) return;
    const now = performance.now();
    const samples = new Float32Array(input); // copy: the browser reuses the buffer
    this.buffers.push(samples);

    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    // Track background noise slowly, so "speaking" means clearly louder than the room.
    if (rms < this.noiseFloor * 1.5) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    const speaking = rms > Math.max(0.015, this.noiseFloor * 3);
    if (speaking) {
      this.lastVoice = now;
      this.phraseHasVoice = true;
      this.heardAnything = true;
    }
    this.onLevel(Math.min(1, Math.sqrt(rms) * 3.2), speaking);
    this.onTick(Math.floor((now - this.startedAt) / 1000));

    if (!this.heardAnything && now - this.startedAt > QUIET_WARNING_MS && !this.warned) {
      this.warned = true;
      this.onQuiet();
    }

    const phraseLength = now - this.phraseStart;
    const paused = this.phraseHasVoice && now - this.lastVoice > PAUSE_MS;
    if ((paused && phraseLength > MIN_PHRASE_MS) || phraseLength > MAX_PHRASE_MS) this.#flush(false);
    else if (!this.phraseHasVoice && phraseLength > 3000) this.#reset(); // drop long silences
    if (now - this.startedAt > MAX_RECORDING_MS) this.stop();
  }

  #reset() {
    this.buffers = [];
    this.phraseStart = performance.now();
    this.phraseHasVoice = false;
  }

  #flush(final) {
    const buffers = this.buffers;
    const hasVoice = this.phraseHasVoice;
    const inputRate = this.ctx.sampleRate;
    this.#reset();
    if (!hasVoice || !buffers.length) return;
    const seq = this.seq++;
    this.onClip(encodeWav(buffers, inputRate), seq, final);
  }

  // Stops listening; the last phrase is sent too. Returns how many clips were sent.
  stop() {
    this.token = (this.token || 0) + 1; // also drops a start still waiting for permission
    if (!this.active) return this.seq || 0;
    this.#flush(true);
    this.active = false;
    this.#close();
    this.onState(false);
    return this.seq;
  }

  cancel() {
    this.token = (this.token || 0) + 1; // also drops a start still waiting for permission
    if (!this.active) return;
    this.active = false;
    this.#close();
    this.onState(false);
  }

  #close() {
    try {
      this.node.onaudioprocess = null;
      this.node.disconnect();
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }
}

// Joins the recorded buffers, resamples to 16 kHz mono and returns base64 WAV.
function encodeWav(buffers, inputRate) {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const ratio = inputRate / RATE;
  const outLength = Math.floor(total / ratio);
  const out = new Int16Array(outLength);

  // Simple averaging downsampler (good enough for speech).
  let bufIndex = 0;
  let bufPos = 0;
  let consumed = 0;
  for (let i = 0; i < outLength; i++) {
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    while (consumed < end && bufIndex < buffers.length) {
      sum += buffers[bufIndex][bufPos];
      count++;
      consumed++;
      if (++bufPos >= buffers[bufIndex].length) {
        bufIndex++;
        bufPos = 0;
      }
    }
    const s = Math.max(-1, Math.min(1, count ? sum / count : 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + out.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + out.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, out.length * 2, true);
  new Int16Array(buffer, 44).set(out);

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
