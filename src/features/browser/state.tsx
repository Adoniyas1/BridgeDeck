import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri, notesCreate, notesSave, type Note } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { notify } from '../../core/notify'
import { createStore, useStore } from '../../core/store'
import { between, newId, visible } from '../notes/model'
import { notesStore, refreshNotes } from '../notes/state'
import { addHistory, pageName, SENT_FOLDER, SENT_TITLE, sentLine, sentNote, sentPages, type Page } from './model'
import { AdblockBackground } from './WebSettings'

const HISTORY_KEY = 'bridgedeck.browser.history'

function loadHistory(): Page[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(list) ? list.filter((p): p is Page => typeof p?.url === 'string' && typeof p?.title === 'string' && typeof p?.at === 'number') : []
  } catch { return [] }
}

/** Pages visited in the Browser tab, newest first (kept on this computer only). */
export const historyStore = createStore<Page[]>(loadHistory())

export function remember(page: Page) {
  historyStore.set(list => addHistory(list, page))
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyStore.get())) } catch { /* history is a convenience */ }
}

export function clearHistory() {
  historyStore.set([])
  try { localStorage.removeItem(HISTORY_KEY) } catch { /* nothing to clear */ }
}

/** A file a web page downloaded (to the Downloads folder; src-tauri/src/browser.rs). */
export type Download = { url: string; path: string; state: 'started' | 'done' | 'failed'; at: number }
export const downloadsStore = createStore<Download[]>([])
export const dismissDownload = (url: string) => downloadsStore.set(list => list.filter(d => d.url !== url))

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path
export const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '')

/** Sends a page to the other computer(s): a line in the synced "Sent pages" checklist, which the
 *  other computer's Browser shows on its start page (and announces). */
export async function sendPage(page: { url: string; title: string }) {
  await refreshNotes()
  let note: Note | undefined = sentNote(notesStore.get())
  if (!note) {
    const created = await notesCreate('list', SENT_FOLDER)
    // A new list starts with one empty item: it is removed, and the list named.
    note = await notesSave({ id: created.id, title: SENT_TITLE, removed: created.blocks.map(b => b.id) })
  }
  const last = visible(note).at(-1)
  const block = { id: newId(), kind: 'todo' as const, text: sentLine(page), checked: false, due: null, pos: between(last?.pos ?? '', ''), updated: Date.now(), by: '', deleted: false }
  const saved = await notesSave({ id: note.id, blocks: [block] })
  notesStore.set(list => list.some(n => n.id === saved.id) ? list.map(n => n.id === saved.id ? saved : n) : [saved, ...list])
}

/** Ticks a sent page off once it has been opened here (on both computers). */
export async function markSentOpened(blockId: string) {
  const note = sentNote(notesStore.get())
  const block = note?.blocks.find(b => b.id === blockId)
  if (!note || !block) return
  const saved = await notesSave({ id: note.id, blocks: [{ ...block, checked: true }] })
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
}

export function useSentPages() {
  const notes = useStore(notesStore)
  const me = useStore(bridgeLinkStore).instanceId
  return sentPages(notes, me)
}

const started = Date.now()
const announced = new Set<string>()

/** The Browser's background work: the ad blocker's settings, downloads, and pages sent from the
 *  other computer (announced once each). */
export function BrowserBackground() {
  useEffect(() => {
    if (!isTauri()) return
    const stop = listen<{ url: string; path: string | null; state: Download['state'] }>('browser-download', e => {
      const { url, path, state } = e.payload
      downloadsStore.set(list => [{ url, path: path ?? '', state, at: Date.now() }, ...list.filter(d => d.url !== url)].slice(0, 8))
      if (state === 'done') notify('files', 'Download finished', path ? fileName(path) : url)
      if (state === 'failed') notify('files', 'Download failed', path ? fileName(path) : url)
    })
    return () => void stop.then(fn => fn()).catch(() => undefined)
  }, [])

  const sent = useSentPages()
  useEffect(() => {
    for (const page of sent) {
      if (announced.has(page.blockId)) continue
      announced.add(page.blockId)
      if (page.at >= started - 60_000) notify('files', 'Page from your other computer', `${pageName(page)} · open the Browser tab to see it`)
    }
  }, [sent])

  return <AdblockBackground />
}
