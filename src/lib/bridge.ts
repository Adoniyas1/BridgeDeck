import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type {
  AgentStatus,
  ManagedServiceState, RustDeskIdentity, RustDeskMode, ServiceKey,
  SyncthingFolder, SyncthingStatus,
} from '../types'

export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Masks credentials that could appear in error text (e.g. a `?password=` query parameter). */
export function redactSecrets(text: string) {
  return text.replace(/(password|apikey|api_key|access_token|token)=([^&\s)"']+)/gi, '$1=***')
}

async function invokeSafe<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    // Defense in depth: native commands strip URLs from network errors, but never surface a secret.
    throw typeof error === 'string' ? redactSecrets(error) : error instanceof Error ? new Error(redactSecrets(error.message)) : error
  }
}

export async function probeTcp(host: string, port: number): Promise<boolean> {
  const result = await invokeSafe<boolean>('probe_tcp', { host, port })
  return result ?? false
}

export async function fetchAgent(url: string, token = ''): Promise<AgentStatus> {
  // Native first: WebView2 blocks page fetches to LAN addresses ("Failed to fetch").
  if (isTauri()) {
    try {
      return (await invoke<AgentStatus>('agent_status', { url, token }))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: 'no-store',
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return await response.json() as AgentStatus
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Agent unavailable' }
  }
}

export async function openExternal(url: string) {
  if (isTauri()) await invokeSafe('open_external', { target: url })
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export async function openPath(path: string) {
  if (!path) return
  if (isTauri()) await invokeSafe('open_path', { path })
}

export async function appAvailable(app: string, executable?: string): Promise<boolean> {
  const result = await invokeSafe<boolean>('app_available', { serviceId: app, executable: executable || null })
  return result ?? false
}

export async function launchApp(app: string, executable?: string) {
  if (isTauri()) await invokeSafe('launch_app', { serviceId: app, executable: executable || null })
}

/** Returns the route RustDesk used ("direct LAN (ip)" or "RustDesk ID n"). */
export async function connectRustDesk(peerId: string, executable?: string, mode: RustDeskMode = 'control', host?: string): Promise<string> {
  if (!peerId) return ''
  return (await invokeSafe<string>('rustdesk_session', { peerId, executable: executable || null, mode, host: host || null })) ?? ''
}

export type ContactSaveRequest = {
  personId: string
  firstName: string
  lastName: string
  phonesAdd: string[]
  phonesRemove: string[]
  emailsAdd: string[]
  emailsRemove: string[]
}

/** Saves a contact edit in the Mac's Contacts app (directly on the Mac, via the paired Mac elsewhere). Returns the person id. */
export async function contactsSave(request: ContactSaveRequest): Promise<string> {
  const id = await invokeSafe<string>('contacts_save', { request })
  if (id === null) throw new Error('Editing contacts requires the BridgeDeck app.')
  return id
}

/** Desktop notification (new iMessages). */
export async function desktopNotify(title: string, body: string): Promise<void> {
  await invokeSafe('desktop_notify', { title, body })
}

/** Starts RustDesk in the background if it isn't running. */
export async function rustDeskEnsureRunning(executable?: string): Promise<{ running: boolean; started: boolean; detail?: string }> {
  return (await invokeSafe<{ running: boolean; started: boolean; detail?: string }>('rustdesk_ensure_running', { executable: executable || null }))
    ?? { running: false, started: false }
}

export async function rustDeskIdentity(executable?: string): Promise<RustDeskIdentity> {
  const result = await invokeSafe<RustDeskIdentity>('rustdesk_identity', { executable: executable || null })
  return result ?? { available: false, detail: 'RustDesk identity requires the native BridgeDeck app.' }
}

export async function pickTransferPaths(directory = false): Promise<string[]> {
  if (!isTauri()) return []
  const picked = await open({ multiple: !directory, directory })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}


export async function loadNativeConfig(): Promise<string | null> {
  return invokeSafe<string | null>('load_app_config')
}

export async function saveNativeConfig(raw: string): Promise<void> {
  await invokeSafe('save_app_config', { raw })
}

export async function managedServiceStatus(serviceId: ServiceKey, executable?: string): Promise<ManagedServiceState> {
  const result = await invokeSafe<ManagedServiceState>('managed_service_status', { serviceId, executable: executable || null })
  return result ?? { serviceId, running: false, managed: false, executableReady: false, detail: 'Native service management requires the Tauri app.' }
}

export async function managedServiceStart(serviceId: ServiceKey, executable?: string): Promise<ManagedServiceState> {
  const result = await invokeSafe<ManagedServiceState>('managed_service_start', { serviceId, executable: executable || null })
  if (!result) throw new Error('Native service management requires the Tauri app.')
  return result
}

export async function managedServiceStop(serviceId: ServiceKey): Promise<ManagedServiceState> {
  const result = await invokeSafe<ManagedServiceState>('managed_service_stop', { serviceId })
  if (!result) throw new Error('Native service management requires the Tauri app.')
  return result
}

/** Remote control: this computer as host. */
export type RemoteHostStatus = { supported: boolean; settings: { allow: boolean; askFirst: boolean }; sessions: Array<{ id: string; peerId: string; peerName: string; since: number }> }
export const remoteHostStatus = () => native<RemoteHostStatus>('remote_host_status')
export const remoteHostSettings = (allow: boolean, askFirst: boolean) => native<RemoteHostStatus>('remote_host_settings', { allow, askFirst })
export const remoteHostStop = () => native<RemoteHostStatus>('remote_host_stop')
/** Remote control: viewing a paired device. Frames and events arrive on `channel` (see remote/viewer.rs). */
export const remoteConnect = (peer: string, monitor: number, maxWidth: number, quality: number, onEvent: unknown) =>
  native<string>('remote_connect', { peer, monitor, maxWidth, quality, onEvent })
export const remoteFrameDrawn = (session: string) => native<void>('remote_frame_drawn', { session })
export const remoteInput = (session: string, events: unknown[]) => native<void>('remote_input', { session, events })
export const remoteSettings = (session: string, changes: { monitor?: number; maxWidth?: number; quality?: number }) =>
  native<void>('remote_settings', { session, monitor: changes.monitor ?? null, maxWidth: changes.maxWidth ?? null, quality: changes.quality ?? null })
export const remoteDisconnect = (session: string) => native<void>('remote_disconnect', { session })

/** Messages, read by BridgeDeck on the Mac. `peer`: the paired Mac's instance id, or null on the Mac itself. */
export const imessage = <T>(peer: string | null, op: Record<string, unknown>) => native<T>('imessage', { peer, op })
/** An attachment as a `data:` URL (HEIC photos arrive as JPEG). */
export const imessageAttachment = (peer: string | null, guid: string) => native<string>('imessage_attachment', { peer, guid })
export const imessageSendFile = (peer: string | null, chat: string, path: string) => native<void>('imessage_send_file', { peer, chat, path })

export async function syncthingStatus(baseUrl: string, apiKey: string): Promise<SyncthingStatus> {
  const result = await invokeSafe<SyncthingStatus>('syncthing_status', { baseUrl, apiKey })
  return result ?? { ok: false, error: 'Native Syncthing integration requires the Tauri app.' }
}

export async function syncthingFolders(baseUrl: string, apiKey: string): Promise<SyncthingFolder[]> {
  return (await invokeSafe<SyncthingFolder[]>('syncthing_folders', { baseUrl, apiKey })) ?? []
}

export async function localSendReceiverStatus(): Promise<import('../types').LocalSendReceiverStatus> {
  const result = await invokeSafe<import('../types').LocalSendReceiverStatus>('localsend_receiver_status')
  return result ?? { running: false, alias: 'BridgeDeck', port: 53317, destination: '', recent: [], devices: [], detail: 'Native receive requires the Tauri app.' }
}

export async function sourceUpdateStatus(): Promise<import('../types').SourceUpdateStatus | null> {
  return invokeSafe<import('../types').SourceUpdateStatus>('source_update_status')
}

/** Hosts (paired BridgeLink computers) whose incoming LocalSend transfers are accepted automatically. */
export async function localSendSetTrustedHosts(hosts: string[]): Promise<void> {
  await invokeSafe('localsend_set_trusted_hosts', { hosts })
}

export async function localSendReceiverStart(settings: { alias: string; destination: string; port: number; pin: string; autoAccept: boolean }): Promise<import('../types').LocalSendReceiverStatus> {
  const result = await invokeSafe<import('../types').LocalSendReceiverStatus>('localsend_receiver_start', settings)
  if (!result) throw new Error('Native receive requires the Tauri app.')
  return result
}

export async function localSendReceiverStop(): Promise<import('../types').LocalSendReceiverStatus> {
  const result = await invokeSafe<import('../types').LocalSendReceiverStatus>('localsend_receiver_stop')
  if (!result) throw new Error('Native receive requires the Tauri app.')
  return result
}

export async function localSendAccept(sessionId: string): Promise<import('../types').LocalSendReceiverStatus> {
  const result = await invokeSafe<import('../types').LocalSendReceiverStatus>('localsend_accept', { sessionId })
  if (!result) throw new Error('Native receive requires the Tauri app.')
  return result
}

export async function localSendDecline(sessionId: string): Promise<import('../types').LocalSendReceiverStatus> {
  const result = await invokeSafe<import('../types').LocalSendReceiverStatus>('localsend_decline', { sessionId })
  if (!result) throw new Error('Native receive requires the Tauri app.')
  return result
}

export async function localSendNativeSend(target: string, paths: string[], pin = ''): Promise<import('../types').LocalSendTransferResult> {
  const result = await invokeSafe<import('../types').LocalSendTransferResult>('localsend_send_native', { target, paths, pin })
  if (!result) throw new Error('Native LocalSend transfer requires the Tauri app.')
  return result
}

export async function bridgeLinkStart(displayName: string, apiPort: number, rustdeskId: string, localsendPort: number, syncthingId = ''): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_start', { displayName, apiPort, rustdeskId, localsendPort, syncthingId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkStop(): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_stop')
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkStatus(): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_status')
  return result ?? { running: false, instanceId: '', displayName: 'BridgeDeck', platform: '', apiPort: 41416, discovered: [], pending: [], paired: [], detail: 'Automatic pairing requires the native BridgeDeck app.' }
}

