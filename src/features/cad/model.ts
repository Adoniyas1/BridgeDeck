/**
 * The CAD tab's pieces that aren't React or the kernel: the example parts, the sliders made from a
 * model's parameters, and running a model. A model is a short script in replicad's form (the same
 * as its online studio, so examples from there paste in): `defaultParams`, and `main(replicad,
 * params)` returning a shape, or a list of `{ shape, name, color }`.
 */

export type Example = { name: string; about: string; code: string }

export const EXAMPLES: Example[] = [
  {
    name: 'Mounting plate',
    about: 'A plate with rounded corners, a hole in each corner and softened top edges.',
    code: `// A mounting plate. Change the sizes with the sliders (millimetres).
const defaultParams = { width: 80, depth: 50, thickness: 5, holeDiameter: 4, corner: 6 }

function main({ drawRoundedRectangle, makeCylinder }, p) {
  let plate = drawRoundedRectangle(p.width, p.depth, p.corner).sketchOnPlane().extrude(p.thickness)
  // Soften the top edges.
  plate = plate.fillet(1, e => e.inPlane('XY', p.thickness))
  // A hole near each corner.
  const inset = p.corner + p.holeDiameter / 2
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const hole = makeCylinder(p.holeDiameter / 2, p.thickness * 3).translate([x * (p.width / 2 - inset), y * (p.depth / 2 - inset), -p.thickness])
    plate = plate.cut(hole)
  }
  return plate
}
`,
  },
  {
    name: 'Electronics box',
    about: 'A hollow box with an open top and a hole for a cable, to 3D print around a board.',
    code: `// A box for a circuit board: hollow, open at the top, with a cable hole in one end.
const defaultParams = { length: 90, width: 60, height: 30, wall: 2, cableHole: 8 }

function main({ drawRoundedRectangle, makeCylinder }, p) {
  let box = drawRoundedRectangle(p.length, p.width, 4).sketchOnPlane().extrude(p.height)
  // Hollow it out, leaving the top open.
  box = box.shell(p.wall, f => f.inPlane('XY', p.height))
  // A round hole through one end for the cable.
  const hole = makeCylinder(p.cableHole / 2, p.wall * 4, [0, 0, 0], [1, 0, 0]).translate([p.length / 2 - p.wall * 2, 0, p.height / 2])
  return { shape: box.cut(hole), name: 'Box', color: '#5b8def' }
}
`,
  },
  {
    name: 'L bracket',
    about: 'An angle bracket drawn as a 2D profile and extruded, with screw holes in both arms.',
    code: `// An L bracket: the side profile is drawn, then pulled out to the bracket's width.
const defaultParams = { arm: 40, thickness: 4, width: 25, hole: 4.5 }

function main({ draw, makeCylinder }, p) {
  const profile = draw()
    .hLine(p.arm).vLine(p.thickness).hLine(-(p.arm - p.thickness))
    .vLine(p.arm - p.thickness).hLine(-p.thickness).close()
  let bracket = profile.sketchOnPlane('XZ').extrude(-p.width)
  // A screw hole in each arm.
  const flat = makeCylinder(p.hole / 2, p.thickness * 3).translate([p.arm * 0.6, p.width / 2, -p.thickness])
  const upright = makeCylinder(p.hole / 2, p.thickness * 3, [0, 0, 0], [1, 0, 0]).translate([-p.thickness, p.width / 2, p.arm * 0.6])
  bracket = bracket.cut(flat).cut(upright)
  return bracket
}
`,
  },
  {
    name: 'Standoff',
    about: 'A round spacer made by spinning a profile around an axis, with a hole down the middle.',
    code: `// A standoff for mounting a board: a profile spun around the Z axis.
const defaultParams = { height: 12, outer: 7, inner: 3.2, flange: 10, flangeHeight: 2 }

function main({ draw }, p) {
  // Half the cross-section, from the hole outwards (x is the radius, y is the height).
  const profile = draw([p.inner / 2, 0])
    .hLineTo(p.flange / 2).vLine(p.flangeHeight)
    .hLineTo(p.outer / 2).vLineTo(p.height)
    .hLineTo(p.inner / 2).close()
  return { shape: profile.sketchOnPlane('XZ').revolve(), name: 'Standoff', color: '#c9a227' }
}
`,
  },
]

export type Param = { key: string; kind: 'number'; value: number; min: number; max: number; step: number } | { key: string; kind: 'boolean'; value: boolean }

/** Sliders for a model's parameters: numbers from 0 (or below, for negative ones) to three times
 *  their default, in whole steps when the default is whole (else 0.1, or 0.01 under 1); true/false
 *  as a tick box. */
