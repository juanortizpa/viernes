import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cell } from "./types";

const key = (taskId: string, model: string): string => `${taskId}\u0000${model}`;

/** Append-only JSONL of counterfactual cells. Re-running resumes: only missing or errored cells are computed again. */
export class CellTable {
  private readonly cells = new Map<string, Cell>();

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim()) this.set(JSON.parse(line) as Cell);
      }
    }
  }

  private set(c: Cell): void {
    this.cells.set(key(c.taskId, c.model), c); // later lines win, so a retry supersedes an error cell
  }

  add(c: Cell): void {
    this.set(c);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(c) + "\n");
    }
  }

  get(taskId: string, model: string): Cell | undefined {
    return this.cells.get(key(taskId, model));
  }

  /** A cell that carries evidence about the model (not a transport failure). */
  hasResult(taskId: string, model: string): boolean {
    const c = this.get(taskId, model);
    return c !== undefined && c.error === undefined;
  }

  all(): Cell[] {
    return [...this.cells.values()];
  }
}
