/**
 * What gets said out loud. Spoken output must be short and free of markup: reading a table or a code block aloud is
 * noise, so those stay on screen and the speech says so.
 */

export type Lang = "es" | "en";

// Same idea as detectLanguage in @jarvis/core (not importable here: core pulls in node-only modules).
const ES_HINT = /[áéíóúñ¿¡]|\b(el|la|los|las|un|una|que|por|para|con|mi|tu|de|en|es|y|hola|gracias|listo|abre|crea|escribe|explica)\b/i;
const EN_HINT = /\b(the|a|an|to|of|and|is|are|my|me|please|hello|hi|hey|thanks|done|open|create|write|explain|how|can|could|help|you|your|what|where|when|why|who|i|it|do|does|this|that|with|for|on|in|at|have|has|will|would|welcome)\b/i;

export function detectLang(text: string): Lang {
  const es = ES_HINT.test(text);
  const en = EN_HINT.test(text);
  return en && !es ? "en" : "es";
}

const MAX_CHARS = 280;
const MAX_SENTENCES = 3;

export interface Speakable {
  text: string;
  /** The answer had more than what is spoken (shown on screen). */
  truncated: boolean;
  /** The answer contained code or a table, which is never read aloud. */
  skippedStructured: boolean;
}

const SKIP_NOTE: Record<Lang, string> = { es: "Te dejé el detalle en pantalla.", en: "I left the details on screen." };

/** Markdown -> plain speech: no code, no tables, no URLs, no symbols; first few sentences only. */
export function speakable(markdown: string, lang: Lang = detectLang(markdown)): Speakable {
  let skipped = false;
  let t = markdown
    .replace(/```[\s\S]*?(```|$)/g, () => ((skipped = true), " "))
    .replace(/^\s*\|.*\|\s*$/gm, () => ((skipped = true), " ")) // table rows
    .replace(/^\s*[-|: ]{3,}\s*$/gm, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, lang === "es" ? "un enlace" : "a link")
    .replace(/^\s{0,3}#{1,6}\s*(.+?)\s*$/gm, (_m, h: string) => (/[.!?…:]$/.test(h) ? h : `${h}.`)) // a heading is its own sentence
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>#]+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return { text: skipped ? SKIP_NOTE[lang] : "", truncated: false, skippedStructured: skipped };

  const sentences = t.match(/.+?(?:[.!?…]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];
  let out = "";
  let n = 0;
  for (const s of sentences) {
    if (n >= MAX_SENTENCES || (out && out.length + s.length + 1 > MAX_CHARS)) break;
    out += (out ? " " : "") + s;
    n++;
  }
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") + "…"; // a single huge sentence
  const truncated = out.replace(/…$/, "").length < t.length;
  if (truncated || skipped) out += ` ${SKIP_NOTE[lang]}`;
  return { text: out, truncated, skippedStructured: skipped };
}

/** Local tools return English machine summaries ("opened calc"); say something a person would. */
export function localConfirmation(intent: string | undefined, ok: boolean, summary: string | undefined, lang: Lang = "es"): string | undefined {
  // The coding agent's summary is already a short Spanish report, and on failure it says why: worth hearing either way.
  if (intent === "code.agent" && summary) return speakable(summary.replace(/\s*\([^)]*\)\s*$/, ""), lang).text;
  if (!ok) return lang === "es" ? "No pude completarlo." : "I couldn't do that.";
  switch (intent) {
    case "time.now":
    case "time.date":
      return summary ? speakable(summary, lang).text : undefined;
    case "apps.open":
      return lang === "es" ? "Listo." : "Done.";
    case "aliases.list":
    case "instant.list":
    case "style.show":
      return summary ? speakable(summary, lang).text : undefined;
    default:
      return lang === "es" ? "Listo." : "Done.";
  }
}
