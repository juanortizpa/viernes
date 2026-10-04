// Forwards raw mono input blocks to the main thread. Loaded from the app's own origin (CSP: default-src 'self').
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("jarvis-capture", CaptureProcessor);
