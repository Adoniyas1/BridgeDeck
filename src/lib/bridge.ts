import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type {
  AgentStatus, BlueBubblesChat, BlueBubblesMessage,
  ManagedServiceState, MatrixMessage, RustDeskIdentity, RustDeskMode, ServiceKey,
  SyncthingFolder, SyncthingStatus,
} from '../types'

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Masks credentials that could appear in error text (e.g. BlueBubbles' `?password=` query parameter). */
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

/** Port of a BlueBubbles Server on this computer (so the Mac talks to it over loopback), or null. */
export async function blueBubblesLocalPort(): Promise<number | null> {
  return invokeSafe<number | null>('bluebubbles_local_port')
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

/** Mac only: starts BlueBubbles Server hidden if it isn't running. */
export async function blueBubblesEnsureRunning(): Promise<{ running: boolean; started: boolean; detail?: string } | null> {
  return invokeSafe<{ running: boolean; started: boolean; detail?: string }>('bluebubbles_ensure_running')
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

export async function blueBubblesPing(baseUrl: string, password: string): Promise<boolean> {
  const result = await invokeSafe<boolean>('bluebubbles_ping', { baseUrl, password })
  return result ?? false
}

export async function blueBubblesChats(baseUrl: string, password: string, limit = 25): Promise<BlueBubblesChat[]> {
  const result = await invokeSafe<{ data?: BlueBubblesChat[] }>('bluebubbles_chats', { baseUrl, password, limit: Math.min(limit, 200) })
  return Array.isArray(result?.data) ? result.data : []
}

export async function blueBubblesMessages(baseUrl: string, password: string, chatGuid: string, limit = 30): Promise<BlueBubblesMessage[]> {
  const result = await invokeSafe<{ data?: BlueBubblesMessage[] }>('bluebubbles_messages', { baseUrl, password, chatGuid, limit })
  return Array.isArray(result?.data) ? result.data : []
}

/** Server-wide messages newer than `after` (ms), newest first, each carrying its chat. */
export async function blueBubblesRecent(baseUrl: string, password: string, after: number, limit = 200): Promise<BlueBubblesMessage[]> {
  const result = await invokeSafe<{ data?: BlueBubblesMessage[] }>('bluebubbles_recent', { baseUrl, password, after: Math.max(0, Math.floor(after)), limit })
  return Array.isArray(result?.data) ? result.data : []
}

export async function blueBubblesContacts(baseUrl: string, password: string): Promise<import('../types').BlueBubblesContact[]> {
  const result = await invokeSafe<{ data?: import('../types').BlueBubblesContact[] }>('bluebubbles_contacts', { baseUrl, password })
  return Array.isArray(result?.data) ? result.data : []
}

/** Image attachment as a data: URL (the WebView can't send the server password itself). */
export async function blueBubblesAttachment(baseUrl: string, password: string, attachmentGuid: string): Promise<string> {
  return (await invokeSafe<string>('bluebubbles_attachment', { baseUrl, password, attachmentGuid })) ?? ''
}

export async function blueBubblesSend(baseUrl: string, password: string, chatGuid: string, message: string): Promise<void> {
  await invokeSafe('bluebubbles_send', { baseUrl, password, chatGuid, message })
}

export async function syncthingStatus(baseUrl: string, apiKey: string): Promise<SyncthingStatus> {
  const result = await invokeSafe<SyncthingStatus>('syncthing_status', { baseUrl, apiKey })
  return result ?? { ok: false, error: 'Native Syncthing integration requires the Tauri app.' }
}

export async function syncthingFolders(baseUrl: string, apiKey: string): Promise<SyncthingFolder[]> {
  return (await invokeSafe<SyncthingFolder[]>('syncthing_folders', { baseUrl, apiKey })) ?? []
}

export async function matrixMessages(homeserver: string, roomId: string, accessToken: string, limit = 40): Promise<MatrixMessage[]> {
  return (await invokeSafe<MatrixMessage[]>('matrix_messages', { homeserver, roomId, accessToken, limit })) ?? []
}

export async function matrixSend(homeserver: string, roomId: string, accessToken: string, body: string): Promise<void> {
  const native = await invokeSafe<boolean>('matrix_send', { homeserver, roomId, accessToken, body })
  if (native !== null) return
  if (!homeserver || !roomId || !accessToken || !body.trim()) throw new Error('Matrix settings are incomplete.')
  const txnId = `bridgedeck-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const url = `${homeserver.replace(/\/$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'm.text', body }),
  })
  if (!response.ok) throw new Error(`Matrix returned HTTP ${response.status}`)
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

export async function bridgeLinkAiSend(author: string, body: string, channel?: string): Promise<import('../types').AiRelayMessage> {
  const result = await invokeSafe<import('../types').AiRelayMessage>('bridgelink_ai_send', { author, body, channel: channel ?? null })
  if (!result) throw new Error('The AI relay requires native desktop mode.')
  return result
}

export async function bridgeLinkAiTokenPath(): Promise<string> {
  return (await invokeSafe<string>('bridgelink_ai_token_path')) ?? ''
}

export async function bridgeLinkRefreshPeer(instanceId: string): Promise<import('../types').BridgeLinkPairResult> {
  const result = await invokeSafe<import('../types').BridgeLinkPairResult>('bridgelink_refresh_peer', { instanceId })
  if (!result) throw new Error('Automatic pairing requires the native BridgeDeck app.')
  return result
}

export async function syncthingSetupPeer(settings: { baseUrl: string; apiKey: string; peerDeviceId: string; peerName: string; folderId: string; folderLabel: string; folderPath: string }): Promise<import('../types').SyncthingAutoSetupResult> {
  const result = await invokeSafe<import('../types').SyncthingAutoSetupResult>('syncthing_setup_peer', settings)
  if (!result) throw new Error('Automatic Syncthing setup requires the native BridgeDeck app.')
  return result
}
