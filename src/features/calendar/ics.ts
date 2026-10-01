import type { CalEvent, CalRepeat } from '../../lib/bridge'
import { addDays } from './model'

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function escape(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function unescape(text: string) {
  return text.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** Lines longer than 75 bytes continue on the next line after a space (RFC 5545). */
function fold(line: string) {
  const bytes = new TextEncoder()
  const out: string[] = []
  let current = ''
  for (const char of line) {
    if (bytes.encode(current + char).length > (out.length ? 74 : 75)) { out.push(current); current = '' }
    current += char
  }
  out.push(current)
  return out.join('\r\n ')
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function utc(ms: number) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function localDate(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function rrule(r: CalRepeat, allDay: boolean) {
  const parts = [`FREQ=${r.freq.toUpperCase()}`]
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.freq === 'weekly' && r.days.length) parts.push(`BYDAY=${r.days.map(d => BYDAY[d]).join(',')}`)
  if (r.count) parts.push(`COUNT=${r.count}`)
  else if (r.until) parts.push(`UNTIL=${allDay ? localDate(r.until) : utc(r.until)}`)
  return parts.join(';')
}

/** Events as an iCalendar file other calendar apps can import. */
export function toIcs(events: CalEvent[], now = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BridgeDeck//Calendar//EN', 'CALSCALE:GREGORIAN']
  for (const e of events.filter(x => !x.deleted)) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@bridgedeck`, `DTSTAMP:${utc(now)}`, `SUMMARY:${escape(e.title)}`)
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${localDate(e.start)}`, `DTEND;VALUE=DATE:${localDate(Math.max(e.end, addDays(e.start, 1)))}`)
    else lines.push(`DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end)}`)
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`)
    if (e.notes) lines.push(`DESCRIPTION:${escape(e.notes)}`)
    if (e.repeat) lines.push(`RRULE:${rrule(e.repeat, e.allDay)}`)
    if (e.skip.length) lines.push(e.allDay ? `EXDATE;VALUE=DATE:${e.skip.map(localDate).join(',')}` : `EXDATE:${e.skip.map(utc).join(',')}`)
    if (e.reminder != null) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escape(e.title)}`, `TRIGGER:-PT${e.reminder}M`, 'END:VALARM')
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

type Prop = { name: string; params: Record<string, string>; value: string }

function parseLine(line: string): Prop | null {
  // NAME;PARAM=x;PARAM="y:z":value — the first colon outside quotes ends the name and params.
  let quoted = false
  let split = -1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) { split = i; break }
  }
  if (split < 0) return null
  const [name, ...params] = line.slice(0, split).split(';')
  return {
    name: name.toUpperCase(),
    params: Object.fromEntries(params.map(p => { const [k, ...v] = p.split('='); return [k.toUpperCase(), v.join('=').replace(/^"|"$/g, '')] })),
    value: line.slice(split + 1),
  }
}

/** Offset of a time zone from UTC at a moment, in ms. */
function zoneOffset(ms: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(ms / 1000) * 1000
}

/** A date or date-time value as ms, and whether it was a whole day. */
export function parseTime(value: string, params: Record<string, string> = {}): { ms: number; allDay: boolean } | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  if (m[4] === undefined || params.VALUE === 'DATE') return { ms: new Date(y, mo, d).getTime(), allDay: true }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (m[7]) return { ms: Date.UTC(y, mo, d, h, mi, s), allDay: false }
  if (params.TZID) {
    try {
      const guess = Date.UTC(y, mo, d, h, mi, s)
      let ms = guess - zoneOffset(guess, params.TZID)
      ms = guess - zoneOffset(ms, params.TZID)
      return { ms, allDay: false }
    } catch { /* unknown zone: read it as local time */ }
  }
  return { ms: new Date(y, mo, d, h, mi, s).getTime(), allDay: false }
}

function parseDuration(value: string) {
  const m = value.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const minutes = Number(m[2] ?? 0) * 7 * 1440 + Number(m[3] ?? 0) * 1440 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0) + Number(m[6] ?? 0) / 60
  return (m[1] === '-' ? -1 : 1) * minutes
}

function idFrom(uid: string, index: number) {
  const clean = uid.replace(/[^A-Za-z0-9-]/g, '')
  if (clean && clean.length <= 56) return `ics-${clean}`
  let hash = 0
  for (const c of uid) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0
  return `ics-${(hash >>> 0).toString(36)}-${clean.slice(0, 40) || index}`
}

