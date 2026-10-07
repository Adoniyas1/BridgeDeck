import React from "react";
import type { FaceState } from "../shared/types.js";

interface Particle {
  angle: number; // degrees, starting position around the core
  radius: number; // px from center in the 200x200 viewBox
  size: number; // circle radius
  duration: number; // orbit period, seconds — varied for organic motion
  reverse: boolean;
  twinkleDelay: number;
  twinkleDuration: number;
}

const PARTICLE_COUNT = 26;

/** Deterministic pseudo-random field, generated once at module load — an
 * organic-looking scatter that's stable across re-renders (no per-render
 * Math.random(), which would make particles jump on every state change). */
function makeParticles(): Particle[] {
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      angle: rand() * 360,
      radius: 32 + rand() * 48,
      size: 1.1 + rand() * 2.1,
      duration: 9 + rand() * 24,
      reverse: rand() > 0.5,
      twinkleDelay: rand() * 4,
      twinkleDuration: 1.5 + rand() * 2.3
    });
  }
  return particles;
}

const PARTICLES = makeParticles();

/** Tick marks around the outer ring, like a HUD dial. */
const TICKS = Array.from({ length: 72 }, (_, i) => i * 5);

/**
 * Mimir's visual presence: a holographic core. A particle field orbits a
 * glowing nucleus inside counter-rotating HUD rings (a tick dial, arc
 * segments and a dashed track). State shows through colour (idle cyan,
 * listening teal, thinking violet, speaking magenta, error red) and speed.
 */
export default function Face({ state }: { state: FaceState }) {
  return (
    <div className={`orb orb--${state}`} aria-label={`Mimir core is ${state}`}>
      <svg viewBox="0 0 200 200" role="img">
        <defs>
          <filter id="orb-particle-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="1" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="orb-core-glow" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="orb-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="60%" stopColor="currentColor" stopOpacity="0.12" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-nucleus" cx="42%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor="currentColor" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.2" />
          </radialGradient>
        </defs>

        <g className="orb-color">
          <g className="orb-dial">
            {TICKS.map((deg) => (
              <line
                key={deg}
                x1="100"
                y1={deg % 30 === 0 ? 3 : 6}
                x2="100"
                y2="10"
                className={deg % 30 === 0 ? "orb-tick orb-tick--major" : "orb-tick"}
                transform={`rotate(${deg} 100 100)`}
              />
            ))}
          </g>
          <circle cx="100" cy="100" r="84" className="orb-ring orb-ring--outer" />
          <g className="orb-arcs">
            <path d="M100 22 A78 78 0 0 1 178 100" className="orb-arc" />
            <path d="M100 178 A78 78 0 0 1 22 100" className="orb-arc" />
          </g>
          <g className="orb-arcs orb-arcs--inner">
            <path d="M58 58 A59 59 0 0 1 142 58" className="orb-arc orb-arc--thin" />
            <path d="M142 142 A59 59 0 0 1 58 142" className="orb-arc orb-arc--thin" />
          </g>
          <circle cx="100" cy="100" r="62" className="orb-ring orb-ring--inner" />

          <circle cx="100" cy="100" r="46" fill="url(#orb-halo)" className="orb-halo" />

          <g className="orb-particle-field" filter="url(#orb-particle-glow)">
            {PARTICLES.map((p, i) => (
              <g
                key={i}
                className="orb-particle-orbit"
                style={{
                  transformOrigin: "100px 100px",
                  animationDuration: `${p.duration}s`,
                  animationDirection: p.reverse ? "reverse" : "normal"
                }}
              >
                <circle
                  className="orb-particle"
                  cx={100 + p.radius * Math.cos((p.angle * Math.PI) / 180)}
                  cy={100 + p.radius * Math.sin((p.angle * Math.PI) / 180)}
                  r={p.size}
                  style={{
                    animationDelay: `${p.twinkleDelay}s`,
                    animationDuration: `${p.twinkleDuration}s`
                  }}
                />
              </g>
            ))}
          </g>

          <circle cx="100" cy="100" r="15" className="orb-core" fill="url(#orb-nucleus)" filter="url(#orb-core-glow)" />
          <circle cx="100" cy="100" r="24" className="orb-ripple" />
        </g>
      </svg>
    </div>
  );
}
