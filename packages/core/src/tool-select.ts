import type { ToolDescriptor } from "@jarvis/protocol";
import { normalizeText } from "./text";

/**
 * Which tools to offer the model for ONE request (ADR-0029). Every tool definition is sent with every model call: measured, the
 * full set was ~1,300 input tokens — most of a simple question's prompt — and Groq's free tier allows ~8,000 tokens per minute, so
 * offering everything every time is what made 429s (and slow escalations) frequent. A small core is always offered; the rest only
 * when the words of the request (or the conversation) point at them. Deterministic, cheap, conservative.
 */
const CORE = new Set(["web.search", "web.fetch", "apps.open", "time.now", "time.date"]);

const TRIGGERS: [RegExp, RegExp][] = [
  [/^files\./, /\b(archivo|archivos|fichero|carpeta|directorio|documento|leer|lee|escrib|guard|file|folder|txt|json|csv|md)\b|[a-z]:\\|\.\/|~\//],
  [/^code\./, /\b(codigo|programa|programar|proyecto|repo|repositorio|bug|error|test|tests|prueba|pruebas|script|funcion|refactor|agente|gemini|claude|arregl|implement|compil|commit|cambio|cambios|deshac)\w*/],
  [/^aliases\./, /\b(alias|apodo|llamar|llamo|nombre de la app|aprend)\w*/],
  [/^instant\./, /\b(respuestas guardadas|cache|guardad)\w*/],
  [/^style\./, /\b(estilo|como hablo|tono|registro)\b/],
  [/^memory\./, /\b(recuerd|memoria|olvid|sabes de mi)\w*/],
  [/^assistant\./, /\b(que (puedes|podes|sabes) hacer|ayuda|herramientas|capacidades|funciones)\b/],
];

/** Lowercase words of 4+ letters, accents removed. */
const words = (s: string): Set<string> => new Set(normalizeText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

export function selectTools(tools: readonly ToolDescriptor[], request: string): ToolDescriptor[] {
  const text = normalizeText(request);
  const asked = words(request);
  return tools.filter((t) => {
    if (CORE.has(t.name)) return true;
    const rule = TRIGGERS.find(([name]) => name.test(t.name));
    if (rule) return rule[1].test(text);
    if (t.name.startsWith("mcp.")) {
      // An MCP tool is offered when the request names its server or shares a meaningful word with the tool's name/description.
      const server = t.name.split(".")[1] ?? "";
      if (text.includes(normalizeText(server))) return true;
      const own = words(`${t.name.replace(/[._]/g, " ")} ${t.description}`);
      for (const w of asked) if (own.has(w)) return true;
      return false;
    }
    return true; // unknown kinds of tools: offer (never hide something we cannot reason about)
  });
}

/** JSON Schema as the model needs it: without `$schema` and other metadata that only costs tokens. */
export function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema" || k === "$id" || k === "examples" || k === "$comment") continue;
    if (k === "additionalProperties" && v === false) continue;
    out[k] = compactSchema(v);
  }
  return out;
}
