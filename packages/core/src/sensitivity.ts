export interface Sensitivity {
  sensitive: boolean;
  /** Categories only, never the matched text. */
  reasons: string[];
}

const PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["api key", /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ["password", /\b(?:password|passwd|contrasena|clave|pwd)\s*(?:es|is|=|:)\s*\S{4,}/i],
  ["iban", /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/],
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

/**
 * Deterministic, LLM-free check for secrets and financial identifiers in text that is about to leave the machine.
 * Conservative on purpose: it favours obvious credentials over fuzzy PII, because a false positive only forces a local model.
 * It scans the user input; content the model reads later through tools is not covered (taint tracking handles that separately).
 */
export function detectSensitive(text: string): Sensitivity {
  const normalized = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const reasons = PATTERNS.filter(([, re]) => re.test(normalized)).map(([name]) => name);
  if (hasCardNumber(normalized)) reasons.push("card number");
  return { sensitive: reasons.length > 0, reasons };
}
