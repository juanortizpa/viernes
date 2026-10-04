export interface LearnedAlias {
  alias: string;
  command: string;
  createdAt: number;
}

/** Durable home of aliases the user confirmed. Synchronous like the trace stores. */
export interface AliasStore {
  list(): LearnedAlias[];
  save(a: LearnedAlias): void;
  remove(alias: string): void;
}

export class MemoryAliasStore implements AliasStore {
  private readonly items = new Map<string, LearnedAlias>();
  list(): LearnedAlias[] {
    return [...this.items.values()];
  }
  save(a: LearnedAlias): void {
    this.items.set(a.alias, a);
  }
  remove(alias: string): void {
    this.items.delete(alias);
  }
}
