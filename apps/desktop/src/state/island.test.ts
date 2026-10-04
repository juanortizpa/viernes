import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@jarvis/protocol";
import type { EventBody as Body } from "../demo/scenarios";
import { initialState, islandReducer, type IslandState } from "./island";

let n = 0;
const ev = (body: Body): OrchestratorEvent => ({ id: `e${n}`, taskId: "t", seq: n++, ts: n, ...body }) as OrchestratorEvent;
const run = (events: Body[], from: IslandState = initialState) =>
  events.reduce((s, b) => islandReducer(s, { kind: "event", event: ev(b) }), from);

describe("islandReducer", () => {
  it("local intent shows zero tokens and ends in success", () => {
    const s = run([
      { type: "task.started", input: "abre vscode", modality: "text" },
      { type: "intent.resolved", route: "local", intent: "open_application", confidence: 0.98 },
      { type: "task.finished", outcome: "success" },
    ]);
    expect(s.mode).toBe("success");
    expect(s.route).toBe("local");
    expect(s.tokens).toBe(0);
    expect(s.costUsd).toBe(0);
  });

  it("a model answer stays visible when the task finishes (only the final attempt's text)", () => {
    const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, estimatedCostUsd: 0, latencyMs: 300 };
    const s = run([
      { type: "task.started", input: "por qué el cielo es azul", modality: "text" },
      { type: "response.delta", text: "respuesta " },
      { type: "response.delta", text: "abandonada" },
      { type: "escalated", from: "a", to: "b", reason: "HTTP 429" },
      { type: "response.delta", text: "Por la dispersión " },
      { type: "response.delta", text: "de Rayleigh." },
      { type: "model.completed", model: "b", usage },
      { type: "eval.completed", verdict: { outcome: "success", confidence: 0.6, evaluator: "heuristic", evidence: "non-empty" } },
      { type: "task.finished", outcome: "success" },
    ]);
    expect(s.headline).toBe("Listo");
    expect(s.detail).toBe("Por la dispersión de Rayleigh.");
    // An explicit summary (local actions, cached answers) still wins.
    expect(run([{ type: "task.finished", outcome: "success", summary: "abrí paint" }], s).detail).toBe("abrí paint");
  });

  it("shows memory/context only when the event says it went into the prompt, and starts clean on the next task", () => {
    const used = run([
      { type: "task.started", input: "regalo para mi hermana", modality: "text" },
      { type: "context.used", conversationTurns: 2, memories: ["a1", "b2"] },
    ]);
    expect(used.context).toEqual({ turns: 2, memories: 2 });
    expect(run([{ type: "task.started", input: "otra cosa", modality: "text" }], used).context).toBeUndefined();
    expect(run([{ type: "task.started", input: "x", modality: "text" }]).context).toBeUndefined();
  });

  it("permission request sets pending and mode; denial warns and clears it", () => {
    const asked = run([
      { type: "task.started", input: "x", modality: "text" },
      { type: "permission.required", requestId: "r1", tool: "run_command", risk: "sensitive", reason: "edita archivos" },
    ]);
    expect(asked.mode).toBe("permission");
    expect(asked.pending?.requestId).toBe("r1");
    const denied = run([{ type: "permission.resolved", requestId: "r1", granted: false }], asked);
    expect(denied.mode).toBe("warning");
    expect(denied.pending).toBeUndefined();
  });

  it("accumulates usage and counts escalations", () => {
    const usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, estimatedCostUsd: 0.01, latencyMs: 500 };
    const s = run([
      { type: "task.started", input: "x", modality: "text" },
      { type: "model.completed", model: "a", usage },
      { type: "escalated", from: "a", to: "b", reason: "tests failed" },
      { type: "model.completed", model: "b", usage },
    ]);
    expect(s.tokens).toBe(300);
    expect(s.costUsd).toBeCloseTo(0.02);
    expect(s.escalations).toBe(1);
    expect(s.model).toBe("b");
  });

  it("a new answer replaces the previous detail instead of appending to it", () => {
    const e = (event: object, seq: number) => ({ kind: "event", event: { id: String(seq), taskId: "t", seq, ts: seq, ...event } }) as never;
    let st = islandReducer(initialState, e({ type: "route.decided", decision: { kind: "model", model: "a", strategy: "s", taskType: "other", complexity: 0, candidates: [], propensity: 1, explored: false, rationale: "razón" } }, 0));
    st = islandReducer(st, e({ type: "response.delta", text: "Hola " }, 1));
    st = islandReducer(st, e({ type: "response.delta", text: "mundo" }, 2));
    expect(st.detail).toBe("Hola mundo");
    st = islandReducer(st, e({ type: "escalated", from: "a", to: "b", reason: "vacío" }, 3));
    st = islandReducer(st, e({ type: "response.delta", text: "Segunda" }, 4));
    expect(st.detail).toBe("Segunda");
  });

  it("only shows a progress fraction when an event provided one", () => {
    const none = run([{ type: "task.started", input: "x", modality: "text" }, { type: "progress", stage: "indexando" }]);
    expect(none.fraction).toBeUndefined();
    const some = run([{ type: "progress", stage: "indexando", fraction: 0.4 }], none);
    expect(some.fraction).toBe(0.4);
  });

  it("instant replies and acks are labelled as such and are not model progress", () => {
    const reply = run([
      { type: "task.started", input: "hola", modality: "text" },
      { type: "intent.resolved", route: "local", intent: "instant.reply", confidence: 1 },
      { type: "instant.issued", kind: "reply", text: "¡Hola!" },
      { type: "task.finished", outcome: "success", summary: "¡Hola!" },
    ]);
    expect(reply).toMatchObject({ mode: "success", route: "local", tokens: 0, costUsd: 0, detail: "¡Hola!" });
    const ack = run([{ type: "task.started", input: "x", modality: "text" }, { type: "instant.issued", kind: "ack", text: "Entendido" }]);
    expect(ack).toMatchObject({ mode: "thinking", headline: "Recibido", detail: "Entendido" });
    expect(ack.fraction).toBeUndefined();
  });

  it("reset returns to idle", () => {
    expect(islandReducer({ ...initialState, mode: "error" }, { kind: "reset" })).toEqual(initialState);
  });
});

