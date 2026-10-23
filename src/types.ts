export type PageKey = 'home' | 'computers' | 'remote' | 'messages' | 'ai' | 'mimir' | 'files' | 'sync' | 'services' | 'settings'

export type ServiceKey = 'syncthing' | 'localsend'

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

/** A computer (later also a phone or tablet) BridgeDeck knows about: this one, each paired peer, and any
 *  added by hand. Any number of devices is allowed (roadmap D7). */
export type DeviceConfig = {
  /** BridgeLink instance ID, or `manual-…` for a device entered by hand. */
  id: string
  name: string
  /** As BridgeLink reports it: `macos`, `windows`, `linux`, … */
  platform: string
  /** This computer. */
  local: boolean
  agentUrl: string
  agentToken: string
  localsendTarget: string
  localsendPin: string
  sharedPath: string
  syncthingDeviceId: string
}

export type AppConfig = {
  configVersion: 8
  devices: DeviceConfig[]
  services: ServiceConfig[]
  /** This computer being controlled by paired devices (D15: allowed without asking by default). */
  remote: { allowControl: boolean; askFirst: boolean; askDevices: string[] }
  /** Copying on one paired computer makes it pasteable on the others; recent copies kept (in memory) to paste again. */
  clipboard: { sync: boolean; history: boolean }
  /** Desktop notifications by kind (remote control and pairing requests always notify). */
  notifications: { messages: boolean; ai: boolean; files: boolean; sync: boolean; updates: boolean; reminders: boolean; mail: boolean }
  /** The Mail tab: email accounts' web pages (Outlook, Gmail…), and whether they're checked in the background for new mail. */
  mail: { accounts: MailAccount[]; background: boolean }
  /** The phone page: a web page phones on the same Wi-Fi open to send things here and see the agenda. */
  phone: { enabled: boolean; /** Reachable over Tailscale too (the phone off the home network). */ tailscale?: boolean }
  /** Install GitHub updates without asking (never while this computer is being controlled). */
  updates: { auto: boolean }
  /** Mimir, the assistant in mimir/, runs inside BridgeDeck once set up. */
  mimir: { enabled: boolean }
  /** Calendar tab: Apple Calendar from a Mac, first day of the week, reminder for new events (minutes). */
  calendar: { showApple: boolean; weekStart: 0 | 1; defaultReminder: number | null; /** Subscribed calendars (Outlook's published ICS link and the like), shown read-only. */ feeds: CalendarFeed[] }
  /** Morning brief and evening study nudges as notifications ("HH:MM", this computer's time); "while you were away" on Home. */
  brief: { morning: boolean; morningAt: string; evening: boolean; eveningAt: string; away: boolean }
  /** TV tab: the person's own streaming shortcuts, besides the built-in services. */
  tv: { shortcuts: Array<{ name: string; url: string }> }
  /** Study: languages text recognition reads in scanned books (English is always included), and the
   *  sites exam mode keeps closed in the Browser and TV tabs. */
  study: { ocrLanguages: string[]; examBlock: string[]; /** Mail, Messages and AI notifications wait while a focus session runs. */ quietFocus: boolean; /** Minutes before a class to say where it is (0: off). */ classRemindMinutes: number; /** Door to exam room, for the exam-day card's leave-by time. */ commuteMinutes: number; /** FSRS weights fitted to the review log (empty: the defaults). */ fsrsWeights?: number[] }
  /** Canvas: the school's Canvas address, the calendar feed link and an access token (both kept in
   *  the credential store), hours before a due date to remind, and assignments marked done here. */
  canvas: { base: string; feed: string; token: string; remindHours: number; done: string[]; /** Canvas course ids already added to Study (each is added once, so a deleted one stays gone). */ added: string[] }
  /** Web pages (Browser, TV, ChatGPT): the built-in ad blocker, and the Browser's bookmarks. */
  browsing: {
    adblock: boolean
    allowAds: string[]
    /** Cookie banners, newsletter boxes and other annoyances removed too. */
    annoyances: boolean
    /** Pop-ups opened by a page's script (and pop-up ads) blocked; sites allowed to open them. */
    popups: boolean
    popupSites: string[]
    bookmarks: Array<{ name: string; url: string }>
    /** Minutes a hidden web page stays open before it's put to sleep (0: never). */
    sleepMinutes: number
  }
  /** The first-run checklist on Home: closed for good, and whether notifications were looked at. */
  setup: { dismissed: boolean; notificationsReviewed: boolean }
  /** BridgeDeck in Explorer's Send to menu (Windows; the Mac's Open With entry comes with the app). */
  sendTo: { enabled: boolean }
  syncthing: {
    /** builtin = BridgeDeck runs its own hidden Syncthing; external = a separately installed one. */
    mode: 'builtin' | 'external'
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
  messages: {
    /** Display-only names for people in Messages, on this computer only (never written to Contacts).
     *  Keyed `contact:<Contacts id>` for saved contacts, `address:<number or email>` otherwise. */
    nicknames: Record<string, string>
  }
}


export type ImChat = {
  guid?: string
  displayName?: string
  chatIdentifier?: string
  participants?: Array<{ address?: string; firstName?: string; lastName?: string }>
  lastMessage?: ImMessage | null
}

export type ImAttachment = {
  guid?: string
  mimeType?: string | null
  transferName?: string
  totalBytes?: number
  width?: number
  height?: number
  hideAttachment?: boolean
}

export type ImMessage = {
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
  attachments?: ImAttachment[]
  /** Present on the cross-chat feed (`recent`). */
  chats?: ImChat[]
}

export type ImContact = {
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
  /** BridgeDeck build version (0.8.0 and later). */
  version?: string
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


export type SyncthingFolder = {
  id: string
  label?: string
  path?: string
  paused?: boolean
  type?: string
}

export type SyncSidecarStatus = {
  available: boolean
  running: boolean
  baseUrl: string
  apiKey: string
  home: string
  detail: string
  /** A separately installed Syncthing whose identity and folders can be moved into BridgeDeck. */
  adoptable?: string | null
  adoptedFrom?: string | null
}

export type SyncConflict = {
  conflictPath: string
  originalPath: string
  originalExists: boolean
  conflictSize: number
  originalSize: number
  conflictModified: number
  originalModified: number
}

/** `/rest/db/status` for one folder. */
export type SyncthingFolderStatus = {
  state?: string
  globalBytes?: number
  inSyncBytes?: number
  needBytes?: number
  needFiles?: number
  errors?: number
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
  /** Outgoing message waiting for the other computer to come online. */
  pending?: boolean
  /** Agent names it's addressed to; empty = everyone. */
  to?: string[]
  /** Workspace room id. */
  room?: string | null
}

export type AiAgent = { name: string; status: string; deviceId: string; deviceName: string; lastSeen: number; online: boolean; local: boolean }
export type AiTask = { id: string; title: string; assignee?: string | null; status: 'todo' | 'doing' | 'done'; updatedAt: number }
export type AiRoom = { id: string; title: string; createdBy: string; createdAt: number; updatedAt: number; status: 'open' | 'in-progress' | 'done'; participants: string[]; tasks: AiTask[] }
export type AiClaim = { path: string; agent: string; deviceId: string; deviceName: string; room?: string | null; claimedAt: number; updatedAt: number }
export type AiWorkspace = { agents: AiAgent[]; rooms: AiRoom[]; claims: AiClaim[] }


export type LocalSendTransferResult = {
  ok: boolean
  target: string
  paths: string[]
  stdout: string
  stderr: string
  exitCode?: number
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
  /** 1 = BridgeDeck 0.8 or older (update it before pairing), 2 = current. */
  protocol: number
  via: 'lan' | 'tailscale'
  lastSeen: number
}

/** A pairing another computer started; shown with its code until both people confirm. */
export type BridgeLinkPending = {
  requestId: string
  peerInstanceId: string
  peerName: string
  peerPlatform: string
  host: string
  pairingCode: string
  /** waiting = for this computer's answer; approved = waiting for the other computer. */
  state: 'waiting' | 'approved'
  createdAt: number
}

/** A pairing this computer started. */
export type BridgeLinkOutgoing = {
  requestId: string
  peerInstanceId: string
  peerName: string
  peerPlatform: string
  host: string
  /** Empty until the secure exchange finishes. */
  pairingCode: string
  state: 'connecting' | 'confirm' | 'waiting' | 'failed'
  createdAt: number
}

export type BridgeLinkPairedPeer = {
  instanceId: string
  name: string
  platform: string
  host: string
  apiPort: number
  /** SHA-256 of the device's certificate, pinned at pairing. */
  fingerprint: string
  localsendTarget: string
  syncthingDeviceId?: string
  via: 'lan' | 'tailscale'
  pairedAt: number
  /** It reported a hardware address, so Wake-on-LAN can be tried. */
  wakeable?: boolean
  /** Every IP address it has been reached at (current first). */
  addresses?: string[]
}

/** Paired with BridgeDeck 0.8 or older: must be paired again (and can be asked to update first). */
export type BridgeLinkLegacyPeer = {
  instanceId: string
  name: string
  platform: string
  host: string
}

export type BridgeLinkStatus = {
  running: boolean
  instanceId: string
  displayName: string
  platform: string
  apiPort: number
  fingerprint?: string
  tailscale?: boolean
  discovered: BridgeLinkPeer[]
  pending: BridgeLinkPending[]
  outgoing?: BridgeLinkOutgoing
  paired: BridgeLinkPairedPeer[]
  legacy?: BridgeLinkLegacyPeer[]
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

export type MailAccount = { id: string; name: string; url: string }

export type CalendarFeed = { id: string; name: string; url: string; color: string }
