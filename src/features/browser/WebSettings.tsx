import { useEffect, useState } from 'react'
import { Download, FolderOpen, PackagePlus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { adblockSet, adblockStatus, adblockUpdate, extensionsAdd, extensionsGetUblock, extensionsList, extensionsRemove, isTauri, pickExtension, type AdblockStatus, type BrowserExtension } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { errorText } from '../../core/util'
import { Card, SectionTitle, Toggle } from '../../ui'

const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/** Keeps the ad blocker on or off as the settings say (the setting lives with BridgeDeck's settings). */
export function AdblockBackground() {
  const on = useConfig().browsing.adblock
  useEffect(() => { if (isTauri()) void adblockSet(on).catch(() => undefined) }, [on])
  return null
}

/** Settings → Web pages: the ad blocker, and Chrome extensions on Windows. */
export function WebSettings() {
  const config = useConfig()
  const [status, setStatus] = useState<AdblockStatus | null>(null)
  const [extensions, setExtensions] = useState<BrowserExtension[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isTauri()) return
    const load = () => { void adblockStatus().then(setStatus).catch(() => undefined) }
    load()
    void extensionsList().then(setExtensions).catch(() => undefined)
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setMessage('')
    try { await action() } catch (e) { setError(errorText(e, 'That didn’t work')) } finally { setBusy('') }
  }

  const addExtension = (folder: boolean) => run('add', async () => {
    const path = await pickExtension(folder)
    if (!path) return
    const added = await extensionsAdd(path)
    setExtensions(await extensionsList())
    setMessage(`Added ${added.name}. Restart BridgeDeck to use it.`)
  })

  const updated = status?.updated ? new Date(status.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''
  return <>
    <Card><SectionTitle title="Ad blocker" subtitle="For the Browser and TV tabs and the ChatGPT panel" action={<ShieldCheck size={18} />} />
      <Toggle checked={config.browsing.adblock} onChange={adblock => setConfig(c => ({ ...c, browsing: { adblock } }))} label="Block ads and trackers" />
      <p className="hint">{status?.servers
        ? `${status.servers.toLocaleString()} ad and tracker servers blocked${onWindows ? '' : `, ${status.hiding.toLocaleString()} kinds of ads hidden`} · EasyList and EasyPrivacy${updated ? `, updated ${updated}` : ''}`
        : 'Getting the EasyList and EasyPrivacy block lists…'}</p>
      {status?.error && <p className="error-text">{status.error}</p>}
      <div className="actions"><button className="secondary" disabled={!!busy} onClick={() => void run('update', async () => { setStatus(await adblockUpdate()); setMessage('Block lists updated.') })}><RefreshCw size={15} />{busy === 'update' ? 'Updating…' : 'Update lists now'}</button></div>
      <p className="hint">Lists update by themselves every few days. Video ads inside a site’s own player (YouTube’s, for one) come from the site itself and usually get through; on Windows, uBlock Origin Lite below catches more of them.</p>
    </Card>
    <Card><SectionTitle title="Extensions" subtitle={onWindows ? 'Chrome extensions for web pages in BridgeDeck' : 'Chrome extensions work on Windows only'} />
      {onWindows ? <>
        {extensions.length ? <div className="stack">{extensions.map(x => <div className="service-row" key={x.id}>
          <PackagePlus size={16} /><div className="grow"><strong>{x.name}{x.version ? ` ${x.version}` : ''}</strong><small>{x.description}</small></div>
          <button className="ghost" title={`Remove ${x.name}`} onClick={() => void run('remove', async () => { await extensionsRemove(x.id); setExtensions(await extensionsList()); setMessage(`Removed ${x.name}. Restart BridgeDeck to finish.`) })}><Trash2 size={15} /></button>
        </div>)}</div> : <p className="hint">No extensions yet.</p>}
        <div className="actions">
          <button disabled={!!busy} onClick={() => void run('ubol', async () => { const x = await extensionsGetUblock(); setExtensions(await extensionsList()); setMessage(`Added ${x.name} ${x.version}. Restart BridgeDeck to use it.`) })}><Download size={15} />{busy === 'ubol' ? 'Getting it…' : 'Get uBlock Origin Lite'}</button>
          <button className="secondary" disabled={!!busy} onClick={() => void addExtension(false)}><PackagePlus size={15} />Add from a .crx or .zip file</button>
          <button className="secondary" disabled={!!busy} onClick={() => void addExtension(true)}><FolderOpen size={15} />Add an unpacked folder</button>
        </div>
        <p className="hint">The Chrome Web Store can’t install into BridgeDeck directly: download the extension’s .crx or .zip (most open-source ones publish one), or use an unpacked folder. Extensions load when BridgeDeck starts.</p>
      </> : <p className="hint">On this Mac, web pages in BridgeDeck use Safari’s engine (WebKit), which can’t run Chrome extensions. The ad blocker above works here; on the Windows PC, extensions such as uBlock Origin Lite can be added too.</p>}
      {message && <p className="hint">{message}</p>}
      {error && <p className="error-text">{error}</p>}
    </Card>
  </>
}
