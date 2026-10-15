/** A lab report for a circuit: its diagram, truth table, K-map, simplified expressions, the state
 *  machine's table and equations if it has one, the chips and the wiring, and space for the
 *  observations. As a page to print (or save as a PDF) and as Markdown for a note. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { breadboard } from './boardLayout'
import { analyze } from './fsm'
import { chipPlan, expressions, kmapLayout, posExpressions, simulate, truthTable, type Circuit, type TruthTable } from './model'
import { CircuitPreview } from './Preview'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type Report = { title: string; project: string; date: Date }

type Sections = {
  table: TruthTable
  sop: Record<string, string>
  pos: Record<string, string>
  fsm: ReturnType<typeof analyze> | null
  plan: ReturnType<typeof chipPlan>
  steps: string[]
}

function sections(c: Circuit): Sections {
  const table = truthTable(c)
  const combinational = !table.error && !table.sequential && table.inputs.length > 0 && table.outputs.length > 0
  return {
    table,
    sop: combinational ? expressions(table) : {},
    pos: combinational ? posExpressions(table) : {},
    fsm: c.fsm && c.fsm.states.length ? analyze(c.fsm) : null,
    plan: chipPlan(c),
    steps: c.parts.length ? breadboard(c, c.board).steps.map(s => s.text) : [],
  }
}

/** The K-map of an output as rows of cells (values in Gray-code order). */
function kmapRows(table: TruthTable, o: number) {
  const map = kmapLayout(table.inputs)
  if (!map) return null
  const bits = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1).join('')
  return {
    corner: `${map.rowVars.join('')}\\${map.colVars.join('')}`,
    cols: map.cols.map(c => bits(c, map.colVars.length)),
    rows: map.rows.map(r => ({ head: bits(r, map.rowVars.length), cells: map.cols.map(c => { const v = table.rows[map.cell(r, c)]?.out[o]; return v === null || v === undefined ? 'X' : String(v) }) })),
  }
}

const STYLE = `
body{font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:860px;margin:32px auto;padding:0 24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
.meta{color:#666;margin:0 0 20px}
table{border-collapse:collapse;margin:6px 0 12px}td,th{border:1px solid #bbb;padding:3px 10px;text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}th{background:#f2f2f2}
.out{background:#f7f7e8}.expr{font-family:ui-monospace,Menlo,Consolas,monospace;margin:2px 0}
.diagram{border:1px solid #ddd;border-radius:6px;padding:8px;text-align:center}
.diagram svg{max-width:100%;height:auto}
.blank{border:1px solid #ccc;border-radius:6px;min-height:110px}
ol li,ul li{margin:2px 0}
.logic-body{fill:#fff;stroke:#222;stroke-width:1.5}.logic-line{stroke:#222;stroke-width:1.5}.logic-wire{fill:none;stroke:#333!important;stroke-width:1.6}
.logic-gate-name{fill:#444;font-size:9px;font-weight:600}.logic-chip{fill:#f3f3f3;stroke:#222;stroke-width:1.5}.logic-notch{fill:#fff;stroke:#222}
.logic-chip-name{fill:#111;font-size:13px;font-weight:700}.logic-chip-sub,.logic-pin-label,.logic-pin-number{fill:#555;font-size:7px}.logic-chip-sub{font-size:8px}
.logic-label{fill:#111;font-size:12px;font-weight:600}.logic-small{fill:#444;font-size:10px}.logic-switch{fill:#fff;stroke:#222;stroke-width:1.5}.logic-knob{fill:#888}
.logic-power{fill:#fff;stroke:#c00;stroke-width:1.5}.logic-led{fill:#fff!important;stroke:#c00;stroke-width:2}.logic-seg7{fill:#fff;stroke:#222}.logic-segment{fill:#ddd}.logic-preview-joint{fill:#222}
@media print{body{margin:0}h2{break-after:avoid}table,.diagram{break-inside:avoid}}
`