describe("islandReducer voice states (real mic / STT, not orchestrator progress)", () => {
  it("does not say 'listening' until the microphone is really open", () => {
    const s = islandReducer(initialState, { kind: "voice.preparing" });
    expect(s).toMatchObject({ mode: "thinking", headline: "Preparando micrófono…" });
    expect(islandReducer(s, { kind: "voice.recording" })).toMatchObject({ mode: "listening", headline: "Escuchando…" });
  });

  it("listening follows the real input level and a new task clears it", () => {
    let s = islandReducer(initialState, { kind: "voice.recording" });
    expect(s).toMatchObject({ mode: "listening", level: 0 });
    s = islandReducer(s, { kind: "voice.level", level: 0.6 });
    expect(s.level).toBe(0.6);
    s = islandReducer(s, { kind: "voice.transcribing" });
    expect(s).toMatchObject({ mode: "thinking", headline: "Transcribiendo…" });
    expect(s.level).toBeUndefined();
    expect(islandReducer(s, { kind: "voice.level", level: 0.9 }).level).toBeUndefined(); // late chunk ignored
    s = islandReducer(s, { kind: "voice.heard", text: "abre vscode" });
    expect(s).toMatchObject({ headline: "Escuché", detail: "abre vscode" });
  });

  it("shows what was understood and, when it was interpreted, what was literally heard", () => {
    expect(islandReducer(initialState, { kind: "voice.heard", text: "abre la calculadora", engine: "groq:whisper-large-v3-turbo" })).toMatchObject({ headline: "Escuché (nube)", detail: "abre la calculadora" });
    expect(islandReducer(initialState, { kind: "voice.heard", text: "abrime el bloc de notas por favor", heard: "abrimos el bloc de notas puesto bar", engine: "gemini:x" })).toMatchObject({ headline: "Entendí", detail: "abrime el bloc de notas por favor · (oí: «abrimos el bloc de notas puesto bar»)" });
    expect(islandReducer(initialState, { kind: "voice.heard", text: "hola", engine: "local" })).toMatchObject({ headline: "Escuché" });
  });

  it("a rejected clip warns and is not shown as success", () => {
    expect(islandReducer(initialState, { kind: "voice.rejected", message: "No se detectó voz" })).toMatchObject({ mode: "warning", headline: "No se detectó voz" });
  });
});

describe("islandReducer hands-free states (driven by the real listening loop)", () => {
  it("shows 'listening' only while the loop waits for the user, and releases the pose afterwards", () => {
    let s = islandReducer(initialState, { kind: "wake", state: "idle" });
    expect(s).toMatchObject({ mode: "idle", wake: { state: "idle" } }); // armed but quiet: just the indicator dot
    s = islandReducer(s, { kind: "wake", state: "command" });
    expect(s).toMatchObject({ mode: "listening", headline: "Dime…" });
    s = islandReducer(s, { kind: "voice.level", level: 0.5 });
    expect(s.level).toBe(0.5);
    s = islandReducer(s, { kind: "wake", state: "busy" });
    expect(s).toMatchObject({ mode: "idle", wake: { state: "busy" } });
    s = islandReducer(s, { kind: "wake", state: "followUp", followUpMs: 10_000 });
    expect(s).toMatchObject({ mode: "listening", headline: "Te escucho…", wake: { followUpMs: 10_000 } });
    s = islandReducer(s, { kind: "wake", state: "followUp", followUpMs: 4_000 });
    expect(s.wake?.followUpMs).toBe(4_000);
    s = islandReducer(s, { kind: "wake", state: "off" });
    expect(s).toMatchObject({ mode: "idle", wake: { state: "off" } });
  });

  it("does not disturb a running task, and wake/speaking survive task start and reset", () => {
    let s = islandReducer(initialState, { kind: "wake", state: "idle" });
    s = islandReducer(s, { kind: "speech", speaking: true });
    s = run([{ type: "task.started", input: "x", modality: "voice" }], s);
    expect(s).toMatchObject({ mode: "thinking", speaking: true, wake: { state: "idle" } });
    s = islandReducer(s, { kind: "wake", state: "busy" });
    expect(s.mode).toBe("thinking");
    s = islandReducer(s, { kind: "reset" });
    expect(s).toMatchObject({ mode: "idle", speaking: true, wake: { state: "busy" } });
  });

  it("collapsing the island after a task keeps showing that the follow-up window is still open", () => {
    let s = islandReducer(initialState, { kind: "wake", state: "followUp", followUpMs: 6_000 });
    s = islandReducer({ ...s, mode: "success", headline: "Listo" }, { kind: "reset" });
    expect(s).toMatchObject({ mode: "listening", headline: "Te escucho…", wake: { state: "followUp" } });
    s = islandReducer(s, { kind: "wake", state: "idle" });
    expect(s).toMatchObject({ mode: "idle", headline: "JARVIS" });
  });
});
