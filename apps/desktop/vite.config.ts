import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { jarvisBridge } from "./vite-plugin-jarvis";

/** Set by the Tauri CLI for `beforeDevCommand`: the shell relays the sidecar itself, so the dev bridge stays off. */
const underTauri = Boolean(process.env.TAURI_ENV_PLATFORM);

export default defineConfig({
  plugins: [react(), ...(underTauri ? [] : [jarvisBridge()])],
  clearScreen: false,
  server: {
    strictPort: true,
    host: underTauri ? "127.0.0.1" : "0.0.0.0",
    port: 5173,
    hmr: underTauri
      ? undefined
      : {
          protocol: "wss",
          host: undefined,
          port: undefined,
        },
  },
});
