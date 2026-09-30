import type { Permissions } from '../../lib/bridge'

/** Everything the "Needs attention" card looks at. */
export type HealthInput = {
  pairingRunning: boolean
  pairedCount: number
  /** This computer is a Mac (it reads Messages and can be controlled only with its permissions). */
  mac: boolean
  messages: { ready: boolean; detail: string }
  permissions: Permissions | null
  remoteAllowed: boolean
  sync: { builtin: boolean; available: boolean; running: boolean }
  receiver: { enabled: boolean; running: boolean }
  clipboard: { on: boolean; available: boolean }
  conflicts: number
  /** Things that are normal for a few seconds after start-up aren't reported until this is true. */
  settled: boolean
}

export type Fix = 'start-pairing' | 'pair' | 'files-access' | 'screen-recording' | 'accessibility' | 'start-sync' | 'start-receiver' | 'open-sync'
export type Issue = { id: string; title: string; detail: string; fix?: { label: string; action: Fix } }

/** What's wrong, most important first, each with the one click that fixes it where there is one. */
export function healthIssues(input: HealthInput): Issue[] {
  const issues: Issue[] = []
  if (input.settled && !input.pairingRunning) {
    issues.push({ id: 'pairing', title: 'Pairing is stopped', detail: 'Your computers can’t find or reach each other.', fix: { label: 'Start pairing', action: 'start-pairing' } })
  } else if (input.settled && !input.pairedCount) {
    issues.push({ id: 'unpaired', title: 'No computer paired yet', detail: 'Open BridgeDeck on your other computer, then pair them.', fix: { label: 'Pair', action: 'pair' } })
  }
  if (input.mac && !input.messages.ready && /Full Disk Access/i.test(input.messages.detail)) {
    issues.push({ id: 'messages', title: 'Messages needs Full Disk Access', detail: 'Turn it on for BridgeDeck (or the Terminal it runs from), then quit and reopen BridgeDeck.', fix: { label: 'Open Full Disk Access', action: 'files-access' } })
  }
  if (input.remoteAllowed && input.permissions?.screenRecording === false) {
    issues.push({ id: 'screen', title: 'Remote control can’t see this screen', detail: 'Allow BridgeDeck under Screen Recording so your other computer can see it.', fix: { label: 'Open Screen Recording', action: 'screen-recording' } })
  }
  if (input.remoteAllowed && input.permissions?.accessibility === false) {
    issues.push({ id: 'accessibility', title: 'Remote control can’t use the mouse and keyboard', detail: 'Allow BridgeDeck under Accessibility.', fix: { label: 'Open Accessibility', action: 'accessibility' } })
  }
  if (input.settled && input.sync.builtin && input.sync.available && !input.sync.running) {
    issues.push({ id: 'sync', title: 'Sync is stopped', detail: 'Shared folders aren’t syncing.', fix: { label: 'Start sync', action: 'start-sync' } })
  }
  if (input.settled && input.receiver.enabled && !input.receiver.running) {
    issues.push({ id: 'receiver', title: 'Not receiving files', detail: 'Other computers can’t send files here.', fix: { label: 'Start receiving', action: 'start-receiver' } })
  }
  if (input.conflicts) {
    issues.push({ id: 'conflicts', title: `${input.conflicts} sync conflict${input.conflicts === 1 ? '' : 's'}`, detail: 'A file was changed on two computers; pick the version to keep.', fix: { label: 'Review', action: 'open-sync' } })
  }
  if (input.settled && input.clipboard.on && !input.clipboard.available) {
    issues.push({ id: 'clipboard', title: 'Clipboard sharing isn’t working', detail: 'BridgeDeck couldn’t open this computer’s clipboard. Restart BridgeDeck to try again.' })
  }
  return issues
}
