import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transcriber, Transcript, TranscribeOptions } from "./transcriber";
import { decodeWav, durationMs } from "./wav";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type RunProcess = (binary: string, args: string[], opts: { signal?: AbortSignal; timeoutMs: number }) => Promise<RunResult>;

/** argv only, never a shell: nothing in `args` is interpreted. */
export const runProcess: RunProcess = (binary, args, { signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4_000)));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(`whisper binary not found: ${binary}`) : e);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (sig === "SIGKILL") return reject(new Error(`whisper timed out after ${timeoutMs} ms`));
      resolve({ code, stdout, stderr });
    });
  });

export interface WhisperCppOptions {
  /** Path to whisper.cpp's `whisper-cli` (or `main` in older releases). Provided by the user; this project does not ship or build it. */
  binary: string;
  /** Path to a ggml model (e.g. ggml-base.bin). */
  model: string;
  /** ISO 639-1 code or "auto". */
  language?: string;
  threads?: number;
  timeoutMs?: number;
  run?: RunProcess;
}

const LANG = /^(auto|[a-z]{2,3})$/;

/** Text the engine prints for non-speech; it is not something the user said. */
export function cleanWhisperOutput(stdout: string): string {
  return stdout
    .replace(/\[(?:BLANK_AUDIO|MUSIC|SILENCE|NOISE|APPLAUSE|LAUGHTER)[^\]]*\]/gi, " ")
    .replace(/\((?:música|music|silencio|silence|ruido|noise|aplausos|applause)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Local STT through whisper.cpp's CLI. Audio never leaves the machine. The WAV is written to a private temp dir
 * that is removed afterwards.
 */
export class WhisperCppTranscriber implements Transcriber {
  private readonly run: RunProcess;

  constructor(private readonly opts: WhisperCppOptions) {
    if (opts.language !== undefined && !LANG.test(opts.language)) throw new Error(`invalid language "${opts.language}"`);
    this.run = opts.run ?? runProcess;
  }

  async transcribe(wav: Uint8Array, { language, signal }: TranscribeOptions = {}): Promise<Transcript> {
    const lang = language ?? this.opts.language ?? "auto";
    if (!LANG.test(lang)) throw new Error(`invalid language "${lang}"`);
    const dir = await mkdtemp(join(tmpdir(), "jarvis-stt-"));
    const started = Date.now();
    try {
      const file = join(dir, "clip.wav");
      await writeFile(file, wav, { mode: 0o600 });
      const args = ["-m", this.opts.model, "-f", file, "-l", lang, "-nt", "-np"];
      if (this.opts.threads) args.push("-t", String(this.opts.threads));
      const r = await this.run(this.opts.binary, args, { signal, timeoutMs: this.opts.timeoutMs ?? 60_000 });
      if (r.code !== 0) throw new Error(`whisper exited with code ${r.code}: ${r.stderr.trim().slice(-300)}`);
      return { text: cleanWhisperOutput(r.stdout), ...(lang !== "auto" ? { language: lang } : {}), audioMs: durationMs(decodeWav(wav)), latencyMs: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
