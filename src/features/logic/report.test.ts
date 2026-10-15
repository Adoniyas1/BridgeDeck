import { describe, expect, it } from 'vitest'
import { buildFsmCircuit, exampleFsm } from './fsm'
import { buildWithRules, parseOutputs, tableOf } from './model'
import { reportHtml, reportMarkdown } from './report'

const at = new Date(2026, 9, 15)

describe('lab reports', () => {
  it('has the circuit, truth table, expressions, K-map, chips, wiring and steps', () => {
    const c = buildWithRules(tableOf(parseOutputs('Y = AB + AC + BC')), { gates: 'nand', maxInputs: 2 })
    const html = reportHtml(c, { title: 'Voting box', project: 'EE 201', date: at })
    expect(html).toContain('<title>Voting box – lab report</title>')
    expect(html).toContain('EE 201 · ')
    expect(html).toMatch(/<h2>Circuit<\/h2><div class="diagram"><svg/)
    expect(html).toContain('<h2>Truth table</h2>')
    expect(html).toContain('A·B + A·C + B·C')
    expect(html).toContain('(A + B)·(A + C)·(B + C)')
    expect(html).toContain('<h2>K-map for Y</h2>')
    expect(html).toContain('7400 (Quad 2-input NAND)')
    expect(html).toContain('<h2>Breadboard steps</h2>')
    expect(html).toContain('<h2>Observations</h2>')
    const md = reportMarkdown(c, { title: 'Voting box', project: '', date: at })
    expect(md).toContain('| A | B | C | Y |')
    expect(md).toContain('- **Y** = A·B + A·C + B·C (SOP)')
  })

  it('includes a state machine’s table and equations', () => {
    const html = reportHtml(buildFsmCircuit(exampleFsm()), { title: 'Detector', project: '', date: at })
    expect(html).toContain('<h2>State machine (Moore)</h2>')
    expect(html).toContain('<b>D0</b> = ')
    expect(html).not.toContain('<h2>K-map')
  })

  it('escapes names', () => {
    expect(reportHtml({ version: 1, parts: [], wires: [] }, { title: '<b>x</b>', project: '', date: at })).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
