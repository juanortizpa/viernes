import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { jarvisBridge } from "./vite-plugin-jarvis";

export default defineConfig({
  plugins: [react(), jarvisBridge()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: "0.0.0.0",
    port: 5173,
    hmr: {
      protocol: "wss",
      host: undefined,
      port: undefined,
    },
  },
});
