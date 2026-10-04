/** Whether the browser's own audio processing (echo cancellation, noise suppression, auto gain) is applied to the microphone. */
export type AudioDsp = "on" | "off";
export const AUDIO_DSP_KEY = "jarvis.audioDsp";

export function loadAudioDsp(): AudioDsp {
  try {
    return localStorage.getItem(AUDIO_DSP_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

export function saveAudioDsp(v: AudioDsp): void {
  try {
    localStorage.setItem(AUDIO_DSP_KEY, v);
  } catch {
    /* session-only */
  }
}

/** Browser noise suppression is tuned for calls and can blur consonants a recogniser needs: this makes it a measurable choice. */
export function audioConstraints(dsp: AudioDsp = loadAudioDsp()): MediaTrackConstraints {
  const on = dsp === "on";
  return { channelCount: 1, echoCancellation: on, noiseSuppression: on, autoGainControl: on };
}
