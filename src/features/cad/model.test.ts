import { describe, expect, it } from 'vitest'
import opencascade from 'replicad-opencascadejs'
import * as replicad from 'replicad'
import { fileURLToPath } from 'node:url'
import { EXAMPLES, kernelError, loadModel, modelFromText, paramControls, paramLabel, partsOf } from './model'

describe('the CAD model layer', () => {
  it('makes sliders from parameters', () => {
    expect(paramControls({ width: 60, wall: 1.5, offset: -10, solid: true, name: 'x' })).toEqual([
      { key: 'width', kind: 'number', value: 60, min: 0, max: 180, step: 1 },
      { key: 'wall', kind: 'number', value: 1.5, min: 0, max: 4.5, step: 0.1 },
      { key: 'offset', kind: 'number', value: -10, min: -30, max: 30, step: 1 },
      { key: 'solid', kind: 'boolean', value: true },
    ])
    expect(paramLabel('holeDiameter')).toBe('Hole diameter')
    expect(paramLabel('flange_height')).toBe('Flange height')
  })

  it('reads a model and says what is missing', () => {
    expect(loadModel('const defaultParams = { a: 1 }\nfunction main(r, p) { return p.a }').defaults).toEqual({ a: 1 })
    expect(() => loadModel('const x = 1')).toThrow(/main function/)
    expect(() => partsOf(3, (x): x is object => false)).toThrow(/didn’t return a shape/)
    expect(kernelError(12345)).toMatch(/fillet/)
    expect(kernelError(new Error('width is not defined'))).toBe('width is not defined')
    const blocked = new Error("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source"); blocked.name = 'EvalError'
    expect(kernelError(blocked)).toMatch(/security policy/)
  })

  it('takes the model out of a reply', () => {
    const reply = 'Here you go:\n```js\nconst defaultParams = { a: 1 }\nfunction main(r, p) { return 1 }\n```\nThat makes a cube.'
    expect(modelFromText(reply)).toBe('const defaultParams = { a: 1 }\nfunction main(r, p) { return 1 }\n')
    expect(modelFromText('```js\nconst x = 1\n```')).toBeNull()
    expect(modelFromText('const main = (r) => r.makeBaseBox(1, 1, 1)')).toBe('const main = (r) => r.makeBaseBox(1, 1, 1)\n')
    expect(modelFromText('just words')).toBeNull()
  })

  it('builds every example with the real kernel', async () => {
    const wasm = fileURLToPath(new URL('../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
    const OC = await (opencascade as unknown as (o: object) => Promise<unknown>)({ locateFile: () => wasm, print: () => undefined, printErr: () => undefined })
    replicad.setOC(OC as Parameters<typeof replicad.setOC>[0])
    const isShape = (x: unknown): x is replicad.AnyShape => !!x && typeof (x as { mesh?: unknown }).mesh === 'function'
    for (const ex of EXAMPLES) {
      const { defaults, main } = loadModel(ex.code)
      const parts = partsOf(main(replicad, defaults), isShape)
      for (const part of parts) {
        const mesh = (part.shape as replicad.Solid).mesh({ tolerance: 0.1, angularTolerance: 30 })
        expect(mesh.triangles.length, ex.name).toBeGreaterThan(30)
      }
    }
  }, 60_000)
})
