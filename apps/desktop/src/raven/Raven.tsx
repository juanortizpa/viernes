import { motion, type Variants } from "framer-motion";
import type { Mode } from "../state/island";

/**
 * Stylized cartoon raven. Its pose is a pure function of `mode`; it never decides anything.
 * Parts are separate groups so each state animates only what it needs.
 */
const box = { transformBox: "fill-box", transformOrigin: "center" } as const;
const ease = { duration: 2.6, repeat: Infinity, ease: "easeInOut" } as const;

const body: Variants = {
  idle: { scaleY: [1, 1.035, 1], transition: ease },
  listening: { scaleY: 1.02, transition: { duration: 0.3 } },
  thinking: { scaleY: [1, 1.02, 1], transition: { ...ease, duration: 1.4 } },
  executing: { scaleY: [1, 1.025, 1], transition: { ...ease, duration: 1.1 } },
  permission: { scaleY: 1.03 },
  success: { scaleY: 1 },
  error: { scaleY: 0.98 },
  warning: { scaleY: 1.04 },
};

const head: Variants = {
  idle: { rotate: [0, -3, 0, 3, 0], y: 0, transition: { duration: 6, repeat: Infinity, ease: "easeInOut" } },
  listening: { rotate: 0, y: -4, transition: { type: "spring", stiffness: 260, damping: 16 } },
  thinking: { rotate: [-6, 6, -6], y: 0, transition: { duration: 1.6, repeat: Infinity, ease: "easeInOut" } },
  executing: { rotate: [0, 4, 0], y: [0, -1, 0], transition: { duration: 0.9, repeat: Infinity, ease: "easeInOut" } },
  permission: { rotate: -5, y: -2, transition: { type: "spring", stiffness: 200, damping: 14 } },
  success: { rotate: 0, y: [0, -4, 0], transition: { duration: 0.6 } },
  error: { rotate: -16, y: 2, transition: { type: "spring", stiffness: 160, damping: 12 } },
  warning: { rotate: 0, y: -2, transition: { duration: 0.2 } },
};

const wing: Variants = {
  idle: { rotate: 0 },
  listening: { rotate: 0 },
  thinking: { rotate: 0 },
  executing: { rotate: [0, -3, 0], transition: { duration: 0.9, repeat: Infinity } },
  permission: { rotate: -6 },
  success: { rotate: [0, -28, 0, -22, 0], transition: { duration: 0.9 } },
  error: { rotate: 6 },
  warning: { rotate: -10 },
};

const crest: Variants = {
  idle: { scaleY: 1 },
  listening: { scaleY: 1.2 },
  thinking: { scaleY: 1 },
  executing: { scaleY: 1 },
  permission: { scaleY: 1.5 },
  success: { scaleY: 1 },
  error: { scaleY: 0.7 },
  warning: { scaleY: 1.9, transition: { duration: 0.2 } }, // feathers raised
};

const eyeBlink = (mode: Mode) =>
  mode === "idle"
    ? { scaleY: [1, 1, 0.08, 1, 1], transition: { duration: 4.5, repeat: Infinity, times: [0, 0.86, 0.9, 0.94, 1] } }
    : { scaleY: mode === "error" ? 0.7 : 1 };

