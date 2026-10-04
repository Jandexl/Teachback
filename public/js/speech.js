// Live speech-to-text using the browser's built-in Web Speech API (Chrome and Edge).
// Audio is handled by the browser; this app never records or stores it.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = Boolean(Recognition);

export class Dictation {
  constructor({ lang = 'en-US', onText = () => {}, onState = () => {}, onError = () => {} } = {}) {
    this.lang = lang;
    this.onText = onText;
    this.onState = onState;
    this.onError = onError;
    this.active = false;
    this.base = '';
    this.finalText = '';
    this.rec = null;
  }

  // `startingText` lets the user keep what they typed and keep talking after it.
  start(startingText = '') {
    if (!speechSupported) {
      this.onError('Voice input is not available in this browser. Use Chrome or Edge, or type instead.');
      return false;
    }
    if (this.active) return true;
    this.base = startingText.trim();
    this.finalText = '';
    this.active = true;
    this.#open();
    this.onState(true);
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.onState(false);
  }

  #open() {
    const rec = new Recognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      // Chrome can deliver a last result after stop(); ignore it, or the previous answer
      // would appear in the next slide's text box.
      if (!this.active) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) this.finalText += r[0].transcript.trim() + ' ';
        else interim += r[0].transcript;
      }
      this.onText(join(this.base, this.finalText, interim));
    };
    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.onError('Microphone access was blocked. Allow the microphone in your browser settings, or type instead.', event.error);
      } else if (event.error === 'network') {
        this.onError("Your browser could not reach its speech-to-text service. This happens in browsers like Brave and Opera, or with a VPN or school network filter.", 'network');
      } else {
        this.onError(`Voice input stopped (${event.error}). Press the mic to try again, or type instead.`, event.error);
      }
      this.active = false;
      this.onState(false);
    };
    // Chrome ends recognition after a pause; restart it while the user is still presenting.
    rec.onend = () => {
      if (this.active) {
        this.base = join(this.base, this.finalText, '');
        this.finalText = '';
        try {
          rec.start();
        } catch {
          this.#open();
        }
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      /* start can throw if called twice; the onend handler recovers */
    }
  }
}

function join(...parts) {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}
