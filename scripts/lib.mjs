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

const BAD_FLAVOUR = /cublas|blas|cuda|vulkan|arm|xcframework|ios|macos|android|wasm|jni/i;

/** Windows CPU x64 build in one release's assets, from the exact known name to progressively looser matches. Never a CUDA/BLAS/other-OS build. */
export function pickWhisperAsset(release) {
  const assets = (release?.assets ?? []).filter((a) => /\.zip$/i.test(a.name) && !BAD_FLAVOUR.test(a.name));
  return (
    assets.find((a) => a.name === "whisper-bin-x64.zip") ??
    assets.find((a) => /bin/i.test(a.name) && /x64|win64|amd64/i.test(a.name)) ??
    assets.find((a) => /win/i.test(a.name) && /x64|win64|amd64/i.test(a.name))
  );
}

/** Newest release (list order) that ships a usable Windows build; the "latest" release may only carry other platforms. */
export function pickFromReleases(releases) {
  for (const r of Array.isArray(releases) ? releases : []) {
    if (r.draft) continue;
    const asset = pickWhisperAsset(r);
    if (asset) return { tag: r.tag_name, asset };
  }
  return undefined;
}

/** What the user can paste back when nothing matched. */
export const describeAssets = (releases, n = 5) =>
  (Array.isArray(releases) ? releases : [])
    .slice(0, n)
    .map((r) => `${r.tag_name}: ${(r.assets ?? []).map((a) => a.name).join(", ") || "(sin archivos)"}`)
    .join("\n    ");

/** Last resort if the API is unreachable or lists nothing usable. */
export const PINNED_WHISPER_ZIP = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.5/whisper-bin-x64.zip";

/** First file named like one of `names`, depth-first. */
function findFirst(dir, name) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const r = findFirst(p, name);
      if (r) return r;
    } else if (e.toLowerCase() === name) return p;
  }
  return undefined;
}

/**
 * Searches for the names IN ORDER OF PREFERENCE: every match of the first name beats any match of the next one.
 * (whisper.cpp zips also ship a deprecated `main.exe` stub that only prints a warning; it must never win over whisper-cli.exe.)
 */
export function findFile(dir, names) {
  for (const n of names) {
    const r = findFirst(dir, n);
    if (r) return r;
  }
  return undefined;
}

/** True for whisper.cpp's deprecated stub, which cannot transcribe. */
export const isDeprecatedWhisperStub = (path) => /(^|[\\/])main(\.exe)?$/i.test(path);

/** Windows exit codes that mean "could not even start" (shown in hex, as Windows documents them). */
export function explainExitCode(code) {
  const hex = code === null || code === undefined ? "?" : "0x" + (code >>> 0).toString(16).toUpperCase();
  if (code === 3221225781 || code === -1073741515) return `${hex}: falta una DLL junto al ejecutable (copia TODO el contenido del zip, no solo el .exe; puede faltar el "Visual C++ Redistributable")`;
  if (code === 3221225477 || code === -1073741819) return `${hex}: el programa se cerró por un fallo de memoria (¿modelo corrupto o incompleto? vuelve a descargarlo)`;
  return hex;
}

export const WHISPER_MODELS = {
  tiny: { file: "ggml-tiny.bin", minBytes: 70e6 },
  base: { file: "ggml-base.bin", minBytes: 130e6 },
  small: { file: "ggml-small.bin", minBytes: 440e6 },
};
