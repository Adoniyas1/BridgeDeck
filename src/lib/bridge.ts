import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import type {
  AgentStatus,
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

/** Apps older BridgeDeck versions needed (RustDesk, BlueBubbles) that are still installed or running. */
export type LegacyApp = { name: string; replacedBy: string; running: boolean; startsAtLogin: boolean; installed: boolean; systemService: boolean }
export const legacyApps = () => native<LegacyApp[]>('legacy_apps')
export const legacyAppsStop = () => native<LegacyApp[]>('legacy_apps_stop')

/** Remote control: this computer as host. */
export type RemoteHostStatus = { supported: boolean; settings: { allow: boolean; askFirst: boolean }; sessions: Array<{ id: string; peerId: string; peerName: string; since: number }> }
export const remoteHostStatus = () => native<RemoteHostStatus>('remote_host_status')
export const remoteHostSettings = (allow: boolean, askFirst: boolean, askPeers: string[]) => native<RemoteHostStatus>('remote_host_settings', { allow, askFirst, askPeers })
export type ClipboardStatus = {
  enabled: boolean
  available: boolean
  last: { direction: 'sent' | 'received'; peers: string[]; kind: 'text' | 'image'; summary: string; at: number } | null
  errors: string[]
}
export type TrayPeer = { id: string; name: string; canControl: boolean; canReceive: boolean }
export const trayUpdate = (peers: TrayPeer[], clipboard: boolean) => native<void>('tray_update', { peers, clipboard })
export const sendFilesPending = () => native<string[]>('send_files_pending')
export const sendToIntegration = (enabled: boolean) => native<{ kind: 'send-to' | 'open-with' | ''; installed: boolean }>('send_to_integration', { enabled })
export type Permissions = { screenRecording: boolean | null; accessibility: boolean | null }
export const healthPermissions = () => native<Permissions>('health_permissions')
export const openPrivacySettings = (pane: 'screen' | 'accessibility' | 'files' | 'automation') => native<void>('open_privacy_settings', { pane })
export type MimirStatus = { phase: 'stopped' | 'setup' | 'starting' | 'running' | 'failed'; detail: string; url: string | null; log: string[]; available: boolean }
export const mimirStatus = () => native<MimirStatus>('mimir_status')
export const mimirStart = () => native<MimirStatus>('mimir_start')
export const mimirStop = () => native<MimirStatus>('mimir_stop')
export const diagnosticsReport = () => native<string>('diagnostics_report')
export const notificationSettings = (ai: boolean) => native<void>('notification_settings', { ai })
export const clipboardStatus = () => native<ClipboardStatus>('clipboard_status')
export const clipboardSettings = (enabled: boolean) => native<ClipboardStatus>('clipboard_settings', { enabled })
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
/** The paired Mac pushing new messages to this computer, if any (src-tauri/src/imessage/watch.rs). */
export const imessagePushStatus = () => native<string | null>('imessage_push_status')
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

export async function bridgeLinkStart(displayName: string, apiPort: number, localsendPort: number, syncthingId = ''): Promise<import('../types').BridgeLinkStatus> {
  const result = await invokeSafe<import('../types').BridgeLinkStatus>('bridgelink_start', { displayName, apiPort, localsendPort, syncthingId })
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

export const bridgeLinkWake = (instanceId: string) => native<string>('bridgelink_wake', { instanceId })

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
export type UpgradeInfo = { version: string; sourceDir: string; sourceAvailable: boolean; gitReady: boolean; status: UpgradeStatus; logTail: string[] }
export type SourceBundle = { path: string; fileName: string; sha256: string; bytes: number }
export type UpgradeRequest = { mode: 'git' | 'source'; fileName?: string; sha256?: string; fromVersion?: string }

export async function upgradeInfo(): Promise<UpgradeInfo | null> {
  return invokeSafe<UpgradeInfo>('upgrade_info')
}

/** Pull the latest main from GitHub and rebuild this computer's BridgeDeck. */
export type UpdateCheck = { git: boolean; behind: number; upstream: string; latest: string }
export const upgradeCheck = () => native<UpdateCheck>('upgrade_check')

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
/** Notes and checklists (src-tauri/src/bridgelink/notes.rs), kept on every paired computer. */
export type NoteBlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'li' | 'ol' | 'todo' | 'quote' | 'code'
export type NoteBlock = { id: string; kind: NoteBlockKind; text: string; checked: boolean; indent?: number; due: number | null; pos: string; updated: number; by: string; deleted: boolean }
export type Note = { id: string; title: string; folder: string; pinned: boolean; kind: 'note' | 'list'; created: number; titleUpdated: number; metaUpdated: number; deleted: boolean; blocks: NoteBlock[]; seq: number }
export type NotePatch = { id: string; title?: string; folder?: string; pinned?: boolean; kind?: 'note' | 'list'; blocks?: NoteBlock[]; removed?: string[] }
export const notesList = () => native<Note[]>('notes_list')
export const notesCreate = (kind: 'note' | 'list', folder: string) => native<Note>('notes_create', { kind, folder })
export const notesSave = (patch: NotePatch) => native<Note>('notes_save', { patch })
export const notesDelete = (id: string) => native<boolean>('notes_delete', { id })
/** Calendar events (src-tauri/src/bridgelink/calendar.rs), kept on every paired computer. */
export type CalRepeat = { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number; days: number[]; until: number | null; count: number | null }
export type CalEvent = { id: string; title: string; start: number; end: number; allDay: boolean; location: string; notes: string; color: string; repeat: CalRepeat | null; skip: number[]; reminder: number | null; updated: number; by: string; deleted: boolean; seq: number }
export type AppleItem = { id: string; kind: 'event' | 'reminder'; title: string; start: number; end: number; allDay: boolean; calendar: string; location: string; from: string }
export const calendarList = () => native<CalEvent[]>('calendar_list')
export const calendarSave = (event: CalEvent) => native<CalEvent>('calendar_save', { event })
export const calendarDelete = (id: string) => native<boolean>('calendar_delete', { id })
export const calendarImport = (events: CalEvent[]) => native<number>('calendar_import', { events })
export const calendarReadIcs = (path: string) => native<string>('calendar_read_ics', { path })
export const calendarWriteIcs = (path: string, contents: string) => native<void>('calendar_write_ics', { path, contents })
export const calendarApple = (from: number, to: number) => native<{ items: AppleItem[]; errors: string[] }>('calendar_apple', { from, to })
export const calendarAppleShare = (share?: boolean) => native<boolean>('calendar_apple_share', { share: share ?? null })
/** Asks where to save or which file to open for a calendar export or import. */
export async function pickIcsFile(mode: 'open' | 'save', defaultPath = 'BridgeDeck.ics'): Promise<string | null> {
  if (!isTauri()) return null
  const filters = [{ name: 'Calendar', extensions: ['ics'] }]
  if (mode === 'save') return (await save({ defaultPath, filters })) ?? null
  const picked = await open({ multiple: false, filters })
  return typeof picked === 'string' ? picked : null
}
/** Files between paired computers over BridgeLink (src-tauri/src/transfer.rs). */
export type TransferStatus = {
  id: string; direction: 'send' | 'receive'; peerId: string; peerName: string; files: number; names: string[]
  totalBytes: number; doneBytes: number; state: 'connecting' | 'sending' | 'receiving' | 'retrying' | 'done' | 'failed' | 'cancelled'
  error: string | null; startedAt: number; finishedAt: number | null; folder: string | null; rate: number; canResume: boolean
}
export const transferSend = (peer: string, paths: string[]) => native<string>('transfer_send', { peer, paths })
export const transfersList = () => native<TransferStatus[]>('transfers_list')
export const transferCancel = (id: string) => native<void>('transfer_cancel', { id })
export const transferResume = (id: string) => native<string>('transfer_resume', { id })
export const transfersClear = () => native<void>('transfers_clear')
export const OLD_PEER_ERROR = 'needs a newer BridgeDeck to receive files this way'
/** Notes kept as Markdown files too (src-tauri/src/bridgelink/vault.rs). */
export type VaultStatus = { enabled: boolean; path: string; files: number; error: string | null }
export const vaultSettings = (enabled?: boolean, path?: string) => native<VaultStatus>('vault_settings', { enabled: enabled ?? null, path: path ?? null })
/** The Study library (src-tauri/src/study.rs): course folders with textbooks, in the synced folder. */
export type StudyBook = { file: string; title: string; kind: 'pdf' | 'epub'; bytes: number; indexed: boolean }
export type StudyCourse = { name: string; books: StudyBook[] }
export type StudyLibrary = { root: string; courses: StudyCourse[] }
export const studyLibrary = (shared: string) => native<StudyLibrary>('study_library', { shared })
export const studyAddCourse = (name: string) => native<void>('study_add_course', { name })
export const studyAddBooks = (course: string, paths: string[]) => native<StudyBook[]>('study_add_books', { course, paths })
export const studyRemoveBook = (course: string, file: string) => native<void>('study_remove_book', { course, file })
export const studySaveIndex = (course: string, file: string, bytes: number, pages: string[]) => native<void>('study_save_index', { course, file, bytes, pages })
export type StudyHit = { course: string; book: string; file: string; page: number; snippet: string; score: number }
export const studySearch = (query: string, course?: string) => native<StudyHit[]>('study_search', { query, course: course ?? null })
/** Projects (src-tauri/src/projects.rs): one synced folder per project. */
export type ProjectInfo = { name: string; files: number; bytes: number; modified: number }
export type ProjectList = { root: string; projects: ProjectInfo[]; mimirOld: string[]; mimirOldPath: string }
export type ProjectFile = { path: string; bytes: number; modified: number }
export const projectsList = (shared: string) => native<ProjectList>('projects_list', { shared })
export const projectsAdd = (name: string) => native<string>('projects_add', { name })
export const projectsFiles = (project: string) => native<ProjectFile[]>('projects_files', { project })
export const projectsImportMimir = () => native<number>('projects_import_mimir')
/** Skill packs for Mimir (src-tauri/src/skill_packs.rs). */
export type SkillPack = { id: string; title: string; description: string; skills: number; installed: boolean }
export type SkillPacksStatus = { source: string; commit: string; folder: string; packs: SkillPack[]; outdated: boolean }
export const skillPacksStatus = () => native<SkillPacksStatus>('skill_packs_status')
export const skillPacksInstall = (packs: string[]) => native<SkillPacksStatus>('skill_packs_install', { packs })
/** ChatGPT in its own window (src-tauri/src/chatgpt.rs); `text` goes in its message box for the person to send,
 *  and chats saved from it go in `folder` (a course's or project's Notes folder; default "ChatGPT"). */
export const chatgptOpen = (text?: string, folder?: string) => native<void>('chatgpt_open', { text: text ?? null, folder: folder ?? null })
/** What Mimir changed or sent (src-tauri/src/bridgelink/mimir_api.rs). */
export type MimirActivity = { at: number; action: string; detail: string; ok: boolean; outward: boolean }
export const mimirActivity = () => native<MimirActivity[]>('mimir_activity')
/** The Browser tab's page (src-tauri/src/browser.rs): placed over the tab's area in logical pixels. */
export const browserShow = (tab: string, url: string | null, x: number, y: number, w: number, h: number) => native<void>('browser_show', { tab, url, x, y, w, h })
export const browserHide = (tab: string) => native<void>('browser_hide', { tab })
export const browserGo = (tab: string, action: 'back' | 'forward' | 'reload' | 'stop') => native<void>('browser_go', { tab, action })
export const notesCreateMarkdown = (title: string, folder: string, kind: 'note' | 'list', markdown: string) => native<Note>('notes_create_markdown', { title, folder, kind, markdown })
