import { useEffect, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { isTauri, upgradeCheck, upgradeInfo, upgradeSelf, upgradeSetupSigning, type UpdateCheck, type UpgradeInfo } from '../../lib/bridge'
import { configStore, setConfig, useConfig } from '../../core/config'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { Card, SectionTitle, Toggle } from '../../ui'
import { hostStore } from '../remote/state'

type Updates = UpdateCheck & { checking: boolean; checkedAt: number; error?: string; installing: boolean; progress?: UpgradeInfo }

export const updatesStore = createStore<Updates>({ git: false, behind: 0, upstream: '', latest: '', checking: false, checkedAt: 0, installing: false })

const CHECK_EVERY = 6 * 60 * 60_000
let announced = 0

export async function checkForUpdates() {
  if (!isTauri() || updatesStore.get().checking) return
  updatesStore.set(u => ({ ...u, checking: true }))
  try {
    const result = await upgradeCheck()
    updatesStore.set(u => ({ ...u, ...result, checking: false, checkedAt: Date.now(), error: undefined }))
  } catch (error) {
    updatesStore.set(u => ({ ...u, checking: false, checkedAt: Date.now(), error: errorText(error, 'Could not check for updates') }))
  }
}

/** Pulls the new version from GitHub, rebuilds and restarts (see `upgrade.rs`). */
export async function installUpdate() {
  // On a Mac, offer once to keep permissions across updates before the first update without it.
  const info = await upgradeInfo().catch(() => null)
  if (info?.signing === 'missing' && !signingOffered()) {
    markSigningOffered()
    if (window.confirm('Keep macOS permissions (Screen Recording, Accessibility, Full Disk Access…) after this and future updates?\n\nBridgeDeck makes a free signing certificate on this Mac (nothing is sent anywhere). macOS asks for your password once to trust it.')) {
      await setupSigning()
    }
  }
  updatesStore.set(u => ({ ...u, installing: true, error: undefined }))
  try {
    await upgradeSelf()
    void followUpdate()
  } catch (error) {
    updatesStore.set(u => ({ ...u, installing: false, error: errorText(error, 'Could not start the update') }))
  }
}

const OFFERED_KEY = 'bd-signing-offered'
function signingOffered() { try { return localStorage.getItem(OFFERED_KEY) === '1' } catch { return false } }
function markSigningOffered() { try { localStorage.setItem(OFFERED_KEY, '1') } catch { /* asked again next time */ } }

/** Sets up the local signing certificate; the result shows on the Updates card. */
export async function setupSigning() {
  try {
    await upgradeSetupSigning()
    signingStore.set({ state: 'ready', message: 'Done. Allow the permissions once more after the next update; they stay from then on.' })
  } catch (error) {
    signingStore.set({ state: 'missing', message: errorText(error, 'Couldn’t set it up') })
  }
}

export const signingStore = createStore<{ state: 'ready' | 'missing' | null; message: string }>({ state: null, message: '' })

/** What the update is doing, read from its status file (written by upgrade.rs and the self-update
 *  script). A failure shows its reason and the end of its log; the card stops saying "Updating…". */
export async function followUpdate() {
  const info = await upgradeInfo().catch(() => null)
  if (!info) return
  const { state, message } = info.status
  const wasInstalling = updatesStore.get().installing
  updatesStore.set(u => ({
    ...u, progress: info,
    installing: state === 'running',
    error: state === 'failed' ? message || 'The update failed' : u.error,
  }))
  // (An installed update restarts BridgeDeck; this is for updates that finish without restarting.)
  if (wasInstalling && state === 'succeeded' && message) notify('updates', 'BridgeDeck', message)
}

/** Checks GitHub at start-up and every six hours; announces new changes once; installs them when
 *  automatic updates are on and nobody is controlling this computer. */
export function UpdatesBackground() {
  const updates = useStore(updatesStore)
  const auto = useStore(configStore).updates.auto
  const controlled = useStore(hostStore).sessions.length > 0
  usePeriodicRefresh(checkForUpdates, CHECK_EVERY, [])
  // Follow a running update every few seconds (and look once at start-up, to show how the last one went).
  useEffect(() => { void followUpdate() }, [])
  usePeriodicRefresh(async () => { if (updatesStore.get().installing) await followUpdate() }, 3000, [])

  useEffect(() => {
    if (!updates.behind || updates.installing) return
    const installNow = auto && !controlled
    if (updates.behind > announced) {
      announced = updates.behind
      notify('updates', installNow ? 'Updating BridgeDeck' : 'BridgeDeck update available', `${updates.behind} new change${updates.behind === 1 ? '' : 's'}${updates.latest ? `: ${updates.latest}` : ''}.${installNow ? ' BridgeDeck restarts when it’s done.' : ' Update from the Home tab.'}`)
    }
    if (!installNow) return
    void upgradeInfo().then(info => {
      // A failed update isn't retried on its own for a day (the Home tab still offers it).
      const failedRecently = info?.status.state === 'failed' && Date.now() - info.status.updatedAt < 24 * 60 * 60_000
      if (info && info.status.state !== 'running' && !failedRecently) void installUpdate()
    }).catch(() => undefined)
  }, [updates.behind, updates.installing, auto, controlled])
  return null
}

export function UpdatesCard() {
  const config = useConfig()
  const updates = useStore(updatesStore)
  const signing = useStore(signingStore)
  const [settingUp, setSettingUp] = useState(false)
  useEffect(() => { void upgradeInfo().then(info => { if (info) signingStore.set(s => ({ ...s, state: s.state ?? info.signing })) }).catch(() => undefined) }, [])
  const when = updates.checkedAt ? new Date(updates.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const subtitle = !updates.git && updates.checkedAt ? 'This build wasn’t installed from a git clone, so it can’t update itself'
    : updates.behind ? `${updates.behind} new change${updates.behind === 1 ? '' : 's'} on ${updates.upstream}${updates.latest ? ` · ${updates.latest}` : ''}`
    : when ? `Up to date (checked ${when})` : 'Checks GitHub every six hours'
  return <Card><SectionTitle title="Updates" subtitle={subtitle} />
    <Toggle checked={config.updates.auto} onChange={auto => setConfig(c => ({ ...c, updates: { auto } }))} label="Install updates automatically (BridgeDeck rebuilds and restarts; never while this computer is being controlled)" />
    <div className="actions">
      <button className="secondary" disabled={updates.checking} onClick={() => void checkForUpdates()}><RefreshCw size={16}/>{updates.checking ? 'Checking…' : 'Check now'}</button>
      {(updates.behind > 0 || updates.progress?.status.state === 'failed') && <button disabled={updates.installing} onClick={() => void installUpdate()}>{updates.installing ? 'Updating…' : updates.progress?.status.state === 'failed' ? 'Try again' : 'Update now'}</button>}
    </div>
    {signing.state === 'missing' && <div className="update-signing">
      <p className="hint">macOS asks for Screen Recording, Accessibility and other permissions again after every update, because each build looks like a new app. Set this up once and they stay.</p>
      <button className="secondary" disabled={settingUp} onClick={() => { setSettingUp(true); void setupSigning().finally(() => setSettingUp(false)) }}><KeyRound size={16} />{settingUp ? 'Setting up… (enter your password if macOS asks)' : 'Keep permissions after updates'}</button>
    </div>}
    {signing.message && <p className={signing.state === 'ready' ? 'hint' : 'error-text'}>{signing.message}</p>}
    {updates.installing && updates.progress?.status.state === 'running' && <p className="hint">Updating: {updates.progress.status.message || 'starting'}… BridgeDeck closes and opens again when it’s installed.</p>}
    {updates.error && <p className="error-text">{updates.error}</p>}
    {!!updates.progress?.logTail.length && updates.progress.status.state !== 'idle' && <details className="update-log">
      <summary>{updates.progress.status.state === 'failed' ? 'What went wrong (end of the update log)' : 'Update log'}</summary>
      <pre>{updates.progress.logTail.join('\n')}</pre>
    </details>}
  </Card>
}
