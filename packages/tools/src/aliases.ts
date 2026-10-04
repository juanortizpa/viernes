import { z } from "zod";
import type { Tool } from "./types";

/** Structural view of the app catalog (core implements it); keeps tools independent of core. */
export interface AliasBook {
  lookup(alias: string): string | undefined;
  learn(alias: string, command: string): boolean;
  forget(alias: string): boolean;
  learned(): { alias: string; command: string }[];
}

/** Sensitive on purpose: the policy engine makes the user confirm every new alias. */
export const makeAliasesLearn = (book: AliasBook): Tool<{ alias: string; command: string }, void> => ({
  name: "aliases.learn",
  description: "Remember an alias for an app that is already known to the system",
  risk: "sensitive",
  reversible: true,
  input: z.object({ alias: z.string().min(2).max(60), command: z.string().min(1).max(500) }),
  async run({ alias, command }) {
    const ok = book.learn(alias, command);
    return { ok, summary: ok ? `alias "${alias}" saved` : `cannot save alias "${alias}" (unknown app or reserved name)`, provenance: "system" };
  },
  async verify({ alias, command }) {
    return book.lookup(alias) === command;
  },
});

export const makeAliasesForget = (book: AliasBook): Tool<{ alias: string }, void> => ({
  name: "aliases.forget",
  description: "Forget an alias the user taught the assistant",
  risk: "reversible",
  reversible: true,
  input: z.object({ alias: z.string().min(1).max(60) }),
  async run({ alias }) {
    const ok = book.forget(alias);
    return { ok, summary: ok ? `alias "${alias}" forgotten` : `no learned alias "${alias}"`, provenance: "system" };
  },
});

export const makeAliasesList = (book: AliasBook): Tool<Record<string, never>, { alias: string; command: string }[]> => ({
  name: "aliases.list",
  description: "List the aliases the user taught the assistant",
  risk: "read",
  reversible: true,
  input: z.object({}).strict(),
  async run() {
    const items = book.learned();
    const summary = items.length ? items.map((a) => a.alias).join(", ") : "no learned aliases";
    return { ok: true, summary, output: items, provenance: "system" };
  },
});
