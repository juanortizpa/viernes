// Forwards raw mono input to the main thread in ~40 ms batches. Loaded from the app's own origin (CSP: default-src 'self').
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.batch[this.n++] = ch[i];
      if (this.n === this.batch.length) {
        this.port.postMessage(this.batch.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("jarvis-capture", CaptureProcessor);