/** Events from an iCalendar file. Repeats BridgeDeck can't express exactly (for example "the
 *  second Tuesday") come in as their basic frequency. Changed single occurrences come in as their
 *  own events and are skipped in the series. */
export function fromIcs(text: string): CalEvent[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const events: CalEvent[] = []
  const overrides: Array<{ uid: string; at: number }> = []
  let current: Prop[] | null = null
  let depth = 0
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^BEGIN:VEVENT$/i.test(line)) { current = []; depth = 0; continue }
    if (!current) continue
    if (/^BEGIN:/i.test(line)) { depth++; if (/VALARM/i.test(line)) current.push({ name: 'X-ALARM-START', params: {}, value: '' }); continue }
    if (/^END:VEVENT$/i.test(line)) {
      const event = build(current, events.length)
      if (event) {
        events.push(event.event)
        if (event.override) overrides.push(event.override)
      }
      current = null
      continue
    }
    if (/^END:/i.test(line)) { depth--; continue }
    const prop = parseLine(line)
    if (prop) current.push(depth > 0 ? { ...prop, name: `ALARM-${prop.name}` } : prop)
  }
  for (const { uid, at } of overrides) {
    const series = events.find(e => e.id === idFrom(uid, 0) && e.repeat)
    if (series && !series.skip.includes(at)) series.skip.push(at)
  }
  return events
}

function build(props: Prop[], index: number): { event: CalEvent; override?: { uid: string; at: number } } | null {
  const get = (name: string) => props.find(p => p.name === name)
  const start = get('DTSTART') && parseTime(get('DTSTART')!.value, get('DTSTART')!.params)
  if (!start) return null
  const uid = get('UID')?.value ?? `${index}`
  const recurrenceId = get('RECURRENCE-ID')
  const endProp = get('DTEND')
  let end = endProp ? parseTime(endProp.value, endProp.params)?.ms ?? null : null
  if (end === null) {
    const duration = get('DURATION') && parseDuration(get('DURATION')!.value)
    end = duration ? start.ms + duration * 60_000 : start.allDay ? addDays(start.ms, 1) : start.ms
  }
  let repeat: CalRepeat | null = null
  const rule = get('RRULE')?.value
  if (rule && !recurrenceId) {
    const parts = Object.fromEntries(rule.split(';').map(p => { const [k, v] = p.split('='); return [k.toUpperCase(), v ?? ''] }))
    const freq = parts.FREQ?.toLowerCase()
    if (freq === 'daily' || freq === 'weekly' || freq === 'monthly' || freq === 'yearly') {
      repeat = {
        freq,
        interval: Math.max(1, Number(parts.INTERVAL) || 1),
        days: freq === 'weekly' && parts.BYDAY ? parts.BYDAY.split(',').map((d: string) => BYDAY.indexOf(d.replace(/^[+-]?\d+/, '').toUpperCase())).filter((d: number) => d >= 0) : [],
        until: parts.UNTIL ? parseTime(parts.UNTIL)?.ms ?? null : null,
        count: parts.COUNT ? Number(parts.COUNT) || null : null,
      }
    }
  }
  const skip = props.filter(p => p.name === 'EXDATE').flatMap(p => p.value.split(',').map(v => parseTime(v, p.params)?.ms).filter((v): v is number => v !== undefined))
  const trigger = props.find(p => p.name === 'ALARM-TRIGGER' && !p.params.VALUE)
  const before = trigger ? parseDuration(trigger.value) : null
  return {
    event: {
      id: recurrenceId ? `${idFrom(uid, index)}-${start.ms.toString(36)}` : idFrom(uid, index),
      title: unescape(get('SUMMARY')?.value ?? '').slice(0, 300),
      start: start.ms,
      end: Math.max(end, start.ms),
      allDay: start.allDay,
      location: unescape(get('LOCATION')?.value ?? '').slice(0, 300),
      notes: unescape(get('DESCRIPTION')?.value ?? '').slice(0, 10_000),
      color: 'blue',
      repeat,
      skip,
      reminder: before !== null && before <= 0 ? Math.round(-before) : null,
      updated: 0, by: '', deleted: false, seq: 0,
    },
    override: recurrenceId ? { uid, at: parseTime(recurrenceId.value, recurrenceId.params)?.ms ?? start.ms } : undefined,
  }
}
