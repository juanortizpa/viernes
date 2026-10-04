// Browser-safe subset (no node:* imports): WAV helpers and the clip limits the UI must respect.
export * from "./wav";
export { MAX_CLIP_MS, MIN_CLIP_MS } from "./transcriber";