export async function bridgeLinkRequestPair(peerInstanceId: string): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_request_pair', { peerInstanceId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkPollPair(): Promise<import('../types').BridgeLinkPairResult> {
  const result = await invokeSafe<import('../types').BridgeLinkPairResult>('bridgelink_poll_pair')
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkApprove(requestId: string): Promise<import('../types').BridgeLinkPairResult> {
  const result = await invokeSafe<import('../types').BridgeLinkPairResult>('bridgelink_approve', { requestId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkDecline(requestId: string): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_decline', { requestId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkForget(instanceId: string): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_forget', { instanceId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function bridgeLinkAiMessages(since = 0): Promise<import('../types').AiRelayMessage[]> {
  return (await invokeSafe<import('../types').AiRelayMessage[]>('bridgelink_ai_messages', { since })) ?? []
}

export async function bridgeLinkAiSend(author: string, body: string, options: { channel?: string; to?: string[]; room?: string } = {}): Promise<import('../types').AiRelayMessage> {
  const result = await invokeSafe<import('../types').AiRelayMessage>('bridgelink_ai_send', { author, body, channel: options.channel ?? null, to: options.to ?? [], room: options.room ?? null })
  if (!result) throw new Error('The AI relay requires native desktop mode.')
  return result
}

/** A native command that has no browser fallback. */
async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('This needs the native BridgeDeck app.')
  return (await invokeSafe<T>(command, args)) as T
}
export async function aiWorkspace(): Promise<import('../types').AiWorkspace> {
  return (await invokeSafe<import('../types').AiWorkspace>('ai_workspace')) ?? { agents: [], rooms: [], claims: [] }
}
export const aiRoomCreate = (title: string, participants: string[] = []) => native<import('../types').AiRoom>('ai_room_create', { title, participants })
export const aiRoomUpdate = (room: string, changes: { title?: string; status?: string; participants?: string[] }) =>
  native<import('../types').AiRoom>('ai_room_update', { room, title: changes.title ?? null, status: changes.status ?? null, participants: changes.participants ?? null })
export const aiRoomRemove = (room: string) => native<boolean>('ai_room_remove', { room })
export const aiTaskAdd = (room: string, title: string, assignee?: string) => native<import('../types').AiTask>('ai_task_add', { room, title, assignee: assignee ?? null })
/** `assignee: ''` unassigns. */
export const aiTaskUpdate = (room: string, task: string, changes: { status?: string; assignee?: string; title?: string }) =>
  native<import('../types').AiTask>('ai_task_update', { room, task, status: changes.status ?? null, assignee: changes.assignee ?? null, title: changes.title ?? null })
export const aiClaimRelease = (path: string) => native<void>('ai_claim_release', { path })

export async function bridgeLinkAiTokenPath(): Promise<string> {
  return (await invokeSafe<string>('bridgelink_ai_token_path')) ?? ''
}

/** This computer's person compared the codes of the pairing it started: `true` = they match. */
export async function bridgeLinkConfirmPair(confirm: boolean): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_confirm_pair', { confirm })
  if (!result) throw new Error('Pairing requires the native BridgeDeck app.')
  return result
}

/** A paired device's live status over the encrypted link (same shape as a local /status). */
export async function bridgeLinkPeerStatus(instanceId: string): Promise<import('../types').AgentStatus> {
  return (await invokeSafe<import('../types').AgentStatus>('bridgelink_peer_status', { instanceId })) ?? { ok: false, error: 'Requires the native BridgeDeck app' }
}

/** Asks a device paired with BridgeDeck 0.8 or older to update itself (its user approves there). */
export async function bridgeLinkLegacyUpgrade(instanceId: string, fromVersion: string): Promise<void> {
  await invokeSafe('bridgelink_legacy_upgrade', { instanceId, request: { mode: 'git', fileName: '', sha256: '', fromVersion } })
}

export async function bridgeLinkRefreshPeer(instanceId: string): Promise<import('../types').BridgeLinkPairResult> {
  const result = await invokeSafe<import('../types').BridgeLinkPairResult>('bridgelink_refresh_peer', { instanceId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function syncthingSetupPeer(settings: { baseUrl: string; apiKey: string; peerDeviceId: string; peerName: string; folderId: string; folderLabel: string; folderPath: string; peerHost?: string }): Promise<import('../types').SyncthingAutoSetupResult> {
  const result = await invokeSafe<import('../types').SyncthingAutoSetupResult>('syncthing_setup_peer', settings)
  if (!result) throw new Error('Automatic Syncthing setup requires the native BridgeDeck app.')
  return result
}

// ---- Built-in Syncthing (src-tauri/src/sync_sidecar.rs, sync_conflicts.rs) ----

const noSidecar: import('../types').SyncSidecarStatus = { available: false, running: false, baseUrl: '', apiKey: '', home: '', detail: 'Requires the native BridgeDeck app' }

export async function syncSidecarStatus() {
  return (await invokeSafe<import('../types').SyncSidecarStatus>('sync_sidecar_status')) ?? noSidecar
}

export async function syncSidecarStart() {
  return (await invokeSafe<import('../types').SyncSidecarStatus>('sync_sidecar_start')) ?? noSidecar
}

export async function syncSidecarStop() {
  return (await invokeSafe<import('../types').SyncSidecarStatus>('sync_sidecar_stop')) ?? noSidecar
}

/** Moves a separately installed Syncthing (identity, folders, database) into BridgeDeck. */
export async function syncSidecarAdopt(source: string, baseUrl: string, apiKey: string) {
  return (await invokeSafe<import('../types').SyncSidecarStatus>('sync_sidecar_adopt', { source, baseUrl, apiKey })) ?? noSidecar
}

/** Any Syncthing REST call on this computer. */
export async function syncthingRequest<T = unknown>(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  return (await invokeSafe<T>('syncthing_request', { baseUrl, apiKey, method, path, body: body ?? null })) as T
}

export async function syncConflicts(folderPath: string) {
  return (await invokeSafe<import('../types').SyncConflict[]>('sync_conflicts', { folderPath })) ?? []
}

/** keep: 'current' trashes the conflict copy; 'conflict' puts it in place and trashes the current file. */
export async function syncResolveConflict(folderPath: string, conflictPath: string, keep: 'current' | 'conflict') {
  await invokeSafe('sync_resolve_conflict', { folderPath, conflictPath, keep })
}

// ---- Upgrading this computer or a paired one (src-tauri/src/upgrade.rs) ----

export type UpgradeStatus = { state: 'idle' | 'running' | 'succeeded' | 'failed' | string; stage: string; message: string; mode: string; requestedBy: string; fromVersion: string; updatedAt: number }
export type UpgradeInfo = { version: string; sourceDir: string; sourceAvailable: boolean; gitReady: boolean; status: UpgradeStatus }
export type SourceBundle = { path: string; fileName: string; sha256: string; bytes: number }
export type UpgradeRequest = { mode: 'git' | 'source'; fileName?: string; sha256?: string; fromVersion?: string }

export async function upgradeInfo(): Promise<UpgradeInfo | null> {
  return invokeSafe<UpgradeInfo>('upgrade_info')
}

/** Pull the latest main from GitHub and rebuild this computer's BridgeDeck. */
export async function upgradeSelf(): Promise<void> {
  await invokeSafe('upgrade_self')
}

export async function upgradeCreateBundle(): Promise<SourceBundle> {
  const bundle = await invokeSafe<SourceBundle>('upgrade_create_bundle')
  if (!bundle) throw new Error('Upgrades need the BridgeDeck app.')
  return bundle
}

/** Resolves once the user on that computer allowed the upgrade (rejects if denied or not possible). */
export async function upgradeRequestPeer(instanceId: string, request: UpgradeRequest): Promise<void> {
  await invokeSafe('upgrade_request_peer', { instanceId, request: { fileName: '', sha256: '', fromVersion: '', ...request } })
}

export async function upgradePeerStatus(instanceId: string): Promise<{ ok: boolean; version?: string; status?: UpgradeStatus; error?: string } | null> {
  return invokeSafe('upgrade_peer_status', { instanceId })
}
