import type { Provenance } from "@jarvis/protocol";

/** Per-task taint flag: once untrusted content is seen, the chain stays tainted. */
export class TaintTracker {
  private tainted = false;
  observe(provenance: Provenance): void {
    if (provenance === "untrusted_external") this.tainted = true;
  }
  get isTainted(): boolean {
    return this.tainted;
  }
}
