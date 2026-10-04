/**
 * Latency bench (ADR-0029): replays the user's recordings (.jarvis/bench/*.wav, made with «Prueba de transcripción») IN REAL TIME
 * against the real sidecar (config, keys, models), and measures from the END of the audio — the moment the user stops talking — to:
 * the transcript, the first thing that can be spoken (acknowledgement or local reply), and the first complete sentence of the answer.
 * Compares the old path (whole clip after release) with streaming + speculation. Uses free tiers: it paces itself.
 *
 *   pnpm --filter @jarvis/sidecar latency [--clips 8] [--filter dsp-on] [--modes old,ptt,handsfree] [--gap 6000]
 *
 * Modes: "old" = whole clip after release (before ADR-0029); "ptt" = streamed push-to-talk, released when the clip ends;
 * "handsfree" = streamed, then real silence until the turn closes (900 ms, or 450 ms after a semantic end-of-turn hint), measured
 * from the end of the speech.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "@jarvis/core";
import type { ServerMessage } from "@jarvis/ipc";
import { decodeWav, resample } from "@jarvis/voice";
import { loadConfig } from "./config";
import { buildRuntime } from "./runtime";
import { SidecarServer } from "./server";

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const root = join(import.meta.dirname, "..", "..", "..");
const env: Record<string, string | undefined> = { ...process.env };
try {
  for (const l of readFileSync(join(root, "jarvis.env"), "utf8").split(/\r?\n/)) if (/^[A-Z_]+=/.test(l)) env[l.slice(0, l.indexOf("="))] ??= l.slice(l.indexOf("=") + 1).trim();
} catch {
  /* keys may come from the environment */
}
const config = loadConfig(join(root, "jarvis.config.json"));
const runtime = buildRuntime({ ...config, scanApps: false }, { env, launcher: async () => {}, codingAgents: () => [] });
const dir = join(root, ".jarvis", "bench");
const clips = readdirSync(dir)
  .filter((f) => f.endsWith(".wav") && new RegExp(arg("filter", ".")).test(f))
  .slice(0, Number(arg("clips", "8")));
