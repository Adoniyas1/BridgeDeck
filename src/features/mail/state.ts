import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { browserHide, browserShow, isTauri } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { notify } from '../../core/notify'
import { createStore, useStore } from '../../core/store'
import { mailPage, unreadFromTitle } from './model'

/** Unread messages by account id, from their pages' titles. */
export const mailUnreadStore = createStore<Record<string, number>>({})
/** All accounts' unread messages together: the tab's badge. */
export const mailBadgeStore = createStore(0)
/** Pages already made (they're made once and kept, so the mail stays signed in and checked). */
export const startedPages = new Set<string>()

/** Makes an account's page without showing it, so its mail is checked before the tab is opened. */
async function startHidden(page: string, url: string) {
  if (startedPages.has(page)) return
  startedPages.add(page)
  try { await browserShow(page, url, 0, 0, 1, 1); await browserHide(page) } catch { startedPages.delete(page) }
}

/** Counts unread mail from the pages' titles, notifies about new mail, and (when that's on) opens
 *  the accounts' pages out of sight a little after BridgeDeck starts. */
export function MailBackground() {
  const mail = useStore(configStore).mail
  useEffect(() => {
    if (!isTauri()) return
    const stop = listen<{ tab: string; title: string }>('browser-title', e => {
      const account = configStore.get().mail.accounts.find(a => mailPage(a) === e.payload.tab)
      const unread = account && unreadFromTitle(e.payload.title)
      if (!account || unread == null) return
      const before = mailUnreadStore.get()[account.id]
      mailUnreadStore.set(all => ({ ...all, [account.id]: unread }))
      if (before != null && unread > before) notify('mail', `New mail · ${account.name}`, `${unread} unread`)
    })
    return () => void stop.then(f => f())
  }, [])
  useEffect(() => {
    const ids = new Set(mail.accounts.map(a => a.id))
    const recount = () => mailBadgeStore.set(Object.entries(mailUnreadStore.get()).filter(([id]) => ids.has(id)).reduce((sum, [, n]) => sum + n, 0))
    recount()
    return mailUnreadStore.subscribe(recount)
  }, [mail.accounts])
  useEffect(() => {
    if (!isTauri() || !mail.background || !mail.accounts.length) return
    const timer = window.setTimeout(() => { for (const a of mail.accounts) void startHidden(mailPage(a), a.url) }, 15_000)
    return () => window.clearTimeout(timer)
  }, [mail.background, mail.accounts])
  return null
}
