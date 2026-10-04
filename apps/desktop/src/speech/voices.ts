export interface VoiceInfo {
  name: string;
  lang: string;
  /** Offline voice (no network). */
  localService: boolean;
  default?: boolean;
}

/** Regional preference per language. The user speaks voseo, so Rioplatense Spanish comes first when installed. */
const REGION_ORDER: Record<string, string[]> = {
  es: ["es-AR", "es-UY", "es-MX", "es-US", "es-CO", "es-ES"],
  en: ["en-US", "en-GB", "en-AU"],
};

/**
 * Best installed voice for a language: preferred region first, offline before online, then the system default.
 * Returns undefined when no voice speaks that language (the caller should stay silent rather than read Spanish with an English voice).
 */
export function pickVoice<T extends VoiceInfo>(voices: readonly T[], lang: "es" | "en", preferredName?: string): T | undefined {
  const matches = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(lang));
  if (matches.length === 0) return undefined;
  const named = preferredName ? matches.find((v) => v.name === preferredName) : undefined;
  if (named) return named;
  const rank = (v: T): number => {
    const region = REGION_ORDER[lang]!.findIndex((r) => v.lang.replace("_", "-").toLowerCase() === r.toLowerCase());
    return (region < 0 ? 50 : region) * 4 + (v.localService ? 0 : 2) + (v.default ? 0 : 1);
  };
  return [...matches].sort((a, b) => rank(a) - rank(b))[0];
}