const modes = arg("modes", "old,ptt,handsfree").split(",");
const gap = Number(arg("gap", "6000"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SENTENCE = /[.!?…](\s|$)/;

interface Marks {
  transcript?: number;
  firstSpeakable?: number;
  firstSentence?: number;
  finished?: number;
  speculated?: boolean;
  text?: string;
  kind?: string;
  model?: string;
  escalations?: number;
  partials?: string[];
  permissions?: number;
}

/** One request through a fresh server; `drive` sends the audio. Times are ms after `endAt()` is set. */
async function measure(drive: (send: (m: unknown) => void, endNow: (at?: number) => void, turnEnded: () => boolean) => Promise<void>): Promise<Marks> {
  const out: Marks = {};
  let end = 0;
  const since = (): number => Math.round(performance.now() - end);
  let buf = "";
  let answer: (requestId: string) => void = () => {};
  let turnEnd = false;
  const server: SidecarServer = new SidecarServer({
    token: "t",
    bus: new EventBus(),
    createOrchestrator: runtime.createOrchestrator,
    info: { models: runtime.models, offline: runtime.offline },
    ...(runtime.transcriber ? { transcriber: runtime.transcriber } : {}),
    wakeWords: runtime.wakeWords,
    streaming: runtime.streaming,
    send: (m: ServerMessage) => {
      if (m.type === "voice.transcribed") (out.transcript = since()), (out.speculated = m.speculated), (out.text = m.text);
      if (m.type === "voice.partial") (out.partials ??= []).push(`${m.turnEnd ? "END " : ""}${m.text}`), (turnEnd ||= m.turnEnd);
      if (m.type !== "event") return;
      const e = m.event;
      if (e.type === "permission.required") (out.permissions = (out.permissions ?? 0) + 1), setTimeout(() => answer(e.requestId), 0); // the bench never grants anything
      if (e.type === "route.decided") out.model ??= e.decision.model;
      if (e.type === "escalated") out.escalations = (out.escalations ?? 0) + 1;
      if (e.type === "instant.issued") out.firstSpeakable ??= since();
      if (e.type === "intent.resolved") out.kind = e.route === "local" ? (e.intent ?? "local") : "llm";
      if (e.type === "response.delta") {
        buf += e.text;
        if (SENTENCE.test(buf)) (out.firstSentence ??= since()), (out.firstSpeakable ??= since());
      }
      if (e.type === "task.finished") {
        out.finished = since();
        if (out.kind !== "llm") out.firstSpeakable ??= since(); // a local action is confirmed out loud at the end
        else if (buf) (out.firstSentence ??= since()), (out.firstSpeakable ??= since());
      }
    },
  });
  answer = (requestId) => server.handleLine(JSON.stringify({ type: "permission.answer", requestId, granted: false }));
  server.handleLine(JSON.stringify({ type: "hello", token: "t", protocol: 1 }));
  await drive((m) => server.handleLine(JSON.stringify(m)), (at = performance.now()) => void (end = at), () => turnEnd);
  await server.idle();
  return out;
}

const pcm16 = (x: Float32Array): string => {
  const b = Buffer.alloc(x.length * 2);
  x.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  return b.toString("base64");
};

const rows: { clip: string; mode: string; m: Marks }[] = [];
for (const f of clips) {
  const wav = new Uint8Array(readFileSync(join(dir, f)));
  const audio = resample(decodeWav(wav), 16_000).samples;
  const name = f.replace(/^\d+-/, "").replace(/\.wav$/, "").slice(0, 38);
  if (modes.includes("old")) {
    // Old path: the whole clip is sent when the key is released.
    const m = await measure(async (send, endNow) => {
      await sleep((audio.length / 16_000) * 1000); // the user talks; nothing happens yet
      endNow();
      send({ type: "voice.submit", audio: Buffer.from(wav).toString("base64") });
    });
    rows.push({ clip: name, mode: "old", m });
    console.log(JSON.stringify({ clip: name, mode: "old", ...m }));
    await sleep(gap);
  }
  for (const mode of ["ptt", "handsfree"].filter((x) => modes.includes(x))) {
    const m = await measure(async (send, endNow, turnEnded) => {
      send({ type: "voice.stream.start", id: "b" });
      for (let i = 0; i < audio.length; i += 3200) {
        send({ type: "voice.stream.chunk", id: "b", pcm: pcm16(audio.subarray(i, i + 3200)) });
        await sleep(200); // real time
      }
      if (mode === "ptt") endNow();
      else {
        // The user has stopped talking; the endpointer waits for silence (patient 900 ms, or 450 ms once the sidecar says "finished").
        const speechEnd = performance.now();
        let silent = 0;
        while (silent < (turnEnded() ? 450 : 900)) {
          send({ type: "voice.stream.chunk", id: "b", pcm: pcm16(new Float32Array(800)) });
          await sleep(50);
          silent += 50;
        }
        endNow(speechEnd);
      }
      send({ type: "voice.stream.end", id: "b" });
    });
    rows.push({ clip: name, mode, m });
    console.log(JSON.stringify({ clip: name, mode, ...m }));
    await sleep(gap);
  }
}

const pct = (xs: number[], p: number): number | string => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : "-";
};
for (const mode of ["old", "ptt", "handsfree"]) {
  const r = rows.filter((x) => x.mode === mode).map((x) => x.m);
  if (!r.length) continue;
  const col = (k: keyof Marks) => r.map((m) => m[k] as number).filter((x) => typeof x === "number");
  console.log(
    `${mode.padEnd(7)} n=${r.length}  transcript p50 ${pct(col("transcript"), 0.5)} p90 ${pct(col("transcript"), 0.9)}  |  first speakable p50 ${pct(col("firstSpeakable"), 0.5)} p90 ${pct(col("firstSpeakable"), 0.9)}  |  first sentence p50 ${pct(col("firstSentence"), 0.5)}  |  speculated ${r.filter((m) => m.speculated).length}`,
  );
}
process.exit(0);
