import type { MailAccount } from '../../types'

/** Mail services with a web page that works inside BridgeDeck. */
export const MAIL_SERVICES: Array<{ name: string; url: string; hint: string }> = [
  { name: 'Outlook', url: 'https://outlook.office.com/mail/', hint: 'School or work (Microsoft 365)' },
  { name: 'Outlook.com', url: 'https://outlook.live.com/mail/', hint: 'Personal Outlook, Hotmail, Live' },
  { name: 'Gmail', url: 'https://mail.google.com/mail/', hint: 'Google' },
  { name: 'iCloud Mail', url: 'https://www.icloud.com/mail/', hint: 'Apple' },
  { name: 'Yahoo Mail', url: 'https://mail.yahoo.com/', hint: 'Yahoo' },
]

/** The browser page an account's mail is shown in (src-tauri/src/browser.rs; "mail…" pages get
 *  the unread-count script). */
export const mailPage = (account: Pick<MailAccount, 'id'>) => `mail${account.id}`

/** Unread messages from a mail page's title: Gmail's "Inbox (3) - …", or "(3) …" (Outlook, from
 *  BridgeDeck's page script, and most others). */
export function unreadFromTitle(title: string): number | null {
  const m = title.match(/\bInbox \((\d[\d,]*)\)/i) ?? title.match(/^\((\d[\d,]*)\)/)
  if (m) return Number(m[1].replace(/,/g, ''))
  return /\b(inbox|mail)\b/i.test(title) ? 0 : null
}

export const newAccountId = () => Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x').padEnd(6, '0')