export function paramControls(defaults: Record<string, unknown>): Param[] {
  return Object.entries(defaults).flatMap(([key, v]): Param[] => {
    if (typeof v === 'boolean') return [{ key, kind: 'boolean', value: v }]
    if (typeof v !== 'number' || !Number.isFinite(v)) return []
    const span = Math.max(1, Math.abs(v) * 3)
    const whole = Number.isInteger(v)
    return [{ key, kind: 'number', value: v, min: v < 0 ? -span : 0, max: span, step: whole ? 1 : Math.abs(v) >= 1 ? 0.1 : 0.01 }]
  })
}

/** "holeDiameter" → "Hole diameter". */
export const paramLabel = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`)

export type Part<S> = { shape: S; name: string; color: string }
const COLORS = ['#7aa2f7', '#e0af68', '#9ece6a', '#f7768e', '#bb9af7', '#7dcfff']

/** Reads a model's script: its default parameters and its main function. */
export function loadModel(code: string): { defaults: Record<string, unknown>; main: (lib: unknown, params: Record<string, unknown>) => unknown } {
  // eslint-disable-next-line no-new-func
  const made = new Function(`"use strict";\n${code}\n;return { defaults: typeof defaultParams === 'undefined' ? {} : defaultParams, main: typeof main === 'undefined' ? undefined : main }`)() as { defaults: unknown; main: unknown }
  if (typeof made.main !== 'function') throw new Error('The model needs a main function: function main(replicad, params) { … return shape }')
  const defaults = made.defaults && typeof made.defaults === 'object' ? made.defaults as Record<string, unknown> : {}
  return { defaults, main: made.main as (lib: unknown, params: Record<string, unknown>) => unknown }
}

/** What main returned, as parts: one shape, a list of shapes, or `{ shape, name, color }`s. */
export function partsOf<S>(result: unknown, isShape: (x: unknown) => x is S): Part<S>[] {
  const list = Array.isArray(result) ? result : [result]
  const parts = list.flatMap((item, i): Part<S>[] => {
    if (isShape(item)) return [{ shape: item, name: `Part ${i + 1}`, color: COLORS[i % COLORS.length] }]
    const o = item as { shape?: unknown; name?: unknown; color?: unknown } | null
    if (o && isShape(o.shape)) return [{ shape: o.shape, name: typeof o.name === 'string' ? o.name : `Part ${i + 1}`, color: typeof o.color === 'string' ? o.color : COLORS[i % COLORS.length] }]
    return []
  })
  if (!parts.length) throw new Error('main didn’t return a shape. End it with “return” and the shape (or a list of them).')
  return parts
}

/** A kernel failure in plain words: OpenCascade throws without a message when an operation can't
 *  be done (a fillet too big for its edges, a cut that misses, a shell through a thin wall). */
export function kernelError(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  // The worker runs scripts under its own policy; if a web view applied the window's (which forbids
  // running text as code), models can't run at all here.
  if ((e instanceof Error && e.name === 'EvalError') || /unsafe-eval|Content Security Policy/i.test(text)) return 'This computer’s web view won’t run model scripts in the CAD kernel (its security policy blocks it). Use “Report a problem” in Settings → About so it can be fixed.'
  if (text && !/^\d+$/.test(text)) return text
  return 'OpenCascade couldn’t do one of the operations. Usually a fillet or chamfer is bigger than the edges allow, a shell wall is too thick, or a cut doesn’t touch the part: try smaller values, or comment out the last step to find which.'
}

/** What Mimir is asked when making or changing a model. */
export function cadPrompt(request: string, code: string): string {
  return [
    `Help me with a CAD model in BridgeDeck's CAD tab. It uses replicad (OpenCascade in JavaScript), in replicad studio's form: \`const defaultParams = { … }\` (numbers in millimetres become sliders) and \`function main(replicad, params) { … return shape }\` (destructure what you use from replicad, e.g. { draw, drawRoundedRectangle, makeCylinder, makeBaseBox }; return a shape or a list of { shape, name, color }).`,
    `What I want: ${request}`,
    'Reply with the whole new model in one ```js block. Keep fillets small and add them last, since they fail first. Comment each step briefly.',
    '',
    'The model now:',
    '```js',
    code,
    '```',
  ].join('\n')
}

/** The model in a reply or pasted text: the last ```js block that has a main function, or the text
 *  itself if it's a model. Null when there's no model in it. */
export function modelFromText(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/g)].map(m => m[1].trim())
  const model = blocks.reverse().find(b => /\bfunction\s+main\b|\bconst\s+main\s*=/.test(b))
  if (model) return `${model}\n`
  return /\bfunction\s+main\b|\bconst\s+main\s*=/.test(text) ? `${text.trim()}\n` : null
}
