import { z } from "zod";
import type { Tool } from "./types";

/** Structural view of the style tracker (core implements it). */
export interface StyleBook {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  describe(): string;
  reset(): void;
}

export const makeStyleShow = (book: StyleBook): Tool<Record<string, never>, unknown> => ({
  name: "style.show",
  description: "Describe what the assistant has learned about how the user talks",
  risk: "read",
  reversible: true,
  input: z.object({}).strict(),
  async run() {
    return { ok: true, summary: book.describe(), provenance: "system" };
  },
});

export const makeStyleReset = (book: StyleBook): Tool<Record<string, never>, unknown> => ({
  name: "style.reset",
  description: "Forget everything learned about how the user talks",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({}).strict(),
  async run() {
    book.reset();
    return { ok: true, summary: "estilo olvidado", provenance: "system" };
  },
});

export const makeStyleToggle = (book: StyleBook): Tool<{ enabled: boolean }, unknown> => ({
  name: "style.toggle",
  description: "Enable or disable learning and applying the user's speaking style",
  risk: "reversible",
  reversible: true,
  modelCallable: false,
  input: z.object({ enabled: z.boolean() }),
  async run({ enabled }) {
    book.setEnabled(enabled);
    return { ok: true, summary: enabled ? "aprendizaje de estilo activado" : "aprendizaje de estilo desactivado", provenance: "system" };
  },
  async verify({ enabled }) {
    return book.enabled === enabled;
  },
});
