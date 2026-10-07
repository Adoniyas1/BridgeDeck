import { useEffect, useState } from 'react'
import { Download, FolderOpen, PackagePlus, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { adblockAllowSites, adblockOptions, adblockSet, adblockStatus, adblockUpdate, extensionsAdd, extensionsGetUblock, extensionsList, extensionsRemove, isTauri, pickExtension, type AdblockStatus, type BrowserExtension } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { errorText } from '../../core/util'
import { Card, SectionTitle, Toggle } from '../../ui'
import { siteOf } from './model'
import { SpeedCard } from './SpeedCard'

const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/** Keeps the blocker as the settings say (the settings live with BridgeDeck's settings). */
export function AdblockBackground() {
  const { adblock: on, allowAds, annoyances, popups, popupSites } = useConfig().browsing
  useEffect(() => { if (isTauri()) void adblockSet(on).catch(() => undefined) }, [on])
  const sites = allowAds.join(',')
  useEffect(() => { if (isTauri()) void adblockAllowSites(sites ? sites.split(',') : []).catch(() => undefined) }, [sites])
  const popupList = popupSites.join(',')
  useEffect(() => { if (isTauri()) void adblockOptions(annoyances, popups, popupList ? popupList.split(',') : []).catch(() => undefined) }, [annoyances, popups, popupList])
  return null
}


/** The shield in the Browser and TV bars: whether ads are blocked on this page's site, and a
 *  click to allow them there (or block them again). The page reloads with the change. */
export function AdShield({ url }: { url: string }) {
  const config = useConfig()
  const site = siteOf(url)
  if (!config.browsing.adblock || !site || !/^https?:/.test(url)) return null
  const allowed = config.browsing.allowAds.includes(site)
  const toggle = () => setConfig(c => ({ ...c, browsing: { ...c.browsing, allowAds: allowed ? c.browsing.allowAds.filter(s => s !== site) : [...c.browsing.allowAds, site] } }))
  return <button type="button" className={`cal-icon ad-shield${allowed ? ' off' : ''}`} title={allowed ? `Ads are allowed on ${site}. Click to block them again.` : `Blocking ads on ${site}. Click to allow ads on this site (if it breaks or asks you to).`} onClick={toggle}>
    {allowed ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
  </button>
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
    <SpeedCard />
    <Card><SectionTitle title="Ad and pop-up blocker" subtitle="For the Browser and TV tabs and the ChatGPT panel" action={<ShieldCheck size={18} />} />
      <Toggle checked={config.browsing.adblock} onChange={adblock => setConfig(c => ({ ...c, browsing: { ...c.browsing, adblock } }))} label="Block ads and trackers" />
      <Toggle checked={config.browsing.popups} onChange={popups => setConfig(c => ({ ...c, browsing: { ...c.browsing, popups } }))} label="Block pop-ups (a page opening another site by itself, and pop-up ads)" />
      <Toggle checked={config.browsing.annoyances} onChange={annoyances => setConfig(c => ({ ...c, browsing: { ...c.browsing, annoyances } }))} label="Remove cookie banners, newsletter boxes and other annoyances" />
      <p className="hint">{status?.servers
        ? `${status.lists} lists: ${status.servers.toLocaleString()} blocking rules, ${status.hiding.toLocaleString()} hiding rules, ${status.scriptlets.toLocaleString()} site fixes against ad and anti-ad-blocker scripts${updated ? ` · updated ${updated}` : ''}`
        : 'Getting the block lists (EasyList, EasyPrivacy, uBlock Origin’s and Peter Lowe’s)…'}</p>
      {status?.error && <p className="error-text">{status.error}</p>}
      <div className="actions"><button className="secondary" disabled={!!busy} onClick={() => void run('update', async () => { setStatus(await adblockUpdate()); setMessage('Block lists updated.') })}><RefreshCw size={15} />{busy === 'update' ? 'Updating…' : 'Update lists now'}</button></div>
      {config.browsing.allowAds.length > 0 && <div className="ad-allowed"><span className="hint">Ads allowed on:</span>{config.browsing.allowAds.map(site => <button key={site} className="ghost" title={`Block ads on ${site} again`} onClick={() => setConfig(c => ({ ...c, browsing: { ...c.browsing, allowAds: c.browsing.allowAds.filter(x => x !== site) } }))}>{site} ×</button>)}</div>}
      {config.browsing.popupSites.length > 0 && <div className="ad-allowed"><span className="hint">Pop-ups allowed on:</span>{config.browsing.popupSites.map(site => <button key={site} className="ghost" title={`Block pop-ups on ${site} again`} onClick={() => setConfig(c => ({ ...c, browsing: { ...c.browsing, popupSites: c.browsing.popupSites.filter(x => x !== site) } }))}>{site} ×</button>)}</div>}
      <p className="hint">Uses EasyList, EasyPrivacy, uBlock Origin’s own lists (ads, privacy, malware, quick fixes) and Peter Lowe’s ad servers, updated every few days, plus uBlock-style site fixes run inside pages (they stop most YouTube ads and “turn off your ad blocker” walls) and a YouTube ad skipper. Links that open a new window open in a new Browser tab; sign-in windows open as real pop-ups. If a site breaks, the shield in the address bar allows its ads.</p>
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
