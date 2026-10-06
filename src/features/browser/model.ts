import type { Note } from '../../lib/bridge'
import { visible } from '../notes/model'

/** A page the person visited or saved. */
export type Page = { url: string; title: string; at: number }

/** The note that carries pages sent between computers (a checklist; ticked once opened). */
export const SENT_FOLDER = 'Browser'
export const SENT_TITLE = 'Sent pages'
export const HISTORY_MAX = 300

/** The site of a page ("en.wikipedia.org", "www." dropped), as kept in the ad blocker's allowed list. */
export function siteOf(url: string) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

/** What a tab or bookmark is called: its title, else its site. */
export function pageName(page: { url: string; title: string }) {
  return page.title.trim() || siteOf(page.url) || page.url
}

/** History with `page` added at the top (one entry per address, newest first, capped). */
export function addHistory(history: Page[], page: Page): Page[] {
  if (!/^https?:/.test(page.url)) return history
  const before = history.find(h => h.url === page.url)
  const entry = { ...page, title: page.title || before?.title || '' }
  return [entry, ...history.filter(h => h.url !== page.url)].slice(0, HISTORY_MAX)
}

/** History entries matching what's typed (title or address), for the address bar's suggestions. */
export function searchHistory(history: Page[], typed: string, limit = 6): Page[] {
  const q = typed.trim().toLowerCase()
  if (!q) return []
  return history.filter(h => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q)).slice(0, limit)
}

/** A sent page as a checklist line: a Markdown link, which the note shows as a link. */
export function sentLine(page: { url: string; title: string }) {
  const label = pageName(page).replace(/[[\]\n]/g, ' ').trim().slice(0, 200)
  return `[${label}](${page.url.replace(/[\s)]/g, c => c === ')' ? '%29' : encodeURIComponent(c))})`
}

export type SentPage = { blockId: string; url: string; title: string; at: number; from: string }

/** Pages another computer sent here that haven't been opened yet, newest first. */
export function sentPages(notes: Note[], me: string): SentPage[] {
  const out: SentPage[] = []
  for (const note of notes) {
    if (note.deleted || note.folder !== SENT_FOLDER || note.title !== SENT_TITLE) continue
    for (const block of visible(note)) {
      if (block.checked || !me || block.by === me) continue
      const m = /^\[(?<title>[^\]]*)\]\((?<url>https?:\/\/[^\s)]+)\)$/.exec(block.text.trim())
      if (m?.groups) out.push({ blockId: block.id, url: m.groups.url, title: m.groups.title, at: block.updated, from: block.by })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** The sent-pages note, if there is one. */
export function sentNote(notes: Note[]) {
  return notes.find(n => !n.deleted && n.folder === SENT_FOLDER && n.title === SENT_TITLE)
}
