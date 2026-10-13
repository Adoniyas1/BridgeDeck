import { useEffect, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { isTauri, upgradeCheck, upgradeInfo, upgradeRelease, upgradeSelf, upgradeSetupSigning, type UpdateCheck, type UpgradeInfo } from '../../lib/bridge'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
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

/** A newer ready-built release this computer can install. */
export const releaseReady = (u: UpdateCheck) => !!u.release?.installable

/** Installs the new version: the ready-built release from GitHub when there is one (download and
 *  replace, no rebuild), else pulls the source and rebuilds (`fromSource`, or no release). */
export async function installUpdate(fromSource = false) {
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
    if (!fromSource && releaseReady(updatesStore.get())) await upgradeRelease()
    else await upgradeSelf()
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

/** Checks GitHub at start-up and every six hours and announces a new version once. Nothing installs
 *  on its own: the banner (UpdateBanner) and Settings → Updates offer it, and you choose when. */
export function UpdatesBackground() {
  const updates = useStore(updatesStore)
  usePeriodicRefresh(checkForUpdates, CHECK_EVERY, [])
  // Follow a running update every few seconds (and look once at start-up, to show how the last one went).
  useEffect(() => { void followUpdate() }, [])
  usePeriodicRefresh(async () => { if (updatesStore.get().installing) await followUpdate() }, 3000, [])

  useEffect(() => {
    const key = pendingKey(updates)
    if (!key || updates.installing || key <= announced) return
    announced = key
    notify('updates', 'BridgeDeck update available', `${pendingText(updates)} Open BridgeDeck to update.`)
  }, [updates])
  return null
}

/** Something to install: a number that grows with each newer version (0 for nothing). */
function pendingKey(u: Updates) {
  if (releaseReady(u)) return 1_000_000 + u.release!.version.split('.').reduce((n, p) => n * 1000 + (Number(p) || 0), 0)
  return u.behind
}
const pendingText = (u: Updates) => releaseReady(u) ? `Version ${u.release!.version} is ready.` : `${u.behind} new change${u.behind === 1 ? '' : 's'}${u.latest ? `: ${u.latest}` : ''}.`

const DISMISSED_KEY = 'bridgedeck.updateDismissed'
const readDismissed = () => { try { return Number(localStorage.getItem(DISMISSED_KEY)) || 0 } catch { return 0 } }

/** The banner at the top when there's an update: Update now, or close it until a newer one comes. */
export function UpdateBanner() {
  const updates = useStore(updatesStore)
  const controlled = useStore(hostStore).sessions.length > 0
  const [dismissed, setDismissed] = useState(readDismissed)
  const key = pendingKey(updates)
  if (!key || (key <= dismissed && !updates.installing)) return null
  const close = () => { setDismissed(key); try { localStorage.setItem(DISMISSED_KEY, String(key)) } catch { /* this run only */ } }
  return <div className="notice update-banner">
    <RefreshCw size={15} />
    <span>{updates.installing ? `Updating BridgeDeck${updates.progress?.status.message ? `: ${updates.progress.status.message}` : ''}… it restarts when it’s done.` : `BridgeDeck update available. ${pendingText(updates)}`}</span>
    {!updates.installing && <button className="update-banner__go" disabled={controlled} title={controlled ? 'Not while this computer is being controlled' : 'Install it now; BridgeDeck restarts'} onClick={() => void installUpdate()}>Update now</button>}
    {!updates.installing && <button title="Not now (shows again for a newer version)" aria-label="Close" onClick={close}>×</button>}
  </div>
}

export function UpdatesCard() {
  const updates = useStore(updatesStore)
  const signing = useStore(signingStore)
  const [settingUp, setSettingUp] = useState(false)
  useEffect(() => { void upgradeInfo().then(info => { if (info) signingStore.set(s => ({ ...s, state: s.state ?? info.signing })) }).catch(() => undefined) }, [])
  const when = updates.checkedAt ? new Date(updates.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const release = releaseReady(updates) ? updates.release! : null
  const subtitle = release ? `Version ${release.version} is ready (this is ${updates.version ?? 'older'}) · installs in a minute, no rebuild`
    : !updates.git && updates.checkedAt ? `Up to date${updates.version ? ` (version ${updates.version})` : ''}${when ? `, checked ${when}` : ''}`
    : updates.behind ? `${updates.behind} new change${updates.behind === 1 ? '' : 's'} on ${updates.upstream}${updates.latest ? ` · ${updates.latest}` : ''}`
    : when ? `Up to date (checked ${when})` : 'Checks GitHub every six hours'
  return <Card><SectionTitle title="Updates" subtitle={subtitle} />
    <p className="hint">Updates never install on their own: a banner offers each new version, and you choose when.</p>
    <div className="actions">
      <button className="secondary" disabled={updates.checking} onClick={() => void checkForUpdates()}><RefreshCw size={16}/>{updates.checking ? 'Checking…' : 'Check now'}</button>
      {(release || updates.behind > 0 || updates.progress?.status.state === 'failed') && <button disabled={updates.installing} onClick={() => void installUpdate()}>{updates.installing ? 'Updating…' : updates.progress?.status.state === 'failed' ? 'Try again' : release ? `Install version ${release.version}` : 'Update now'}</button>}
      {release && updates.behind > 0 && <button className="secondary" disabled={updates.installing} title="Pull the newest source from GitHub and build it here (several minutes); has changes not yet in a release" onClick={() => void installUpdate(true)}>Rebuild from source</button>}
    </div>
    {signing.state === 'missing' && <div className="update-signing">
      <p className="hint">macOS asks for Screen Recording, Accessibility and other permissions again after every update, because each build looks like a new app. Set this up once and they stay.</p>
      <button className="secondary" disabled={settingUp} onClick={() => { setSettingUp(true); void setupSigning().finally(() => setSettingUp(false)) }}><KeyRound size={16} />{settingUp ? 'Setting up… (enter your password if macOS asks)' : 'Keep permissions after updates'}</button>
    </div>}
    {signing.message && <p className={signing.state === 'ready' ? 'hint' : 'error-text'}>{signing.message}</p>}
    {release?.notes && !updates.installing && <details className="update-log"><summary>What’s new in {release.version}</summary><pre>{release.notes}</pre></details>}
    {updates.installing && updates.progress?.status.state === 'running' && <p className="hint">Updating: {updates.progress.status.message || 'starting'}… BridgeDeck closes and opens again when it’s installed.</p>}
    {updates.error && <p className="error-text">{updates.error}</p>}
    {!!updates.progress?.logTail.length && updates.progress.status.state !== 'idle' && <details className="update-log">
      <summary>{updates.progress.status.state === 'failed' ? 'What went wrong (end of the update log)' : 'Update log'}</summary>
      <pre>{updates.progress.logTail.join('\n')}</pre>
    </details>}
  </Card>
}
