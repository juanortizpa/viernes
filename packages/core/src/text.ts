/** Lowercase, accent-free, punctuation-free form used to compare spoken/typed text and aliases. */
export const normalizeText = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,;:…"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Leading words people add when TALKING that carry no command: fillers, the assistant's name, "decime/tell me". */
const SPOKEN_LEAD = /^(?:(?:che|eh+|em+|mm+|este|bueno|a ver|dale|mira|oye|hey|ok|okay|jarvis|por favor|please|decime|dime|me decis|me dices|sabes|me podes decir|me puedes decir|podrias decirme|podes decirme|tell me|can you tell me|do you know)\s+)+/;

/**
 * Spoken-language cleanup for deterministic rules (input already `normalizeText`-ed): drops leading fillers, hesitation sounds
 * anywhere ("eh", "em") and immediate word repetitions ("el el paint" -> "el paint"). Only used to MATCH rules; the original
 * text is what the model sees.
 */
export function cleanSpoken(normalized: string): string {
  return normalized
    .replace(/\b(?:eh+|em+|mm+|ehm+)\b/g, " ")
    .replace(/\b(\p{L}+)(?:\s+\1\b)+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(SPOKEN_LEAD, "")
    .trim();
}

/**
 * Rough Spanish/English phonetic key, so a name misheard by speech recognition still finds the app it sounds like
 * ("broser" ~ "browser", "blog de notas" ~ "bloc de notas", "calcula dora" ~ "calculadora"). Spaces are ignored.
 */
export function phoneticKey(s: string): string {
  return normalizeText(s)
    .replace(/[^a-z0-9]/g, "")
    .replace(/ph/g, "f")
    .replace(/qu/g, "k")
    .replace(/c(?=[ei])/g, "s")
    .replace(/ch/g, "X")
    .replace(/c/g, "k")
    .replace(/g(?=[ei])/g, "j")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/ll/g, "i")
    .replace(/y/g, "i")
    .replace(/h/g, "")
    .replace(/X/g, "ch")
    .replace(/([aeiou])w/g, "$1")
    .replace(/w/g, "u")
    .replace(/x/g, "ks")
    .replace(/(.)\1+/g, "$1")
    .replace(/g(?![aeiou])/g, "k"); // g before a consonant or at the end sounds like k ("blog de notas" ~ "bloc de notas")
}
