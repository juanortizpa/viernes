import type { ModelCapabilities } from "@jarvis/protocol";
import type { Provider } from "./types";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(p: Provider): this {
    if (this.providers.has(p.id)) throw new Error(`provider already registered: ${p.id}`);
    this.providers.set(p.id, p);
    return this;
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  capabilities(): ModelCapabilities[] {
    return [...this.providers.values()].flatMap((p) => p.capabilities());
  }
}
