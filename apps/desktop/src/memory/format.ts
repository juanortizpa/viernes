import type { MemorySnapshot } from "../live/client";

export interface MemoryView {
  summary: string;
  items: { id: string; kind: "fact" | "preference"; kindLabel: string; text: string; usage: string }[];
  privacy: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Wording for the memory panel, derived only from what the sidecar reported. */
export function memoryView(m: MemorySnapshot, now: number = Date.now()): MemoryView {
  const chat = m.conversationTurns > 0 ? `En esta conversación llevo ${plural(m.conversationTurns, "intercambio", "intercambios")} (no se guardan en disco).` : "Esta conversación aún no tiene contexto.";
  const state = m.enabled ? "" : " La memoria está desactivada: no guardo ni uso recuerdos.";
  const stored = m.items.length === 0 ? "No me pediste recordar nada." : `Recuerdo ${plural(m.items.length, "cosa", "cosas")}.`;
  return {
    summary: `${stored}${state} ${chat}`,
    items: m.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      kindLabel: i.kind === "preference" ? "Preferencia" : "Dato",
      text: i.text,
      usage: i.uses === 0 ? "aún no usado" : `usado ${plural(i.uses, "vez", "veces")}${i.usedAt ? `, ${ago(now - i.usedAt)}` : ""}`,
    })),
    privacy: "Lo que sea relevante para tu pregunta viaja con ella al modelo que responde (si es en la nube, sale de tu equipo). Las preferencias se aplican siempre. Nunca guardo contraseñas ni números de tarjeta.",
  };
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}
