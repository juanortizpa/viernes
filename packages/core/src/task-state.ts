export type TaskState = "created" | "routing" | "awaiting_permission" | "running" | "finished";

const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  created: ["routing", "finished"],
  routing: ["awaiting_permission", "running", "finished"],
  awaiting_permission: ["running", "finished"],
  running: ["running", "finished"],
  finished: [],
};

export class TaskMachine {
  private current: TaskState = "created";
  get state(): TaskState {
    return this.current;
  }
  to(next: TaskState): void {
    if (!ALLOWED[this.current].includes(next)) throw new Error(`invalid task transition ${this.current} -> ${next}`);
    this.current = next;
  }
}
