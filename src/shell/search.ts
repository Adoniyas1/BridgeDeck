/** One result in Search everything (⌘K). */
export type Hit = { id: string; group: string; title: string; detail?: string; run: () => void }

/** How well `query` matches: every word must appear; earlier and title matches rank higher. 0 = no match. */
export function score(query: string, title: string, detail = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  const t = title.toLowerCase()
  const d = detail.toLowerCase()
  let total = 0
  for (const w of words) {
    if (t.startsWith(w)) total += 4
    else if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) total += 3
    else if (t.includes(w)) total += 2
    else if (d.includes(w)) total += 1
    else return 0
  }
  return total
}

/** The best `limit` hits of one group, best first (ties keep their order). */
export function best<T>(items: T[], query: string, text: (item: T) => [string, string?], limit: number): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(query, ...text(item)) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map(x => x.item)
}

/** A typed text that looks like a web address. */
export function looksLikeUrl(text: string) {
  const t = text.trim()
  return /^https?:\/\/\S+$/i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)
}
