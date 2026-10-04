import { MotionConfig } from "framer-motion";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri } from "./live/tauri-transport";
import "./styles.css";

if (isTauri()) document.documentElement.classList.add("tauri");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Honour the OS "reduce motion" setting: transform/layout animations (incl. the raven's loops) are skipped. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
