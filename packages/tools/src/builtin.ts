import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

export const timeNow: Tool<Record<string, never>, string> = {
  name: "time.now",
  description: "Current local date and time",
  risk: "read",
  reversible: true,
  input: z.object({}).strict(),
  async run() {
    const d = new Date();
    const local = d.toLocaleString("es", { dateStyle: "full", timeStyle: "medium" });
    return { ok: true, summary: local, output: `${local} (${d.toISOString()})`, provenance: "system" };
  },
};

export const timeDate: Tool<{ offsetDays: number }, string> = {
  name: "time.date",
  description: "Local calendar date (weekday included) for today plus an offset in days (1 = tomorrow, -1 = yesterday)",
  risk: "read",
  reversible: true,
  input: z.object({ offsetDays: z.number().int().min(-3650).max(3650).default(0) }),
  async run({ offsetDays }) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const text = d.toLocaleDateString("es", { dateStyle: "full" });
    return { ok: true, summary: text, output: text, provenance: "system" };
  },
};

export const filesRead: Tool<{ path: string }, string> = {
  name: "files.read",
  description: "Read a UTF-8 text file",
  risk: "read",
  reversible: true,
  input: z.object({ path: z.string().min(1) }),
  async run({ path }) {
    try {
      const text = await readFile(path, "utf8");
      // File contents are untrusted: they may carry prompt injection.
      return { ok: true, summary: `read ${text.length} chars from ${path}`, output: text, provenance: "untrusted_external" };
    } catch (e) {
      return { ok: false, summary: `cannot read ${path}: ${(e as Error).message}`, provenance: "system" };
    }
  },
};

export const filesWrite: Tool<{ path: string; content: string }, void> = {
  name: "files.write",
  description: "Write a UTF-8 text file, overwriting it",
  risk: "sensitive",
  reversible: false,
  input: z.object({ path: z.string().min(1), content: z.string() }),
  async run({ path, content }) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return { ok: true, summary: `wrote ${content.length} chars to ${path}`, provenance: "system" };
    } catch (e) {
      return { ok: false, summary: `cannot write ${path}: ${(e as Error).message}`, provenance: "system" };
    }
  },
  async verify({ path, content }) {
    return (await readFile(path, "utf8").catch(() => null)) === content;
  },
};

/** The OS-specific launcher is injected (Windows shell lives in the sidecar's host layer). */
export type AppLauncher = (app: string) => Promise<void>;

export const makeAppsOpen = (launch: AppLauncher): Tool<{ app: string }, void> => ({
  name: "apps.open",
  description: "Open an application by name",
  risk: "reversible",
  reversible: true,
  input: z.object({ app: z.string().min(1) }),
  async run({ app }) {
    try {
      await launch(app);
      return { ok: true, summary: `opened ${app}`, provenance: "system" };
    } catch (e) {
      return { ok: false, summary: `cannot open ${app}: ${(e as Error).message}`, provenance: "system" };
    }
  },
});
