// Pure helpers for setup.mjs / start.mjs (kept free of side effects so they can be unit-tested on any OS).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Provider config section -> the environment variable that must exist for it to be usable. */
export const PROVIDER_KEYS = { groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", google: "GEMINI_API_KEY" };

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export const serializeEnv = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";

export function nodeOk(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/**
 * Keeps only the providers whose key is present (a section without its key would stop the sidecar from starting),
 * points defaultModel at a model that still exists, and adds the voice block when whisper is available.
 */
export function buildConfig({ base, env, voice }) {
  const cfg = structuredClone(base);
  for (const [section, key] of Object.entries(PROVIDER_KEYS)) {
    const have = Boolean(env[key]) || (section === "google" && Boolean(env.GOOGLE_API_KEY));
    if (!have) delete cfg[section];
  }
  const models = Object.keys(PROVIDER_KEYS).flatMap((s) => (cfg[s]?.models ?? []).map((m) => m.model));
  if (models.length === 0) delete cfg.defaultModel;
  else if (!models.includes(cfg.defaultModel)) cfg.defaultModel = models[0];
  if (voice) cfg.voice = { binary: voice.binary.replaceAll("\\", "/"), model: voice.model.replaceAll("\\", "/"), language: "auto", threads: voice.threads ?? 4 };
  return cfg;
}

/** Windows build of whisper.cpp in a GitHub release: prefer the plain CPU x64 zip, never the CUDA/BLAS ones. */
export function pickWhisperAsset(release) {
  const assets = release?.assets ?? [];
  return (
    assets.find((a) => a.name === "whisper-bin-x64.zip") ??
    assets.find((a) => /x64/i.test(a.name) && /\.zip$/i.test(a.name) && !/cublas|blas|cuda|vulkan|arm/i.test(a.name))
  );
}

/** First file with one of `names` under `dir` (depth-first). */
export function findFile(dir, names) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const r = findFile(p, names);
      if (r) return r;
    } else if (names.includes(e.toLowerCase())) return p;
  }
  return undefined;
}

export const WHISPER_MODELS = {
  tiny: { file: "ggml-tiny.bin", minBytes: 70e6 },
  base: { file: "ggml-base.bin", minBytes: 130e6 },
  small: { file: "ggml-small.bin", minBytes: 440e6 },
};
