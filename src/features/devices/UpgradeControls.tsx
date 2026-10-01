import { useEffect, useState } from 'react'
import { Download, GitPullRequestArrow, Send } from 'lucide-react'
import { localSendNativeSend, OLD_PEER_ERROR, transferSend, upgradeCreateBundle, upgradeInfo, upgradePeerStatus, upgradeRequestPeer, upgradeSelf } from '../../lib/bridge'
import { waitForTransfer } from '../files/state'
import type { UpgradeInfo, UpgradeStatus } from '../../lib/bridge'
import type { DeviceConfig } from '../../types'

const errorText = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong'

/** -1, 0 or 1 comparing dotted versions ("0.8.0" < "0.8.1"). Unknown versions compare as older. */
export function compareVersions(a?: string, b?: string) {
  const parts = (v?: string) => (v ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  }
  return 0
}

function describe(status?: UpgradeStatus) {
  if (!status || status.state === 'idle' || !status.state) return ''
  if (status.state === 'running') return `Upgrading: ${status.message || status.stage}…`
  if (status.state === 'succeeded') return status.message || 'Upgrade finished'
  return `Upgrade failed: ${status.message}`
}

/** This computer's info, shared by the cards (it doesn't change while the page is open, except status). */
function useLocalUpgradeInfo() {
  const [info, setInfo] = useState<UpgradeInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => upgradeInfo().then(v => { if (!cancelled) setInfo(v) }).catch(() => undefined)
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  return info
}

/** Upgrade buttons on a device card: update this computer from GitHub, or ask a paired one to update
 *  (from GitHub by default, or from this computer's source). The other computer asks its user to allow it. */
export function UpgradeControls({ device, peerVersion, online }: { device: DeviceConfig; peerVersion?: string; online: boolean }) {
  const local = useLocalUpgradeInfo()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [remote, setRemote] = useState<UpgradeStatus | undefined>()
  const [watching, setWatching] = useState(false)

  // Follow the other computer's progress after a request (it restarts at the end, so misses are expected).
  useEffect(() => {
    if (device.local || !watching) return
    let cancelled = false
    const poll = () => upgradePeerStatus(device.id).then(r => {
      if (cancelled || !r?.status) return
      setRemote(r.status)
      if (r.status.state === 'succeeded' || r.status.state === 'failed') setWatching(false)
    }).catch(() => undefined)
    void poll()
    const timer = window.setInterval(() => void poll(), 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [device.id, device.local, watching])

  if (!local) return null

  if (device.local) {
    const running = local.status.state === 'running'
    return <div className="upgrade-row">
      <button className="secondary" disabled={!local.gitReady || running || busy} title={local.gitReady ? 'git pull, rebuild and reinstall' : 'This computer\'s BridgeDeck folder isn\'t a git clone yet'}
        onClick={async () => { setBusy(true); setMessage(''); try { await upgradeSelf() } catch (e) { setMessage(errorText(e)) } finally { setBusy(false) } }}>
        <Download size={16} />Update from GitHub
      </button>
      <small>{message || describe(local.status) || (local.gitReady ? `v${local.version}` : `v${local.version} · not a git clone, so GitHub updates are off`)}</small>
    </div>
  }

  const newerHere = compareVersions(peerVersion, local.version) < 0
  async function request(mode: 'git' | 'source') {
    setBusy(true)
    setRemote(undefined)
    try {
      if (mode === 'source') {
        setMessage('Packing this computer\'s source…')
        const bundle = await upgradeCreateBundle()
        setMessage(`Sending source (${(bundle.bytes / 1_000_000).toFixed(1)} MB)…`)
        // Over the paired link; a BridgeDeck too old for that gets it by LocalSend.
        const sent = await waitForTransfer(await transferSend(device.id, [bundle.path]))
        if (sent.state !== 'done') {
          if (!sent.error?.includes(OLD_PEER_ERROR) || !device.localsendTarget) throw new Error(sent.error || 'The source could not be sent')
          const fallback = await localSendNativeSend(device.localsendTarget, [bundle.path], device.localsendPin)
          if (!fallback.ok) throw new Error(fallback.stderr || fallback.stdout || 'The source could not be sent')
        }
        setMessage(`Waiting for approval on ${device.name}…`)
        await upgradeRequestPeer(device.id, { mode: 'source', fileName: bundle.fileName, sha256: bundle.sha256, fromVersion: local!.version })
      } else {
        setMessage(`Waiting for approval on ${device.name}…`)
        await upgradeRequestPeer(device.id, { mode: 'git', fromVersion: local!.version })
      }
      setMessage(`${device.name} approved and is upgrading. It restarts when done.`)
      setWatching(true)
    } catch (e) {
      setMessage(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return <div className="upgrade-row">
    <button disabled={!online || busy || watching} onClick={() => void request('git')} title="The other computer pulls the latest version from GitHub, rebuilds and restarts">
      <GitPullRequestArrow size={16} />Update from GitHub
    </button>
    <button className="secondary" disabled={!online || busy || watching || !local.sourceAvailable} onClick={() => void request('source')} title={`Send this computer's source (v${local.version}); ${device.name} rebuilds from it`}>
      <Send size={16} />Send my source
    </button>
    <small>{describe(remote) || message || (newerHere ? `This computer has v${local.version}; ${device.name} has ${peerVersion ? `v${peerVersion}` : 'an older version'}` : '')}</small>
  </div>
}
