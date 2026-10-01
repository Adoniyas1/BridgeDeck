import type { HealthInput } from './health'

export type SetupFix = 'pair' | 'start-pairing' | 'files-access' | 'screen-recording' | 'accessibility' | 'start-sync' | 'start-receiver' | 'open-mimir' | 'review-notifications'
export type SetupStep = { id: string; title: string; detail: string; done: boolean; optional?: boolean; fix?: { label: string; action: SetupFix } }

export type SetupInput = HealthInput & { mimirEnabled: boolean; notificationsReviewed: boolean }

/** The first-run checklist: each step is done when the live checks say so, not when it's clicked. */
export function setupSteps(input: SetupInput): SetupStep[] {
  const steps: SetupStep[] = []
  const paired = input.pairedCount > 0
  steps.push({
    id: 'pair', title: 'Pair your other computer',
    detail: paired ? `${input.pairedCount} computer${input.pairedCount === 1 ? '' : 's'} paired` : 'Open BridgeDeck on the other computer, then pair them and compare the six-digit code.',
    done: paired,
    fix: paired ? undefined : input.pairingRunning ? { label: 'Pair', action: 'pair' } : { label: 'Start pairing', action: 'start-pairing' },
  })
  if (input.mac) {
    const messagesOk = input.messages.ready || !/Full Disk Access/i.test(input.messages.detail)
    steps.push({
      id: 'messages', title: 'Let BridgeDeck read Messages',
      detail: messagesOk ? 'Full Disk Access is on' : 'Turn on Full Disk Access for BridgeDeck (or the Terminal it runs from), then quit and reopen it.',
      done: messagesOk,
      fix: messagesOk ? undefined : { label: 'Open Full Disk Access', action: 'files-access' },
    })
    if (input.remoteAllowed) {
      const screen = input.permissions?.screenRecording !== false
      const access = input.permissions?.accessibility !== false
      steps.push({
        id: 'remote', title: 'Let your other computer control this Mac',
        detail: screen && access ? 'Screen Recording and Accessibility are on' : `Allow BridgeDeck under ${[!screen && 'Screen Recording', !access && 'Accessibility'].filter(Boolean).join(' and ')}.`,
        done: screen && access,
        fix: screen && access ? undefined : !screen ? { label: 'Open Screen Recording', action: 'screen-recording' } : { label: 'Open Accessibility', action: 'accessibility' },
      })
    }
  }
  const syncOk = !input.sync.builtin || !input.sync.available || input.sync.running
  steps.push({ id: 'sync', title: 'Shared folders syncing', detail: syncOk ? 'Sync is running' : 'Sync is stopped.', done: syncOk, fix: syncOk ? undefined : { label: 'Start sync', action: 'start-sync' } })
  const filesOk = !input.receiver.enabled || input.receiver.running
  steps.push({ id: 'files', title: 'Receive files', detail: filesOk ? 'Ready to receive from your other computer' : 'Receiving is stopped.', done: filesOk, fix: filesOk ? undefined : { label: 'Start receiving', action: 'start-receiver' } })
  steps.push({
    id: 'mimir', title: 'Set up Mimir (optional)', optional: true,
    detail: input.mimirEnabled ? 'Mimir runs with BridgeDeck' : 'Your assistant with a face and a voice. It needs a few minutes to install once.',
    done: input.mimirEnabled,
    fix: input.mimirEnabled ? undefined : { label: 'Open Mimir', action: 'open-mimir' },
  })
  steps.push({
    id: 'notifications', title: 'Choose your notifications',
    detail: input.notificationsReviewed ? 'Done' : 'Messages, AI, files, sync conflicts and updates can each be turned off.',
    done: input.notificationsReviewed,
    fix: input.notificationsReviewed ? undefined : { label: 'Review', action: 'review-notifications' },
  })
  return steps
}
