import { audioConstraints, type AudioDsp } from "./audio-settings";
import { PcmBuffer } from "./pcm-buffer";

export interface MicSession {
  /** Stops capture, releases the microphone and returns what was recorded. */
  stop(): Promise<PcmBuffer>;
}

export class MicUnavailable extends Error {}

/**
 * Opens the microphone ONLY while the user holds push-to-talk and releases it on stop, so the OS "microphone in use"
 * indicator is truthful. Calls `onLevel` with the real input level and `onFull` when the clip hits the maximum length.
 */
export async function startMic(onLevel: (level: number) => void, onFull: () => void, dsp?: AudioDsp, onChunk16k?: (chunk: Float32Array) => void): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicUnavailable("Este entorno no permite usar el micrófono");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(dsp) });
  } catch (e) {
    throw new MicUnavailable(e instanceof DOMException && e.name === "NotAllowedError" ? "Permiso de micrófono denegado" : "No se pudo abrir el micrófono");
  }
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule("/capture-worklet.js");
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    throw new MicUnavailable("No se pudo iniciar la captura de audio");
  }
  const buffer = new PcmBuffer(ctx.sampleRate);
  // Streaming (ADR-0029): the same audio, resampled to 16 kHz as it arrives, so the sidecar can transcribe while the user talks.
  const resampler = onChunk16k ? new (await import("@jarvis/voice/audio")).StreamResampler(ctx.sampleRate) : undefined;
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "jarvis-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    buffer.push(e.data);
    if (resampler && !buffer.full) onChunk16k!(resampler.push(e.data));
    onLevel(Math.min(1, buffer.level * 6));
    if (buffer.full) onFull();
  };
  source.connect(node);
  let stopped = false;
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        node.port.onmessage = null;
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
      }
      return buffer;
    },
  };
}

export interface ContinuousMic {
  stop(): Promise<void>;
}

/**
 * Always-on capture for the wake word. Chunks arrive already resampled to 16 kHz. The browser's echo cancellation and noise
 * suppression are ON, which also helps keep the assistant's own voice out of the signal. Nothing is stored or sent from here.
 */
export async function startContinuousMic(onChunk: (chunk16k: Float32Array) => void, onLevel?: (level: number) => void): Promise<ContinuousMic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicUnavailable("Este entorno no permite usar el micrófono");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
  } catch (e) {
    throw new MicUnavailable(e instanceof DOMException && e.name === "NotAllowedError" ? "Permiso de micrófono denegado" : "No se pudo abrir el micrófono");
  }
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule("/capture-worklet.js");
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    throw new MicUnavailable("No se pudo iniciar la captura de audio");
  }
  const { StreamResampler, rms } = await import("@jarvis/voice/audio");
  const resampler = new StreamResampler(ctx.sampleRate);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "jarvis-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    onLevel?.(Math.min(1, rms(e.data) * 6));
    onChunk(resampler.push(e.data));
  };
  source.connect(node);
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}
