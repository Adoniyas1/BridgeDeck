import { askChatGPT, toggleChatPanel } from './chatgpt'
import { createStore, useStore } from './store'
import { activateTab, splitTab, tabsStore, unsplit } from './tabs'

/** Shortcuts that work all over BridgeDeck, web pages included (src-tauri/src/webkeys.rs passes
 *  them on from a focused page). `key` is what's pressed with ⌘ on a Mac, Ctrl on Windows. */
export type ShortcutName = 'search' | 'chatgpt' | 'ask' | 'shortcuts' | 'new-tab' | 'close-tab' | 'address' | 'code' | 'split' | 'jarvis'
export const SHORTCUTS: Array<{ keys: string; what: string; name?: ShortcutName; shift?: boolean; key?: string }> = [
  { keys: 'K', what: 'Search everything: tabs, notes, books, bookmarks, history', name: 'search', key: 'k' },
  { keys: 'J', what: 'Open or close the ChatGPT panel', name: 'chatgpt', key: 'j' },
  { keys: 'Shift A', what: 'Ask ChatGPT about the selected text (on any tab or web page)', name: 'ask', shift: true, key: 'a' },
  { keys: 'Shift O', what: 'Fill in the latest verification code from Messages (and copy it)', name: 'code', shift: true, key: 'o' },
  { keys: 'Shift J', what: 'Mimir, ready to talk (Jarvis)', name: 'jarvis', shift: true, key: 'j' },
  { keys: '/', what: 'This list of shortcuts', name: 'shortcuts', key: '/' },
  { keys: '1–9', what: 'Go to the first, second… tab' },
  { keys: '\\', what: 'Split screen: the tab used before this one beside it (again: one tab)', name: 'split', key: '\\' },
  { keys: 'T', what: 'Browser: new tab', name: 'new-tab', key: 't' },
  { keys: 'W', what: 'Browser: close the tab', name: 'close-tab', key: 'w' },
  { keys: 'L', what: 'Browser: go to the address bar', name: 'address', key: 'l' },
]
/** Ctrl on every computer (as in browsers). */
export const CTRL_SHORTCUTS = [{ keys: 'Ctrl Tab', what: 'Next tab (Ctrl Shift Tab: the one before)' }]

export const onMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
export const MOD = onMac ? '⌘' : 'Ctrl'

/** Search everything (⌘K) and the shortcuts list (⌘/). Web pages are hidden while either is open,
 *  since they sit above BridgeDeck's own window contents. */
export const paletteStore = createStore(false)
export const shortcutsHelpStore = createStore(false)
/** A tab's sub-tab menu or the checklist popup is open over the page. */
export const tabMenuStore = createStore(false)
export const overlayOpen = () => paletteStore.get() || shortcutsHelpStore.get() || tabMenuStore.get()

/** A Browser command for the Browser tab to carry out (it's on screen when one is sent). */
/** `adopt`: a page moved out into its own tab comes back as a Browser tab (`page` is its id). */
export const browserCommandStore = createStore<{ name: 'new-tab' | 'close-tab' | 'address' | 'open' | 'adopt'; url?: string; page?: string; title?: string; at: number } | null>(null)

/** Opens a web address in the Browser tab (in a new tab unless the current one is empty). */
export function openInBrowser(url: string) {
  browserCommandStore.set({ name: 'open', url, at: Date.now() })
  activateTab('browser')
}

/** Asks for the latest verification code to be filled in (the tab bar's code chip does it). */
export const codeRequestStore = createStore(0)

/** Asks for Mimir in Jarvis's Talk view (the Mimir feature opens it). */
export const jarvisRequestStore = createStore(0)

export function useOverlayOpen() {
  const palette = useStore(paletteStore)
  const help = useStore(shortcutsHelpStore)
  const menu = useStore(tabMenuStore)
  return palette || help || menu
}

/** The shortcut a key press is, if any (⌘ on a Mac, Ctrl elsewhere; never with Alt). */
export function shortcutFor(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac = onMac): ShortcutName | null {
  if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey || (mac && e.ctrlKey)) return null
  const key = e.key.toLowerCase()
  return SHORTCUTS.find(s => s.name && s.key === key && !!s.shift === e.shiftKey)?.name ?? null
}

/** A prompt asking ChatGPT about a passage someone selected. */
export function askPrompt(text: string, url?: string | null) {
  const passage = text.replace(/\s+/g, ' ').trim()
  return `Explain this in plain words${url ? ` (it's from ${url})` : ''}, then give me one example:\n\n"${passage}"`
}

/** Carries out a shortcut. Returns false when it doesn't apply here (the key then does what it normally does). */
export function runShortcut(name: ShortcutName, from: { text?: string; url?: string | null } = {}): boolean {
  switch (name) {
    case 'search': shortcutsHelpStore.set(false); paletteStore.set(open => !open); return true
    case 'shortcuts': paletteStore.set(false); shortcutsHelpStore.set(open => !open); return true
    case 'chatgpt': toggleChatPanel(); return true
    case 'code': codeRequestStore.set(Date.now()); return true
    case 'jarvis': jarvisRequestStore.set(Date.now()); return true
    case 'split': {
      const { split, history, active } = tabsStore.get()
      const previous = history.find(id => id !== active)
      if (split) unsplit()
      else if (previous) splitTab(previous)
      return true
    }
    case 'ask': {
      const text = (from.text ?? (typeof window !== 'undefined' ? String(window.getSelection() ?? '') : '')).trim()
      void askChatGPT(text ? askPrompt(text, from.url) : undefined)
      return true
    }
    case 'new-tab': case 'close-tab': case 'address':
      if (tabsStore.get().active !== 'browser') return false
      browserCommandStore.set({ name, at: Date.now() })
      return true
  }
}
