import { describe, expect, it } from 'vitest'
import type { CalEvent, Note } from '../../lib/bridge'
import { durationDays, parseCsv, partsTotals, readParts, readSettings, timelineItems, timelineSpan, writeParts } from './plan'

describe('parts list', () => {
  it('reads and writes CSV, quotes and all', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n\r\n1,"two\nlines",3')).toEqual([['a', 'b, c', 'say "hi"'], ['1', 'two\nlines', '3']])
    const parts = readParts('Item,Qty,Unit price,Supplier,Link,Bought,Notes\n74HC00,2,$0.45,DigiKey,https://x,yes,\n"Resistor, 330Ω",10,0.02,,,,1/4 W\n')
    expect(parts).toEqual([
      { item: '74HC00', qty: 2, price: 0.45, supplier: 'DigiKey', link: 'https://x', bought: true, notes: '' },
      { item: 'Resistor, 330Ω', qty: 10, price: 0.02, supplier: '', link: '', bought: false, notes: '1/4 W' },
    ])
    expect(readParts(writeParts(parts))).toEqual(parts)
    expect(writeParts(parts).split('\r\n')[2]).toBe('"Resistor, 330Ω",10,0.02,,,,1/4 W')
  })

  it('totals against the budget', () => {
    const parts = readParts('Item,Qty,Unit price,Supplier,Link,Bought\nBoard,1,25,,,yes\nMotor,2,10,,,\n')
    expect(partsTotals(parts, 40)).toEqual({ total: 45, spent: 25, toBuy: 20, left: -5, over: true })
    expect(partsTotals(parts, null).left).toBeNull()
    expect(readSettings('{"budget":150,"currency":"€"}')).toEqual({ budget: 150, currency: '€' })
    expect(readSettings('nonsense')).toEqual({ budget: null, currency: '$' })
  })
})

describe('timeline', () => {
  const day = (d: number) => new Date(2026, 9, d, 17).getTime()
  const block = (id: string, kind: string, text: string, pos: string, extra: object = {}) => ({ id, kind, text, pos, checked: false, due: null, updated: 0, by: '', deleted: false, ...extra })
  const board = { id: 'b', title: 'Robot — board', folder: 'Projects/Robot', deleted: false, blocks: [
    block('h1', 'h2', 'To do', 'a'), block('c1', 'todo', 'Order parts [3d]', 'b', { due: day(10) }), block('c2', 'todo', 'No date', 'c'),
    block('h2', 'h2', 'Done', 'd'), block('c3', 'todo', 'Sketch', 'e', { due: day(5), checked: true }),
  ] } as unknown as Note
  const demo = { id: 'm', title: 'Robot: demo', start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 21).getTime(), deleted: false } as CalEvent

  it('puts dated cards and milestones on it', () => {
    expect(durationDays('Solder [2w]')).toBe(14)
    expect(durationDays('Solder')).toBe(1)
    const items = timelineItems(board, [demo], new Date(2026, 9, 7).getTime())
    expect(items.map(i => [i.title, i.kind, i.column, i.done, Math.round((i.end - i.start) / 86_400_000)])).toEqual([
      ['Sketch', 'task', 'Done', true, 1], ['Order parts', 'task', 'To do', false, 3], ['Robot: demo', 'milestone', '', false, 1],
    ])
    const [from, to] = timelineSpan(items, new Date(2026, 9, 7).getTime())
    expect(new Date(from).getDate()).toBe(3)
    expect(new Date(to).getDate()).toBe(24)
  })
})
