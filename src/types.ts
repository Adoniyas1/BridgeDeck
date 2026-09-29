export type PageKey = 'home' | 'computers' | 'remote' | 'messages' | 'ai' | 'files' | 'sync' | 'services' | 'settings'

export type ServiceKey = 'rustdesk' | 'bluebubbles' | 'syncthing' | 'matrix' | 'localsend'
export type RustDeskMode = 'control' | 'file-transfer'

export type ServiceConfig = {
  id: ServiceKey
  name: string
  enabled: boolean
  autoStart: boolean
  host?: string
  port?: number
  healthUrl?: string
  webUrl?: string
  executable?: string
  notes?: string
}

export type MachineConfig = {
  id: 'mac' | 'windows'
  name: string
  agentUrl: string
  agentToken: string
  rustdeskPeerId: string
  localsendTarget: string
  localsendPin: string
  sharedPath: string
  bridgeInstanceId: string
  syncthingDeviceId: string
}

export type AppConfig = {
  configVersion: 7
  machines: MachineConfig[]
  services: ServiceConfig[]
  matrix: {
    homeserver: string
    roomId: string
    accessToken: string
  }
  bluebubbles: {
    baseUrl: string
    password: string
  }
  syncthing: {
    baseUrl: string
    apiKey: string
    autoSetup: boolean
    sharedFolderId: string
    sharedFolderLabel: string
    sharedFolderPath: string
  }
  localsend: {
    alias: string
    destination: string
    port: number
    pin: string
    autoAccept: boolean
  }
  pairing: {
    displayName: string
    apiPort: number
    autoStart: boolean
  }
}


export type BlueBubblesChat = {
  guid?: string
  displayName?: string
  chatIdentifier?: string
  participants?: Array<{ address?: string; firstName?: string; lastName?: string }>
  lastMessage?: BlueBubblesMessage | null
}

export type BlueBubblesAttachment = {
  guid?: string
  mimeType?: string | null
  transferName?: string
  totalBytes?: number
  width?: number
  height?: number
  hideAttachment?: boolean
}

export type BlueBubblesMessage = {
  guid?: string
  text?: string | null
  message?: string
  isFromMe?: boolean
  dateCreated?: number | string
  dateDelivered?: number | null
  dateRead?: number | null
  error?: number
  itemType?: number
  groupTitle?: string | null
  /** Set for tapbacks/reactions ("love", "like", ...); these are not shown as bubbles. */
  associatedMessageType?: string | null
  /** For tapbacks: "p:0/<guid>" of the message reacted to. */
  associatedMessageGuid?: string | null
  handle?: { address?: string } | null
  attachments?: BlueBubblesAttachment[]
  /** Present on the server-wide feed (`bluebubbles_recent`). */
  chats?: BlueBubblesChat[]
}

export type BlueBubblesContact = {
  /** macOS Contacts identifier, "<UUID>:ABPerson". */
  id?: string
  firstName?: string
  lastName?: string
  nickname?: string
  displayName?: string
  avatar?: string
  phoneNumbers?: Array<{ address?: string }>
  emails?: Array<{ address?: string }>
}

export type AgentStatus = {
  ok: boolean
  hostname?: string
  platform?: string
  arch?: string
  uptimeSeconds?: number
  totalMemory?: number
  freeMemory?: number
  loadAverage?: number[]
  timestamp?: string
  error?: string
}

export type ManagedServiceState = {
  serviceId: ServiceKey
  running: boolean
  managed: boolean
  pid?: number
  executableReady: boolean
  executable?: string
  detail?: string
}

export type SyncthingFolder = {
  id: string
  label?: string
  path?: string
  paused?: boolean
  type?: string
}

export type SyncthingStatus = {
  ok: boolean
  myID?: string
  uptime?: number
  alloc?: number
  sys?: number
  goroutines?: number
  error?: string
}

export type SourceUpdateStatus = {
  sourceAvailable: boolean
  sourceDir: string
  builtAt: number
  newestSourceAt: number
  newestSourceFile: string
  rebuildNeeded: boolean
}

export type AiRelayMessage = {
  id: string
  channel: string
  author: string
  body: string
  replyTo?: string
  direction: 'in' | 'out'
  peerInstanceId: string
  peerName: string
  createdAt: number
}

export type MatrixMessage = {
  eventId?: string
  sender?: string
  body?: string
  timestamp?: number
  mine?: boolean
}


export type LocalSendTransferResult = {
  ok: boolean
  target: string
  paths: string[]
  stdout: string
  stderr: string
  exitCode?: number
}

export type RustDeskIdentity = {
  available: boolean
  id?: string
  executable?: string
  detail?: string
}


export type LocalSendDevice = {
  alias: string
  host: string
  port: number
  protocol: string
  fingerprint: string
  deviceModel?: string
}

export type LocalSendIncomingFile = {
  id: string
  name: string
  size: number
  fileType: string
}

export type LocalSendPending = {
  sessionId: string
  senderAlias: string
  host: string
  files: LocalSendIncomingFile[]
  totalBytes: number
}

export type LocalSendActive = {
  sessionId: string
  senderAlias: string
  filesTotal: number
  filesDone: number
  totalBytes: number
  receivedBytes: number
  startedAt: number
}

export type LocalSendRecent = {
  sessionId: string
  senderAlias: string
  files: number
  bytes: number
  status: string
  destination: string
  finishedAt: number
  message?: string
}

export type LocalSendReceiverStatus = {
  running: boolean
  alias: string
  port: number
  destination: string
  fingerprint?: string
  pending?: LocalSendPending
  active?: LocalSendActive
  recent: LocalSendRecent[]
  devices: LocalSendDevice[]
  detail?: string
}

export type BridgeLinkPeer = {
  instanceId: string
  name: string
  platform: string
  host: string
  apiPort: number
  lastSeen: number
}

export type BridgeLinkPending = {
  requestId: string
  peerInstanceId: string
  peerName: string
  peerPlatform: string
  host: string
  apiPort: number
  pairingCode: string
  rustdeskPeerId?: string
  localsendTarget: string
  syncthingDeviceId?: string
  createdAt: number
}

export type BridgeLinkOutgoing = {
  requestId: string
  peerInstanceId: string
  peerName: string
  peerPlatform: string
  host: string
  apiPort: number
  pairingCode: string
  state: string
  createdAt: number
}

export type BridgeLinkPairedPeer = {
  instanceId: string
  name: string
  platform: string
  host: string
  apiPort: number
  accessToken: string
  rustdeskPeerId?: string
  localsendTarget: string
  syncthingDeviceId?: string
  bluebubblesUrl?: string
  pairedAt: number
}

export type BridgeLinkStatus = {
  running: boolean
  instanceId: string
  displayName: string
  platform: string
  apiPort: number
  discovered: BridgeLinkPeer[]
  pending: BridgeLinkPending[]
  outgoing?: BridgeLinkOutgoing
  paired: BridgeLinkPairedPeer[]
  detail?: string
}

export type BridgeLinkPairResult = {
  paired: boolean
  peer?: BridgeLinkPairedPeer
  detail: string
}

export type SyncthingAutoSetupResult = {
  ok: boolean
  localDeviceId: string
  peerDeviceId: string
  peerName: string
  deviceAdded: boolean
  folderCreated: boolean
  folderUpdated: boolean
  folderId: string
  folderLabel: string
  folderPath: string
  restartRequired: boolean
  detail: string
}
