import React, { useEffect, useRef } from "react";
import type { FaceState } from "../../shared/types.js";

/** The colour of each state: standing by, listening, thinking, speaking, error. */
const COLORS: Record<FaceState, [number, number, number]> = {
  idle: [110, 231, 255],
  listening: [74, 222, 128],
  thinking: [167, 139, 250],
  speaking: [110, 231, 255],
  error: [248, 113, 113]
};

/**
 * Jarvis's orb: a glowing core inside turning rings, drawn on a canvas. It swells with your voice
 * while listening (the microphone's level, when it may be read), pulses while Mimir speaks, and
 * spins up while it thinks. Colours ease from one state to the next.
 */
export default function Orb({ state, micLevel }: { state: FaceState; micLevel: React.MutableRefObject<number> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let frame = 0;
    let color = [...COLORS[stateRef.current]];
    let energy = 0;
    let spin = 0;
    const start = performance.now();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const ratio = window.devicePixelRatio || 1;
      const size = el.clientWidth;
      if (el.width !== Math.round(size * ratio)) { el.width = Math.round(size * ratio); el.height = Math.round(size * ratio); }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const s = stateRef.current;
      const target = COLORS[s];
      color = color.map((c, i) => c + ((target[i] ?? c) - c) * 0.06);
      const [r, g, b] = color.map(Math.round);
      // How lively the orb is: the voice while listening, a pulse while speaking, a hum otherwise.
      const want = s === "listening" ? Math.min(1, micLevel.current * 4) : s === "speaking" ? 0.45 + 0.35 * Math.abs(Math.sin(t * 5.3)) * Math.abs(Math.sin(t * 2.1 + 1)) : s === "thinking" ? 0.35 : 0.12;
      energy += (want - energy) * 0.15;
      spin += (s === "thinking" ? 0.035 : 0.006) * (reduce ? 0.2 : 1);
      // Sized so the glow and the outer ring fade out inside the canvas (no square edge).
      const cx = size / 2, cy = size / 2, R = size * 0.16;

      // Glow.
      const reach = Math.min(size * 0.5, R * (2.4 + energy));
      const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, reach);
      glow.addColorStop(0, `rgba(${r},${g},${b},${0.35 + energy * 0.3})`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, reach, 0, Math.PI * 2); ctx.fill();

      // Rings: dashed arcs turning at different speeds and directions.
      const rings = [[1.45, 1, 0.9, 18], [1.75, -0.6, 0.6, 42], [2.05, 0.35, 0.45, 6], [2.35, -0.2, 0.3, 64]] as const;
      for (const [k, dir, alpha, segments] of rings) {
        const radius = R * k * (1 + energy * 0.08);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = k > 2 ? 1 : 1.6;
        const step = (Math.PI * 2) / segments;
        for (let i = 0; i < segments; i++) {
          const a0 = i * step + spin * dir * 6;
          ctx.beginPath(); ctx.arc(cx, cy, radius, a0, a0 + step * 0.62); ctx.stroke();
        }
      }

      // The core: a wobbling disc whose edge follows the energy.
      ctx.beginPath();
      const points = 96;
      for (let i = 0; i <= points; i++) {
        const a = (i / points) * Math.PI * 2;
        const wobble = 1 + energy * 0.18 * Math.sin(a * 6 + t * 4) * Math.sin(a * 3 - t * 2.6);
        const x = cx + Math.cos(a) * R * wobble, y = cy + Math.sin(a) * R * wobble;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      const core = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R * 1.1);
      core.addColorStop(0, "rgba(255,255,255,0.95)");
      core.addColorStop(0.35, `rgba(${r},${g},${b},0.85)`);
      core.addColorStop(1, `rgba(${r},${g},${b},0.15)`);
      ctx.fillStyle = core;
      ctx.fill();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [micLevel]);

  return <canvas ref={canvas} className="jarvis-orb" aria-hidden="true" />;
}