/** The report as a web page (open it in a browser to print or save as a PDF). */
export function reportHtml(c: Circuit, r: Report): string {
  const s = sections(c)
  const svg = c.parts.length ? renderToStaticMarkup(createElement(CircuitPreview, { circuit: c, width: 820, pins: simulate(c).pins })) : ''
  const out: string[] = []
  out.push(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)} – lab report</title><style>${STYLE}</style></head><body>`)
  out.push(`<h1>${esc(r.title)}</h1><p class="meta">${esc(r.project ? `${r.project} · ` : '')}${r.date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}</p>`)
  out.push('<h2>Objective</h2><div class="blank"></div>')
  if (svg) out.push(`<h2>Circuit</h2><div class="diagram">${svg}</div>`)
  const t = s.table
  if (!t.error && t.inputs.length && t.outputs.length && t.inputs.length <= 6) {
    out.push(`<h2>${t.sequential ? 'Truth table (right after power-up)' : 'Truth table'}</h2><table><tr>${t.inputs.map(i => `<th>${esc(i)}</th>`).join('')}${t.outputs.map(o => `<th class="out">${esc(o)}</th>`).join('')}</tr>`)
    for (const row of t.rows) out.push(`<tr>${row.in.map(v => `<td>${v}</td>`).join('')}${row.out.map(v => `<td class="out">${v ?? '?'}</td>`).join('')}</tr>`)
    out.push('</table>')
  }
  if (Object.keys(s.sop).length) {
    out.push('<h2>Simplified expressions</h2>')
    for (const o of t.outputs) out.push(`<p class="expr"><b>${esc(o)}</b> = ${esc(s.sop[o])} &nbsp; (sum of products)</p><p class="expr"><b>${esc(o)}</b> = ${esc(s.pos[o])} &nbsp; (product of sums)</p>`)
    t.outputs.forEach((o, i) => {
      const k = kmapRows(t, i)
      if (!k) return
      out.push(`<h2>K-map for ${esc(o)}</h2><table><tr><th>${esc(k.corner)}</th>${k.cols.map(x => `<th>${x}</th>`).join('')}</tr>${k.rows.map(row => `<tr><th>${row.head}</th>${row.cells.map(v => `<td${v === '1' ? ' class="out"' : ''}>${v}</td>`).join('')}</tr>`).join('')}</table><p class="expr">Groups: ${esc(s.sop[o])}</p>`)
    })
  }
  if (s.fsm && c.fsm) {
    const f = s.fsm
    out.push(`<h2>State machine (${c.fsm.kind === 'moore' ? 'Moore' : 'Mealy'})</h2><p>States: ${c.fsm.states.map(st => esc(st.name)).join(', ')}. ${f.flipFlops} D flip-flop${f.flipFlops === 1 ? '' : 's'}; the start state is coded ${f.bits.map(() => '0').join('')}.</p>`)
    out.push(`<table><tr><th>State</th><th>${f.bits.join('')}</th>${c.fsm.inputs.map(i => `<th>${esc(i)}</th>`).join('')}<th>Next</th><th>${f.bits.map(b => `D${b.slice(1)}`).join('')}</th>${c.fsm.outputs.map(o => `<th class="out">${esc(o)}</th>`).join('')}</tr>`)
    for (const row of f.rows) out.push(`<tr><td>${esc(row.state)}</td><td>${row.code.toString(2).padStart(f.bits.length, '0')}</td>${row.input.map(b => `<td>${b}</td>`).join('')}<td>${esc(row.next)}</td><td>${row.nextCode.toString(2).padStart(f.bits.length, '0')}</td>${c.fsm.outputs.map(o => `<td class="out">${row.out[o]}</td>`).join('')}</tr>`)
    out.push('</table>')
    for (const e of f.equations) out.push(`<p class="expr"><b>${esc(e.name)}</b> = ${esc(e.expr)}</p>`)
  }
  if (s.plan.chips.length) {
    out.push(`<h2>Parts</h2><ul>${s.plan.chips.map(ch => `<li>${esc(ch.ref)}: ${esc(ch.part)} (${esc(ch.name)})</li>`).join('')}</ul>`)
    out.push(`<h2>Wiring</h2><ul>${s.plan.connections.map(x => `<li><b>${esc(x.net)}</b>: ${esc(x.pins.join(', '))}</li>`).join('')}</ul>`)
  }
  if (s.steps.length) out.push(`<h2>Breadboard steps</h2><ol>${s.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>`)
  out.push('<h2>Observations</h2><div class="blank"></div><h2>Conclusion</h2><div class="blank"></div>')
  out.push('</body></html>')
  return out.join('\n')
}

/** The same report as Markdown, for a note (no picture). */
export function reportMarkdown(c: Circuit, r: Report): string {
  const s = sections(c)
  const t = s.table
  const md: string[] = [`*${r.project ? `${r.project} · ` : ''}${r.date.toLocaleDateString()}*`, '', '## Objective', '', '']
  if (!t.error && t.inputs.length && t.outputs.length && t.inputs.length <= 6) {
    md.push(`## Truth table${t.sequential ? ' (right after power-up)' : ''}`, '', `| ${[...t.inputs, ...t.outputs].join(' | ')} |`, `| ${[...t.inputs, ...t.outputs].map(() => '---').join(' | ')} |`)
    for (const row of t.rows) md.push(`| ${[...row.in, ...row.out.map(v => v ?? '?')].join(' | ')} |`)
    md.push('')
  }
  if (Object.keys(s.sop).length) {
    md.push('## Simplified expressions', '')
    for (const o of t.outputs) md.push(`- **${o}** = ${s.sop[o]} (SOP)`, `- **${o}** = ${s.pos[o]} (POS)`)
    md.push('')
  }
  if (s.fsm && c.fsm) {
    md.push(`## State machine (${c.fsm.kind === 'moore' ? 'Moore' : 'Mealy'})`, '', ...s.fsm.equations.map(e => `- **${e.name}** = ${e.expr}`), '')
  }
  if (s.plan.chips.length) {
    md.push('## Parts', '', ...s.plan.chips.map(ch => `- ${ch.ref}: ${ch.part} (${ch.name})`), '', '## Wiring', '', ...s.plan.connections.map(x => `- **${x.net}**: ${x.pins.join(', ')}`), '')
  }
  if (s.steps.length) md.push('## Breadboard steps', '', ...s.steps.map((x, i) => `${i + 1}. ${x}`), '')
  md.push('## Observations', '', '', '## Conclusion', '')
  return md.join('\n')
}
