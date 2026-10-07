import type { CalEvent, Note } from '../../lib/bridge'
import { boardColumns, isDoneColumn } from './model'

// ---- Parts list and budget ----

/** One line of a project's parts list (parts.csv in the project folder). */
export type PartRow = { item: string; qty: number; price: number; supplier: string; link: string; bought: boolean; notes: string }
export const PART_COLUMNS = ['Item', 'Qty', 'Unit price', 'Supplier', 'Link', 'Bought', 'Notes']

/** Rows of a CSV file (quoted fields, doubled quotes, commas and new lines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && !field) quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim())) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim())) rows.push(row)
  return rows
}

const cell = (v: string) => (/[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** "$1,234.50" → 1234.5. */
export const money = (text: string) => { const n = Number(text.replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0 }

export function readParts(text: string | null): PartRow[] {
  if (!text) return []
  const rows = parseCsv(text)
  const head = rows[0]?.map(h => h.trim().toLowerCase()) ?? []
  const at = (name: string, fallback: number) => { const i = head.findIndex(h => h.startsWith(name)); return i >= 0 ? i : fallback }
  const known = head.includes('item')
  const col = { item: at('item', 0), qty: at('qty', 1), price: at('unit', 2), supplier: at('supplier', 3), link: at('link', 4), bought: at('bought', 5), notes: at('notes', 6) }
  return rows.slice(known ? 1 : 0).map(r => ({
    item: r[col.item]?.trim() ?? '', qty: Math.max(0, money(r[col.qty] ?? '1') || 0), price: money(r[col.price] ?? '0'),
    supplier: r[col.supplier]?.trim() ?? '', link: r[col.link]?.trim() ?? '', bought: /^(y|yes|x|true|1|✓)$/i.test(r[col.bought]?.trim() ?? ''), notes: r[col.notes]?.trim() ?? '',
  })).filter(p => p.item)
}

export function writeParts(parts: PartRow[]): string {
  return [PART_COLUMNS, ...parts.map(p => [p.item, String(p.qty), p.price.toFixed(2), p.supplier, p.link, p.bought ? 'yes' : '', p.notes])].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function partsTotals(parts: PartRow[], budget: number | null) {
  const total = parts.reduce((sum, p) => sum + p.qty * p.price, 0)
  const spent = parts.filter(p => p.bought).reduce((sum, p) => sum + p.qty * p.price, 0)
  return { total, spent, toBuy: total - spent, left: budget == null ? null : budget - total, over: budget != null && total > budget }
}

export type ProjectSettings = { budget: number | null; currency: string }
export function readSettings(text: string | null): ProjectSettings {
  try {
    const raw = JSON.parse(text ?? '{}') as Partial<ProjectSettings>
    return { budget: typeof raw.budget === 'number' && Number.isFinite(raw.budget) ? raw.budget : null, currency: typeof raw.currency === 'string' && raw.currency.length <= 4 ? raw.currency : '$' }
  } catch { return { budget: null, currency: '$' } }
}

// ---- Timeline ----

export type TimelineItem = { id: string; title: string; start: number; end: number; kind: 'task' | 'milestone'; column: string; done: boolean }

/** "[3d]" or "[2w]" in a card's text: how long the work takes, ending on its due date. */
export function durationDays(text: string) {
  const m = text.match(/\[(\d{1,3})\s*(d|w)\]/i)
  return m ? Number(m[1]) * (m[2].toLowerCase() === 'w' ? 7 : 1) : 1
}

const DAY = 86_400_000
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

/** Board cards with due dates (as bars ending on their due day) and milestones, in date order. */
export function timelineItems(board: Note | undefined, milestones: CalEvent[], now = Date.now()): TimelineItem[] {
  const items: TimelineItem[] = []
  if (board) for (const column of boardColumns(board)) for (const card of column.cards) {
    if (!card.block.due) continue
    const end = startOfDay(card.block.due) + DAY
    items.push({ id: card.block.id, title: card.block.text.replace(/\s*\[\d{1,3}\s*[dw]\]/i, '').trim() || 'Untitled', start: end - durationDays(card.block.text) * DAY, end, kind: 'task', column: column.title, done: card.block.checked || isDoneColumn(column.title) })
  }
  for (const e of milestones) items.push({ id: e.id, title: e.title, start: startOfDay(e.start), end: startOfDay(e.start) + DAY, kind: 'milestone', column: '', done: e.end < now })
  return items.sort((a, b) => a.end - b.end || a.title.localeCompare(b.title))
}

/** The days the timeline shows: from a few days before the first item (or today) to after the last. */
export function timelineSpan(items: TimelineItem[], now = Date.now()): [number, number] {
  const today = startOfDay(now)
  const from = Math.min(today, ...items.map(i => i.start)) - 2 * DAY
  const to = Math.max(today + 14 * DAY, ...items.map(i => i.end)) + 3 * DAY
  return [startOfDay(from), startOfDay(to)]
}
