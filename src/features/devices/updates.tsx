import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import { isTauri, upgradeCheck, upgradeInfo, upgradeSelf, type UpdateCheck } from '../../lib/bridge'
import { configStore, setConfig, useConfig } from '../../core/config'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { Card, SectionTitle, Toggle } from '../../ui'
import { hostStore } from '../remote/state'

type Updates = UpdateCheck & { checking: boolean; checkedAt: number; error?: string; installing: boolean }

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
  updatesStore.set(u => ({ ...u, installing: true }))
  try {
    await upgradeSelf()
  } catch (error) {
    updatesStore.set(u => ({ ...u, installing: false, error: errorText(error, 'Could not start the update') }))
  }
}

/** Checks GitHub at start-up and every six hours; announces new changes once; installs them when
 *  automatic updates are on and nobody is controlling this computer. */
export function UpdatesBackground() {
  const updates = useStore(updatesStore)
  const auto = useStore(configStore).updates.auto
  const controlled = useStore(hostStore).sessions.length > 0
  usePeriodicRefresh(checkForUpdates, CHECK_EVERY, [])

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
  const when = updates.checkedAt ? new Date(updates.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const subtitle = !updates.git && updates.checkedAt ? 'This build wasn’t installed from a git clone, so it can’t update itself'
    : updates.behind ? `${updates.behind} new change${updates.behind === 1 ? '' : 's'} on ${updates.upstream}${updates.latest ? ` · ${updates.latest}` : ''}`
    : when ? `Up to date (checked ${when})` : 'Checks GitHub every six hours'
  return <Card><SectionTitle title="Updates" subtitle={subtitle} />
    <Toggle checked={config.updates.auto} onChange={auto => setConfig(c => ({ ...c, updates: { auto } }))} label="Install updates automatically (BridgeDeck rebuilds and restarts; never while this computer is being controlled)" />
    <div className="actions">
      <button className="secondary" disabled={updates.checking} onClick={() => void checkForUpdates()}><RefreshCw size={16}/>{updates.checking ? 'Checking…' : 'Check now'}</button>
      {updates.behind > 0 && <button disabled={updates.installing} onClick={() => void installUpdate()}>{updates.installing ? 'Updating…' : 'Update now'}</button>}
    </div>
    {updates.error && <p className="error-text">{updates.error}</p>}
  </Card>
}
