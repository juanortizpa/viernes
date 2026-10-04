import type { TaskType } from "@jarvis/protocol";
import { normalizeText } from "./text";

export interface TaskClass {
  taskType: TaskType;
  /** 0..1 heuristic estimate; the learned router (Phase 6) replaces it. */
  complexity: number;
  /** The task needs to act on the machine (files, apps), so a model without tool calling cannot do it. */
  needsTools: boolean;
}

const BASE: Record<TaskType, number> = {
  local_action: 0,
  qa_simple: 0.15,
  explanation: 0.35,
  other: 0.4,
  research: 0.6,
  coding: 0.65,
  debugging: 0.7,
  agentic_project: 0.85,
};

const RULES: [TaskType, RegExp][] = [
  ["agentic_project", /\b(crea|construye|implementa|build|create|implement)\b.*\b(proyecto|app|aplicacion|project|application|repo)\b/],
  ["debugging", /\b(bug|error|exception|traceback|stack ?trace|falla|no funciona|crash|depura|debug|fix)\b/],
  ["coding", /```|\b(codigo|funcion|clase|script|refactor|compila|test|function|class|code|implement|sql|regex)\b/],
  ["research", /\b(investiga|compara|resume|analiza|research|compare|summari[sz]e|analy[sz]e|pros y contras|pros and cons)\b/],
  ["explanation", /\b(explica|por que|como funciona|explain|why|how does|how do)\b/],
];

const NEEDS_TOOLS = /\b(archivo|archivos|fichero|carpeta|directorio|file|files|folder|directory)\b|(?:^|\s)(?:[a-z]:\\|~\/|\.{1,2}\/|\/)[\w.-]+/;

/** Deterministic, LLM-free task typing (ES/EN). Cheap enough to run before routing. */
export function classifyTask(input: string): TaskClass {
  const text = normalizeText(input);
  let taskType: TaskType = "other";
  const hit = RULES.find(([, re]) => re.test(text));
  if (hit) taskType = hit[0];
  else if (text.length <= 100 && /^(que|quien|cual|cuando|donde|cuanto|what|who|which|when|where|how much)\b/.test(text)) taskType = "qa_simple";
  const complexity = Math.min(1, BASE[taskType] + Math.min(0.2, input.length / 5000));
  return { taskType, complexity: Math.round(complexity * 100) / 100, needsTools: taskType === "agentic_project" || NEEDS_TOOLS.test(text) };
}