/** `level`: real microphone level (0..1) while listening; drives the sound rings. */
/** `speaking`: the speech synthesiser is really playing; the beak opens and closes. */
export function Raven({ mode, size = 56, level, speaking = false }: { mode: Mode; size?: number; level?: number; speaking?: boolean }) {
  const listening = mode === "listening" || mode === "permission";
  const thinking = mode === "thinking";
  const warn = mode === "warning" || mode === "permission";
  const iris = warn ? "#ffb454" : mode === "error" ? "#ff7a8a" : mode === "success" ? "#7dffb2" : "#5de1ff";

  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={`JARVIS: ${mode}`}>
      <defs>
        <linearGradient id="rv-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a4580" />
          <stop offset="1" stopColor="#12152e" />
        </linearGradient>
        <radialGradient id="rv-glow">
          <stop offset="0" stopColor={iris} stopOpacity="0.55" />
          <stop offset="1" stopColor={iris} stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="60" cy="62" r="52" fill="url(#rv-glow)" opacity="0.35" />

      {/* tail */}
      <path d="M34 92 L16 108 L40 100 L30 114 L50 100 Z" fill="#12152e" />

      <motion.g variants={body} animate={mode} style={box}>
        <ellipse cx="58" cy="76" rx="30" ry="28" fill="url(#rv-body)" />
        <ellipse cx="66" cy="84" rx="15" ry="16" fill="#252c5a" opacity="0.9" />
        {/* wing */}
        <motion.path
          variants={wing}
          animate={mode}
          style={{ transformBox: "fill-box", transformOrigin: "80% 15%" }}
          d="M40 66 C22 70 18 92 28 102 C40 96 52 88 56 72 Z"
          fill="#1c2247"
          stroke="#4a5aa8"
          strokeWidth="1.2"
        />
        {/* feet */}
        <path d="M50 102 v8 M66 102 v8" stroke="#ffb454" strokeWidth="3" strokeLinecap="round" />
      </motion.g>

      <motion.g variants={head} animate={mode} style={{ transformBox: "fill-box", transformOrigin: "50% 90%" }}>
        {/* crest feathers */}
        <motion.g variants={crest} animate={mode} style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}>
          <path d="M44 34 L38 18 L53 30 Z" fill="#3a4580" stroke="#6a7ad0" strokeWidth="0.8" />
          <path d="M54 30 L54 11 L65 29 Z" fill="#4a5aa8" stroke="#8a9ae8" strokeWidth="0.8" />
          <path d="M64 33 L74 18 L73 36 Z" fill="#3a4580" stroke="#6a7ad0" strokeWidth="0.8" />
        </motion.g>
        <circle cx="58" cy="46" r="23" fill="url(#rv-body)" />
        {/* beak */}
        <path d="M78 44 L100 52 L78 58 Z" fill="#ffb454" />
        {/* lower beak: swings open while speaking */}
        <motion.path
          d="M78 52 L100 52 L78 58 Z"
          fill="#e8962f"
          animate={speaking ? { rotate: [0, 14, 0, 10, 0] } : { rotate: 0 }}
          transition={speaking ? { duration: 0.55, repeat: Infinity, ease: "easeInOut" } : { duration: 0.15 }}
          style={{ transformBox: "fill-box", transformOrigin: "0% 0%" }}
        />
        <path d="M78 52 L100 52" stroke="#c9822a" strokeWidth="1.2" />
        {/* eyes */}
        <motion.g animate={eyeBlink(mode)} style={box}>
          <circle cx="66" cy="44" r={listening ? 8.5 : 7} fill="#eaf2ff" />
          <circle cx="68" cy="44.5" r="3.8" fill={iris} />
          <circle cx="69.2" cy="43" r="1.2" fill="#fff" />
        </motion.g>
        {mode === "error" && <path d="M58 33 L72 36" stroke="#12152e" strokeWidth="2.4" strokeLinecap="round" />}
      </motion.g>

      {/* listening: rings whose size follows the real microphone level (flat when no level is known) */}
      {mode === "listening" &&
        [0, 1].map((i) => (
          <motion.circle
            key={i}
            cx="58"
            cy="46"
            fill="none"
            stroke={iris}
            strokeWidth="1.6"
            animate={{ r: 30 + i * 9 + (level ?? 0) * 16, opacity: 0.55 - i * 0.2 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          />
        ))}

      {/* thinking particles orbiting the head */}
      {thinking && (
        <motion.g
          animate={{ rotate: 360 }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: "58px 46px" }}
        >
          {[0, 120, 240].map((a) => (
            <circle key={a} cx={58 + 34 * Math.cos((a * Math.PI) / 180)} cy={46 + 34 * Math.sin((a * Math.PI) / 180)} r="2.6" fill={iris} />
          ))}
        </motion.g>
      )}
    </svg>
  );
}
