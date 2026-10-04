import { runCodeTests, extractCode } from "./sandbox";
import type { EvalTask, Grade } from "./types";

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[*_`"'«».,;:!¡¿?()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Some reasoning models inline their thoughts; the answer is what follows. */
const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, "");

function lastNumber(text: string): number | undefined {
  // A "," or "." followed by exactly 3 digits is read as a thousands separator ("1,234"), so suite answers avoid 3-decimal numbers.
  const cleaned = text.replace(/(\d)[,.](?=\d{3}(?!\d))/g, "$1");
  const all = [...cleaned.matchAll(/-?\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
  return all.length ? all[all.length - 1] : undefined;
}

/** Deterministic grading of one response against its task's ground truth. */
export async function grade(task: Pick<EvalTask, "check">, rawResponse: string): Promise<Grade> {
  const response = stripThinking(rawResponse).trim();
  if (!response) return { pass: false, detail: "empty response" };
  const check = task.check;
  switch (check.kind) {
    case "exact": {
      const want = norm(check.answer);
      const lines = response.split("\n").map(norm).filter(Boolean);
      const ok = norm(response) === want || lines[lines.length - 1] === want;
      return { pass: ok, detail: ok ? "exact" : `expected "${check.answer}"` };
    }
    case "contains_all": {
      const hay = norm(response);
      const missing = check.values.filter((v) => !hay.includes(norm(v)));
      return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" };
    }
    case "regex": {
      const ok = new RegExp(check.pattern, check.flags).test(response);
      return { pass: ok, detail: ok ? "matches" : `no match for /${check.pattern}/` };
    }
    case "number": {
      const got = lastNumber(response);
      const ok = got !== undefined && Math.abs(got - check.value) <= check.tolerance;
      return { pass: ok, detail: ok ? "number ok" : `expected ${check.value}, got ${got ?? "no number"}` };
    }
    case "code_tests": {
      const code = extractCode(response);
      if (!code) return { pass: false, detail: "no code block" };
      return runCodeTests(code, check.tests);
    }
  }
}
