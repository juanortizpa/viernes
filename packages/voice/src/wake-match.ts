/** Does a transcript start with the wake word, and what comes after it? Runs on the sidecar after stage-2 transcription. */

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Speech recognisers hear "Jarvis" as these; accepted without further fuzziness. */
const VARIANTS: Record<string, string[]> = {
  jarvis: ["jarvis", "yarvis", "harvis", "jarbis", "yarbis", "jarviz", "charvis", "garvis", "jarvi", "jarves", "yarves", "jarvish", "darvis"],
};

const FILLERS = new Set(["hey", "hola", "oye", "ok", "okay", "ey", "eh", "a", "he"]);

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export interface WakeMatch {
  matched: boolean;
  /** The words after the wake word (original capitalisation lost), "" when nothing follows. */
  rest: string;
}

/**
 * The wake word must be among the first two words (after fillers like "hey"/"oye"). One-edit tolerance for words of 5+ letters.
 * A name mentioned later in a sentence ("le dije a jarvis que…") does NOT wake it.
 */
export function matchWakeWord(transcript: string, words: readonly string[] = ["jarvis"]): WakeMatch {
  const original = transcript.trim().split(/\s+/).filter(Boolean);
  const tokens = original.map(norm);
  const targets = words.flatMap((w) => [norm(w), ...(VARIANTS[norm(w)] ?? [])]);
  for (let i = 0; i < Math.min(tokens.length, 3); i++) {
    const t = tokens[i]!;
    if (!t) continue;
    const isWake = targets.some((w) => t === w || (w.length >= 5 && t.length >= 5 && lev(t, w) <= 1));
    if (!isWake) continue;
    if (tokens.slice(0, i).some((x) => x && !FILLERS.has(x))) return { matched: false, rest: "" };
    // Keep the user's own spelling (accents, case) for the command that follows.
    const rest = original.slice(i + 1).join(" ").replace(/^[\s,.:;!?¡¿-]+/, "").replace(/^(por favor|please)[\s,]+/i, "").trim();
    return { matched: true, rest };
  }
  return { matched: false, rest: "" };
}
