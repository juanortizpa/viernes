import { z } from "zod";
import type { Tool } from "./types";

/**
 * Structural views of what the assistant keeps about the user (core implements them: `MemoryBook`, `ConversationMemory`).
 * Every tool here is the user's own command only (`modelCallable: false`): injected text in a page or file can never make the
 * model save, list, forget or switch memory (ADR-0005, ADR-0023).
 */
export interface MemoryShelfItem {
  id: string;
  kind: "fact" | "preference";
  text: string;
}

export interface MemoryShelf {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  list(): MemoryShelfItem[];
  add(text: string): { ok: true; item: MemoryShelfItem; duplicate: boolean } | { ok: false; message: string };
  forget(query: string): { ok: true; removed: MemoryShelfItem[] } | { ok: false; reason: "none" | "ambiguous" | "empty"; candidates: MemoryShelfItem[] };
  clear(): number;
}

export interface ConversationShelf {
  clear(): number;
}

/**
 * `alsoForget`: what else holds the forgotten text. The conversation in progress may still contain it ("recuerda que…" a minute
 * ago), and the model would keep "knowing" it for the rest of the chat; so forgetting a memory forgets the conversation too, and says so.
 */
export interface ForgetOptions {
  alsoForget?: () => void;
}
const ALSO = " También olvidé la conversación en curso, para que no quede en el contexto.";

export const makeMemoryAdd = (shelf: MemoryShelf): Tool<{ text: string }, unknown> => ({
  name: "memory.add",
  description: "Remember something the user explicitly asked to remember",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({ text: z.string().min(1).max(2000) }),
  async run({ text }) {
    const r = shelf.add(text);
    if (!r.ok) return { ok: false, summary: r.message, provenance: "system" };
    return { ok: true, summary: r.duplicate ? `Ya lo tenía: ${r.item.text}` : `Anotado: ${r.item.text}`, provenance: "system" };
  },
});

export const makeMemoryList = (shelf: MemoryShelf): Tool<Record<string, never>, unknown> => ({
  name: "memory.list",
  description: "List what the assistant remembers about the user",
  risk: "read",
  reversible: true,
  modelCallable: false,
  input: z.object({}).strict(),
  async run() {
    const items = shelf.list();
    const state = shelf.enabled ? "" : " (la memoria está desactivada)";
    if (items.length === 0) return { ok: true, summary: `No recuerdo nada de ti todavía${state}.`, provenance: "system" };
    return { ok: true, summary: `Recuerdo${state}: ${items.map((i) => i.text).join(" · ")}`, provenance: "system" };
  },
});

export const makeMemoryForget = (shelf: MemoryShelf, opts: ForgetOptions = {}): Tool<{ query: string }, unknown> => ({
  name: "memory.forget",
  description: "Forget one remembered item, by id or by describing it",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({ query: z.string().min(1).max(500) }),
  async run({ query }) {
    const r = shelf.forget(query);
    if (r.ok) {
      opts.alsoForget?.();
      return { ok: true, summary: `Olvidado: ${r.removed.map((i) => i.text).join(" · ")}.${opts.alsoForget ? ALSO : ""}`, provenance: "system" };
    }
    if (r.reason === "ambiguous") return { ok: false, summary: `Hay varios parecidos, no borré nada. ¿Cuál? ${r.candidates.map((i) => i.text).join(" · ")}`, provenance: "system" };
    return { ok: false, summary: "No encontré nada parecido en lo que recuerdo.", provenance: "system" };
  },
});

export const makeMemoryClear = (shelf: MemoryShelf, opts: ForgetOptions = {}): Tool<Record<string, never>, unknown> => ({
  name: "memory.clear",
  description: "Erase everything the assistant remembers about the user",
  risk: "sensitive",
  reversible: false,
  modelCallable: false,
  input: z.object({}).strict(),
  async run() {
    const n = shelf.clear();
    opts.alsoForget?.();
    return { ok: true, summary: `Memoria borrada (${n} recuerdo${n === 1 ? "" : "s"}).${opts.alsoForget ? ALSO : ""}`, provenance: "system" };
  },
});

export const makeMemoryToggle = (shelf: MemoryShelf): Tool<{ enabled: boolean }, unknown> => ({
  name: "memory.toggle",
  description: "Enable or disable long-term memory",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({ enabled: z.boolean() }),
  async run({ enabled }) {
    shelf.setEnabled(enabled);
    return { ok: true, summary: enabled ? "memoria activada" : "memoria desactivada", provenance: "system" };
  },
  async verify({ enabled }) {
    return shelf.enabled === enabled;
  },
});

export const makeConversationClear = (conversation: ConversationShelf): Tool<Record<string, never>, unknown> => ({
  name: "conversation.clear",
  description: "Forget the conversation in progress",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({}).strict(),
  async run() {
    const n = conversation.clear();
    return { ok: true, summary: n ? "Listo, empezamos de cero." : "No había conversación que olvidar.", provenance: "system" };
  },
});
