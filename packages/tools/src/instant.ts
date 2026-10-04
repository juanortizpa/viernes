import { z } from "zod";
import type { Tool } from "./types";

/** Structural view of the semantic cache (core implements it); keeps tools independent of core. */
export interface InstantBook {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  list(): { id: string; input: string; response: string; seen: number; hits: number; servable: boolean }[];
  forget(idOrText: string): number;
  clear(): number;
}

/** The user's control over what the assistant remembers (ADR-0015): see, delete, disable. */
export const makeInstantList = (book: InstantBook): Tool<Record<string, never>, unknown> => ({
  name: "instant.list",
  description: "List the question/answer pairs stored in the local instant-answer cache",
  risk: "read",
  reversible: true,
  input: z.object({}).strict(),
  async run() {
    const items = book.list().map(({ id, input, seen, hits, servable }) => ({ id, input, seen, hits, servable }));
    const state = book.enabled ? "activo" : "desactivado";
    const summary = items.length ? `${items.length} guardadas (${state}): ${items.slice(0, 5).map((i) => `"${i.input}"`).join(", ")}` : `ninguna guardada (${state})`;
    return { ok: true, summary, output: items, provenance: "system" };
  },
});

export const makeInstantForget = (book: InstantBook): Tool<{ query: string }, unknown> => ({
  name: "instant.forget",
  description: "Delete cached answers whose question matches the given text (or id)",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({ query: z.string().min(3).max(200) }),
  async run({ query }) {
    const n = book.forget(query);
    return { ok: n > 0, summary: n > 0 ? `${n} respuesta(s) olvidada(s)` : "no había respuestas guardadas que coincidan", provenance: "system" };
  },
});

/** Sensitive on purpose: bulk deletion needs the user's confirmation. */
export const makeInstantClear = (book: InstantBook): Tool<Record<string, never>, unknown> => ({
  name: "instant.clear",
  description: "Delete every answer in the local instant-answer cache",
  risk: "sensitive",
  reversible: false,
  modelCallable: false,
  input: z.object({}).strict(),
  async run() {
    const n = book.clear();
    return { ok: true, summary: `${n} respuesta(s) borrada(s)`, provenance: "system" };
  },
  async verify() {
    return book.list().length === 0;
  },
});

export const makeInstantToggle = (book: InstantBook): Tool<{ enabled: boolean }, unknown> => ({
  name: "instant.toggle",
  description: "Enable or disable serving and learning of cached answers",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({ enabled: z.boolean() }),
  async run({ enabled }) {
    book.setEnabled(enabled);
    return { ok: true, summary: enabled ? "respuestas guardadas activadas" : "respuestas guardadas desactivadas", provenance: "system" };
  },
  async verify({ enabled }) {
    return book.enabled === enabled;
  },
});
