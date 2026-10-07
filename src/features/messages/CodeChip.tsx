import { useEffect, useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import { browserFillCode, clipboardPut, isTauri } from '../../lib/bridge'
import { notify } from '../../core/notify'
import { codeRequestStore, MOD } from '../../core/shortcuts'
import { setNotice } from '../../core/notice'
import { createStore, useStore } from '../../core/store'
import { spacedCode } from './codes'

/** A code is offered for five minutes, like the one above the iPhone keyboard. */
const OFFER_MS = 5 * 60_000

export type FoundCode = { code: string; from: string; at: number }
export const codeStore = createStore<FoundCode | null>(null)

async function copy(code: string) {
  try { await clipboardPut(code) } catch { await navigator.clipboard?.writeText(code).catch(() => undefined) }
}

/** A text with a one-time code came in: it's copied (paste with ⌘V / Ctrl V) and offered in the tab bar. */
export function gotCode(code: string, from: string) {
  codeStore.set({ code, from, at: Date.now() })
  void copy(code)
  notify('messages', `${spacedCode(code)} · copied`, `Code from ${from}. Paste it, or press ${MOD} Shift O in BridgeDeck to fill it in.`, true)
}

/** Fills the latest code into the browser page on screen and copies it again: "Filled" or "Copied". */
async function fillCode(found: FoundCode) {
  await copy(found.code)
  const pages = isTauri() ? await browserFillCode(found.code).catch(() => 0) : 0
  return pages ? 'Filled' : 'Copied'
}

/** In the tab bar: the latest code. Clicking (or ⌘⇧O / Ctrl Shift O anywhere) fills it into the
 *  browser page on screen and copies it again. */
export function CodeChip() {
  const found = useStore(codeStore)
  const request = useStore(codeRequestStore)
  const [done, setDone] = useState('')
  useEffect(() => {
    if (!found) return
    setDone('')
    const timer = window.setTimeout(() => codeStore.set(null), Math.max(0, found.at + OFFER_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [found])
  const use = async () => {
    const current = codeStore.get()
    if (!current) { setNotice(`No verification code in the last few minutes (${MOD} Shift O fills one in when it arrives).`); return }
    setDone(await fillCode(current))
    window.setTimeout(() => setDone(''), 1500)
  }
  useEffect(() => { if (request) void use() }, [request])
  if (!found) return null
  return <div className="code-chip" title={`Code from ${found.from}. Click (or ${MOD} Shift O) to fill it into the page on screen; it's on the clipboard too.`}>
    <button className="code-chip-use" onClick={() => void use()}><KeyRound size={13} /><b>{done || spacedCode(found.code)}</b></button>
    <button className="code-chip-close" aria-label="Dismiss the code" onClick={() => codeStore.set(null)}><X size={12} /></button>
  </div>
}
