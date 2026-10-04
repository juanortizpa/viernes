import { MemoryAliasStore, type AliasStore } from "./alias-store";
import { normalizeText, phoneticKey } from "./text";

export type AliasSource = "scan" | "learned" | "config";
/** A higher source is never overwritten by a lower one. */
const PRIORITY: Record<AliasSource, number> = { scan: 1, learned: 2, config: 3 };

interface Entry {
  command: string;
  source: AliasSource;
}

export interface AppSuggestion {
  alias: string;
  command: string;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * alias -> launch command. Commands only ever come from the user's config or from the OS app scan;
 * a learned alias can point at a known command but can never introduce a new one.
 */
export class AppCatalog {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly store: AliasStore = new MemoryAliasStore(), private readonly now: () => number = Date.now) {}

  static fromRecord(apps: Record<string, string>): AppCatalog {
    const c = new AppCatalog();
    for (const [alias, command] of Object.entries(apps)) c.add(alias, command, "config");
    return c;
  }

  add(alias: string, command: string, source: AliasSource): boolean {
    const key = normalizeText(alias);
    if (!key || !command) return false;
    const existing = this.entries.get(key);
    if (existing && PRIORITY[existing.source] >= PRIORITY[source]) return false;
    this.entries.set(key, { command, source });
    return true;
  }

  /** Load persisted aliases; ones whose command is no longer known (app uninstalled, config changed) are ignored. */
  restore(): void {
    for (const a of this.store.list()) if (this.hasCommand(a.command)) this.add(a.alias, a.command, "learned");
  }

  /** How many distinct apps can be opened (several names may launch the same one). */
  appCount(): number {
    return new Set([...this.entries.values()].map((e) => e.command)).size;
  }

  lookup(alias: string): string | undefined {
    return this.entries.get(normalizeText(alias))?.command;
  }

  hasCommand(command: string): boolean {
    for (const e of this.entries.values()) if (e.command === command) return true;
    return false;
  }

  /**
   * A single unambiguous near-match for an unknown alias: it is a substring of exactly one known
   * app ("chrome" -> "google chrome") or a one-letter typo of it. Ambiguity returns undefined.
   */
  suggest(alias: string): AppSuggestion | undefined {
    const q = normalizeText(alias);
    if (q.length < 3 || this.entries.has(q)) return undefined;
    const hits: AppSuggestion[] = [];
    for (const [a, e] of this.entries) {
      if (a.includes(q) || (q.length >= 4 && editDistance(a, q) <= 1)) hits.push({ alias: a, command: e.command });
    }
    if (hits.length === 0) {
      // Sounds-like fallback for speech-recognition slips: same phonetic key, or one/two phonetic edits on longer names.
      const qk = phoneticKey(q);
      for (const [a, e] of this.entries) {
        const ak = phoneticKey(a);
        const d = ak === qk ? 0 : Math.min(ak.length, qk.length) >= 5 ? editDistance(ak, qk) : 99;
        if (d === 0 || (d <= 1 && qk.length >= 5) || (d <= 2 && qk.length >= 9)) hits.push({ alias: a, command: e.command });
      }
    }
    if (new Set(hits.map((h) => h.command)).size !== 1) return undefined;
    return hits.sort((x, y) => x.alias.length - y.alias.length)[0];
  }

  /** Persist a user-confirmed alias. Refuses unknown commands and names owned by the config. */
  learn(alias: string, command: string): boolean {
    const key = normalizeText(alias);
    if (key.length < 2 || !this.hasCommand(command)) return false;
    if (!this.add(key, command, "learned")) return this.entries.get(key)?.source === "learned" && this.entries.get(key)?.command === command;
    this.store.save({ alias: key, command, createdAt: this.now() });
    return true;
  }

  forget(alias: string): boolean {
    const key = normalizeText(alias);
    if (this.entries.get(key)?.source !== "learned") return false;
    this.entries.delete(key);
    this.store.remove(key);
    return true;
  }

  learned(): { alias: string; command: string }[] {
    return [...this.entries].filter(([, e]) => e.source === "learned").map(([alias, e]) => ({ alias, command: e.command }));
  }
}
