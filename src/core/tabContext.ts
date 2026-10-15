/** What's open in a tab, as text, for Mimir: a tab that has something worth asking about (a circuit,
 *  a program) describes it, and Mimir's chat can attach the last such tab you were working in. */
import { useEffect, useRef } from 'react'
import { tabsStore } from './tabs'

export type TabContext = { title: string; text: string }
const providers = new Map<string, () => TabContext | null>()

/** Registers what `tabId` shows (`describe` is called only when Mimir asks); returns the undo. */
export function registerTabContext(tabId: string, describe: () => TabContext | null): () => void {
  providers.set(tabId, describe)
  return () => { if (providers.get(tabId) === describe) providers.delete(tabId) }
}

/** registerTabContext for a page, always with its latest state. */
export function useTabContext(tabId: string, describe: () => TabContext | null) {
  const latest = useRef(describe)
  latest.current = describe
  useEffect(() => registerTabContext(tabId, () => latest.current()), [tabId])
}

/** The most recently used tab that can describe itself (not Mimir's own), and what it shows. */
export function workContext(): TabContext | null {
  for (const id of tabsStore.get().history) {
    if (id === 'mimir') continue
    const describe = providers.get(id)
    if (!describe) continue
    try {
      const ctx = describe()
      if (ctx) return { title: ctx.title, text: ctx.text.slice(0, 16000) }
    } catch { /* a tab that can't describe itself right now */ }
  }
  return null
}
