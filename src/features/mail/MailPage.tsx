import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Mail, Plus, RotateCw, Trash2, X } from 'lucide-react'
import { browserClose, browserGo, isTauri, openExternal } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { useOverlayOpen } from '../../core/shortcuts'
import { useStore } from '../../core/store'
import { usePagePlacement } from '../browser/placement'
import { blockerChangedStore } from '../browser/state'
import PopupBar from '../browser/PopupBar'
import type { MailAccount } from '../../types'
import { MAIL_SERVICES, mailPage, newAccountId } from './model'
import { mailUnreadStore, startedPages } from './state'

const SELECTED_KEY = 'bridgedeck.mail.selected'

/** Mail: Outlook, Gmail and others' own web pages inside BridgeDeck, one per account, signed in
 *  once and kept (so new mail is counted and notified while another tab is open). */
export default function MailPage({ active }: { active: boolean }) {
  const config = useConfig()
  const accounts = config.mail.accounts
  const unread = useStore(mailUnreadStore)
  const [selected, setSelectedState] = useState(() => { try { return localStorage.getItem(SELECTED_KEY) ?? '' } catch { return '' } })
  const [adding, setAdding] = useState(false)
  const account = accounts.find(a => a.id === selected) ?? accounts[0]
  const select = (id: string) => { setSelectedState(id); try { localStorage.setItem(SELECTED_KEY, id) } catch { /* convenience */ } }
  useEffect(() => { if (!accounts.length) setAdding(true) }, [accounts.length])

  function add(name: string, url: string) {
    const created: MailAccount = { id: newAccountId(), name, url }
    setConfig(c => ({ ...c, mail: { ...c.mail, accounts: [...c.mail.accounts, created].slice(0, 8) } }))
    select(created.id)
    setAdding(false)
  }

  function remove(a: MailAccount) {
    if (!window.confirm(`Remove ${a.name} from Mail? You can add it again; you may need to sign in again.`)) return
    setConfig(c => ({ ...c, mail: { ...c.mail, accounts: c.mail.accounts.filter(x => x.id !== a.id) } }))
    startedPages.delete(mailPage(a))
    if (isTauri()) void browserClose(mailPage(a)).catch(() => undefined)
  }

  return <div className="mail">
    <div className="mail-bar">
      <Mail size={16} />
      <div className="mail-accounts" role="tablist">
        {accounts.map(a => <button key={a.id} role="tab" aria-selected={a.id === account?.id && !adding} className={a.id === account?.id && !adding ? 'on' : ''} onClick={() => { select(a.id); setAdding(false) }}>
          {a.name}{unread[a.id] ? <em className="tab-badge">{unread[a.id] > 99 ? '99+' : unread[a.id]}</em> : null}
        </button>)}
        <button className={adding ? 'on' : ''} title="Add an email account" onClick={() => setAdding(v => !v)}><Plus size={13} />{accounts.length ? '' : ' Add an account'}</button>
      </div>
      <span className="grow" />
      {account && !adding && <>
        <button className="ghost" title="Reload" onClick={() => void browserGo(mailPage(account), 'reload')}><RotateCw size={14} /></button>
        <button className="ghost" title="Open in your own browser" onClick={() => void openExternal(account.url)}><ExternalLink size={14} /></button>
        <button className="ghost" title={`Remove ${account.name}`} onClick={() => remove(account)}><Trash2 size={14} /></button>
      </>}
    </div>
    {adding || !account ? <AddAccount onAdd={add} onCancel={accounts.length ? () => setAdding(false) : undefined} /> : <MailView key={account.id} account={account} show={active} />}
  </div>
}

function MailView({ account, show }: { account: MailAccount; show: boolean }) {
  const overlay = useOverlayOpen()
  const blockerChanged = useStore(blockerChangedStore)
  const area = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const page = mailPage(account)
  usePagePlacement(page, show && !overlay, area, () => { if (startedPages.has(page)) return null; startedPages.add(page); return account.url }, setError, [blockerChanged])
  return <>
    {error && <p className="cal-error">{error}</p>}
    <PopupBar tab={page} />
    <div ref={area} className="browser-area mail-area">{!isTauri() && <p className="hint">{account.name} opens here in the app.</p>}</div>
  </>
}

function AddAccount({ onAdd, onCancel }: { onAdd: (name: string, url: string) => void; onCancel?: () => void }) {
  const config = useConfig()
  const [url, setUrl] = useState('')
  const custom = url.trim().replace(/^(?!https:\/\/)/, 'https://')
  return <div className="mail-add">
    <div className="mail-add-head"><h2>Add an email account</h2>{onCancel && <button className="cal-icon" title="Close" onClick={onCancel}><X size={15} /></button>}</div>
    <p className="hint">Your mail opens here, signed in once like in a browser. BridgeDeck counts unread mail for the badge and notifies you about new mail.</p>
    <div className="mail-services">{MAIL_SERVICES.map(s => <button key={s.url} onClick={() => onAdd(s.name, s.url)}><strong>{s.name}</strong><small>{s.hint}</small></button>)}</div>
    <form className="mail-custom" onSubmit={e => { e.preventDefault(); if (/^https:\/\/[^/\s]+\.[^/\s]+/.test(custom)) onAdd(new URL(custom).hostname.replace(/^(www|mail)\./, ''), custom) }}>
      <input placeholder="Another web mail address, e.g. webmail.school.edu" value={url} onChange={e => setUrl(e.target.value)} />
      <button className="secondary" disabled={!/^https:\/\/[^/\s]+\.[^/\s]+/.test(custom)}>Add</button>
    </form>
    <label className="check mail-background"><input type="checkbox" checked={config.mail.background} onChange={e => setConfig(c => ({ ...c, mail: { ...c.mail, background: e.target.checked } }))} /> Check for new mail in the background (opens the accounts out of sight when BridgeDeck starts)</label>
    <p className="hint">Outlook for school: sign in with your school email; your school’s sign-in page opens here. Turn on notifications for new mail in Settings → Notifications.</p>
  </div>
}
