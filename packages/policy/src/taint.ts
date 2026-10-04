import type { Provenance } from "@jarvis/protocol";

/**
 * Per-task taint flag: once untrusted content is seen, the chain stays tainted. It also remembers the addresses the task has been
 * shown (in the user's message or in tool results), so the policy engine can tell following a link from inventing one (ADR-0028).
 */
export class TaintTracker {
  private tainted = false;
  private readonly destinations = new Set<string>();
  private readonly hosts = new Set<string>();

  /** `known`: addresses the user wrote themselves (already normalised by the caller). */
  constructor(known: Iterable<string> = []) {
    this.learnDestinations(known);
  }

  observe(provenance: Provenance): void {
    if (provenance === "untrusted_external") this.tainted = true;
  }

  get isTainted(): boolean {
    return this.tainted;
  }

  /** Addresses that appeared in a tool result. */
  learnDestinations(addresses: Iterable<string>): void {
    for (const a of addresses) {
      if (this.destinations.size >= 5_000) break;
      this.destinations.add(a);
      const host = hostOf(a);
      if (host) this.hosts.add(host);
    }
  }

  /**
   * The exact address was shown, or it is the bare home page (no path, no query) of a site that was shown: neither can carry data
   * the task picked up, since every part of it was already there.
   */
  knows(address: string): boolean {
    if (this.destinations.has(address)) return true;
    try {
      const u = new URL(address);
      return u.pathname === "/" && !u.search && !u.username && this.hosts.has(u.host.toLowerCase());
    } catch {
      return false;
    }
  }
}

function hostOf(address: string): string | undefined {
  try {
    return new URL(address).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
