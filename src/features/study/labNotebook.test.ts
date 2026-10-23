import { describe, expect, it } from 'vitest'
import { runLines } from '../../lib/expr'
import { parseNetlist, solve } from '../../lib/mna'
import { labNotebookMarkdown } from './labNotebook'

describe('lab notebook', () => {
  it('starts with a circuit and sums that work', () => {
    const md = labNotebookMarkdown('EE 210', 'Lab 3: dividers', new Date(2026, 9, 23))
    const fence = (kind: string) => md.split(`\`\`\`${kind}\n`)[1].split('\n```')[0]
    expect(() => solve(parseNetlist(fence('spice')))).not.toThrow()
    const lines = runLines(fence('calc'))
    expect(lines.filter(l => l.error)).toEqual([])
    expect(lines.at(-1)!.result).toBe('1.387')
  })
})
