/** When JARVIS speaks. "voice": only answers to a request that was spoken to it. */
export type SpeakMode = "voice" | "always" | "never";

export const SPEAK_MODES: { value: SpeakMode; label: string }[] = [
  { value: "voice", label: "Solo si hablo" },
  { value: "always", label: "Siempre" },
  { value: "never", label: "Nunca" },
];

export function shouldSpeak(mode: SpeakMode, modality: "text" | "voice"): boolean {
  return mode === "always" || (mode === "voice" && modality === "voice");
}

export const parseSpeakMode = (raw: string | null | undefined): SpeakMode => (raw === "always" || raw === "never" || raw === "voice" ? raw : "voice");
