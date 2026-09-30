import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, Copy, Info, Link2, MessageSquare, Minus, Paperclip, Pencil, Pin, PinOff, Plus, Search, Tag, UserPlus, X } from 'lucide-react'
import { contactsSave, desktopNotify, imessage, imessageAttachment, imessageSendFile, openExternal, pickTransferPaths } from '../../lib/bridge'
import type { ImAttachment, ImChat, ImContact, ImMessage } from '../../types'
import { setConfig, useConfig } from '../../core/config'
import type { MessagesSource } from './state'

/** `visible`: the Messages page is on screen. The feed keeps polling while hidden so notifications and the
 *  unread badge work from any page; the open thread only loads while visible. */
type Props = { source: MessagesSource; visible: boolean; onUnreadChange?: (count: number) => void }
type Person = {
  name: string
  avatar?: string
  /** Contact identity (merges a person's numbers/emails); absent for unknown numbers. */
  id?: string
  /** Name from Contacts when a local nickname is shown instead. */
  realName?: string
}

/** Key for a display-only nickname: the Contacts id when saved, else the normalized number or email. */
const nicknameKey = (contact: ImContact | undefined, address?: string | null) =>
  contact?.id ? `contact:${contact.id}` : `address:${addressKey(address)}`
/** One row in the list: a group chat, or every 1:1 thread with the same person (iMessage/SMS/RCS, any of their numbers). */
type Conversation = { key: string; chat: ImChat; guids: string[]; sendGuid: string; lastMessage?: ImMessage | null }
type PendingMessage = ImMessage & { pending?: boolean }

const GROUP_GAP_MS = 3 * 60_000
const SEPARATOR_GAP_MS = 60 * 60_000

/** Phone numbers match on their last 10 digits (ignores +1, spaces, dashes); emails case-insensitively. */
function addressKey(address?: string | null) {
  if (!address) return ''
  const value = address.trim().toLowerCase()
  if (value.includes('@')) return value
  const digits = value.replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

function formatAddress(address?: string | null) {
  if (!address) return 'Unknown'
  const digits = address.replace(/\D/g, '')
  if (!address.includes('@') && digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  if (!address.includes('@') && digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  return address
}

function contactName(contact: ImContact) {
  return contact.displayName?.trim() || [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.nickname?.trim() || ''
}

function avatarSrc(avatar?: string) {
  if (!avatar) return undefined
  return avatar.startsWith('data:') ? avatar : `data:image/jpeg;base64,${avatar}`
}

const toMs = (value?: number | string | null) => typeof value === 'number' ? value : value ? Date.parse(value) || 0 : 0

function startOfDay(ms: number) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

/** Conversation list time, as in Messages: time today, "Yesterday", weekday this week, else date. */
function listTime(ms: number) {
  if (!ms) return ''
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000)
  if (days <= 0) return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Date(ms).toLocaleDateString([], { weekday: 'long' })
  return new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })
}

function separatorTime(ms: number) {
  const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000)
  if (days <= 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  if (days < 7) return `${new Date(ms).toLocaleDateString([], { weekday: 'long' })} ${time}`
  return `${new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${time}`
}

function previewText(message?: ImMessage | null) {
  if (!message) return ''
  const text = (message.text ?? '').replace(/￼/g, '').trim()
  if (text) return text
  const first = message.attachments?.[0]
  if (!first) return ''
  if (first.mimeType?.startsWith('image/')) return 'Photo'
  if (first.mimeType?.startsWith('video/')) return 'Video'
  if (first.mimeType?.startsWith('audio/')) return 'Audio Message'
  return 'Attachment'
}

const isJumboEmoji = (text: string) => text.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(text)

/** Tapback types (named, iOS 18 numeric, removals) to the emoji shown on the bubble. */
const REACTIONS: Record<string, string> = { love: '❤️', like: '👍', dislike: '👎', laugh: '😂', emphasize: '‼️', question: '❓', '2000': '❤️', '2001': '👍', '2002': '👎', '2003': '😂', '2004': '‼️', '2005': '❓' }
const isReactionRemoval = (type: string) => type.startsWith('-') || /^3\d{3}$/.test(type)
/** "p:0/GUID" or "bp:GUID" -> GUID of the message being reacted to. */
const reactionTarget = (guid?: string | null) => (guid ?? '').replace(/^(p:\d+\/|bp:)/, '')
function reactionEmoji(message: ImMessage) {
  const type = message.associatedMessageType ?? ''
  if (REACTIONS[type]) return REACTIONS[type]
  if (type === '2006') return ((message.text ?? '').match(/\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic}|\ufe0f)*/u) ?? [''])[0]
  return ''
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi
const urlsIn = (text: string) => text.match(URL_PATTERN) ?? []

/** Message text with web links rendered as links that open in the default browser. */
function Linkified({ text }: { text: string }) {
  const parts: Array<string | { url: string }> = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index! > last) parts.push(text.slice(last, match.index))
    parts.push({ url: match[0] })
    last = match.index! + match[0].length
  }
  parts.push(text.slice(last))
  return <>{parts.map((part, i) => typeof part === 'string' ? part : <a key={i} href={part.url} onClick={e => { e.preventDefault(); void openExternal(part.url) }}>{part.url}</a>)}</>
}

const PINS_KEY = 'bridgedeck.messages.pins'
function loadPins(): string[] {
  try { const value = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]'); return Array.isArray(value) ? value.filter(v => typeof v === 'string') : [] } catch { return [] }
}
function savePins(pins: string[]) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)) } catch { /* storage unavailable: pins last for this session */ }
}

function initials(name: string) {
  const letters = name.split(/\s+/).filter(w => /^[\p{L}]/u.test(w)).map(w => w[0]).slice(0, 2).join('')
  return letters.toUpperCase()
}

function Avatar({ person, size = 40, group = false }: { person?: Person; size?: number; group?: boolean }) {
  const src = avatarSrc(person?.avatar)
  const text = person ? initials(person.name) : ''
  return (
    <span className={`im-avatar${group ? ' group' : ''}`} style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {src ? <img src={src} alt="" /> : text || <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}><path fill="currentColor" d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" /></svg>}
    </span>
  )
}

const imageCache = new Map<string, string>()
/** Survives leaving and re-opening the Messages page. */
let contactCache: { key: string; list: ImContact[] } | null = null

function AttachmentView({ attachment, peer, onOpen, thumb = false }: { attachment: ImAttachment; peer: string | null; onOpen?: (src: string) => void; thumb?: boolean }) {
  const isImage = !!attachment.mimeType?.startsWith('image/')
  const [src, setSrc] = useState(() => (attachment.guid && imageCache.get(attachment.guid)) || '')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!isImage || src || !attachment.guid) return
    let cancelled = false
    imessageAttachment(peer, attachment.guid)
      .then(url => { if (!cancelled && url) { imageCache.set(attachment.guid!, url); setSrc(url) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [attachment.guid, isImage, src, peer])
  if (isImage && src) return <img className={thumb ? 'im-thumb' : 'im-photo'} src={src} alt={attachment.transferName || 'Photo'} onClick={() => onOpen?.(src)} />
  if (isImage && thumb) return <span className="im-thumb placeholder" />
  if (isImage && !failed) {
    const ratio = attachment.width && attachment.height ? attachment.height / attachment.width : 0.75
    return <span className="im-photo placeholder" style={{ aspectRatio: `1 / ${Math.min(Math.max(ratio, 0.4), 1.6)}` }} />
  }
  return <span className="im-file"><Paperclip size={14} />{attachment.transferName || 'Attachment'}</span>
}

export default function Messages({ source, visible, onUnreadChange }: Props) {
  const configured = source.ready
  const peer = source.peer
  const sourceKey = peer ?? 'local'
  const [chats, setChats] = useState<ImChat[]>([])
  const [loadedContacts, setContacts] = useState<ImContact[]>(() => contactCache?.key === sourceKey ? contactCache.list : [])
  // Edits saved from BridgeDeck, applied over the contact list until the Mac's Contacts is read again.
  const [contactOverrides, setContactOverrides] = useState<Record<string, ImContact>>({})
  const contacts = useMemo(() => {
    const merged = loadedContacts.map(c => (c.id && contactOverrides[c.id]) || c)
    const known = new Set(loadedContacts.map(c => c.id))
    return [...merged, ...Object.values(contactOverrides).filter(c => !known.has(c.id))]
  }, [loadedContacts, contactOverrides])
  const [selectedKey, setSelectedKey] = useState('')
  const [messages, setMessages] = useState<PendingMessage[]>([])
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // Nicknames are display-only and local to this computer (config.messages.nicknames); Contacts is untouched.
  const nicknames = useConfig().messages.nicknames
  const people = useMemo(() => {
    const map = new Map<string, Person>()
    contacts.forEach((contact, index) => {
      const name = contactName(contact)
      if (!name) return
      for (const entry of [...(contact.phoneNumbers ?? []), ...(contact.emails ?? [])]) {
        const key = addressKey(entry.address)
        if (!key || map.has(key)) continue
        const nickname = nicknames[`contact:${contact.id}`] || nicknames[`address:${key}`]
        map.set(key, { name: nickname || name, realName: nickname ? name : undefined, avatar: contact.avatar, id: `contact:${index}` })
      }
    })
    // Nicknames for numbers/emails that aren't in Contacts.
    for (const [key, nickname] of Object.entries(nicknames)) {
      const address = key.startsWith('address:') ? key.slice(8) : ''
      if (address && nickname && !map.has(address)) map.set(address, { name: nickname })
    }
    return map
  }, [contacts, nicknames])

  const contactById = useMemo(() => new Map<string, ImContact>(contacts.map((contact, index) => [`contact:${index}`, contact])), [contacts])
  // Read by the feed poller, whose closure outlives renders.
  const peopleRef = useRef(people)
  peopleRef.current = people
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const notified = useRef(new Set<string>())
  const [pins, setPins] = useState<string[]>(loadPins)
  const [showDetails, setShowDetails] = useState(false)
  const [viewer, setViewer] = useState('')
  const [copied, setCopied] = useState('')
  type ContactDraft = { personId: string; firstName: string; lastName: string; phones: string[]; emails: string[]; originalPhones: string[]; originalEmails: string[] }
  const [editing, setEditing] = useState<ContactDraft | null>(null)
  const [saving, setSaving] = useState(false)

  const personFor = (address?: string | null): Person => people.get(addressKey(address)) ?? { name: formatAddress(address) }

  const chatTitle = (chat: ImChat) => {
    if (chat.displayName?.trim()) return chat.displayName.trim()
    const participants = chat.participants ?? []
    if (participants.length === 1) return personFor(participants[0].address).name
    // Contacts by first name (as Messages does); unknown numbers stay whole instead of becoming "(310)".
    if (participants.length > 1) return participants.map(p => { const person = personFor(p.address); return person.id ? person.name.split(' ')[0] : person.name }).join(', ')
    return formatAddress(chat.chatIdentifier)
  }
  const isGroup = (chat?: ImChat) => (chat?.participants?.length ?? 0) > 1

  // Contacts: read from the Mac's address book. Reload every 5 minutes and keep the latest list across
  // page visits.
  useEffect(() => {
    if (!configured) return
    let cancelled = false
    const load = () => imessage<ImContact[]>(peer, { op: 'contacts' })
      .then(list => {
        if (cancelled || !list.length) return
        contactCache = { key: sourceKey, list }
        setContacts(list)
      })
      .catch(() => undefined)
    void load()
    const timer = window.setInterval(() => void load(), 5 * 60_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [sourceKey, configured])

  // Newest message per chat, from the cross-chat feed (polled every 3 s), so the list order and
  // previews follow new messages without reloading the chat list.
  const [latest, setLatest] = useState<Record<string, { chat: ImChat; last: ImMessage }>>({})
  const [threadTick, setThreadTick] = useState(0)
  const [seenAt, setSeenAt] = useState<Record<string, number>>({})
  const openedAt = useRef(Date.now())
  const newestSeen = useRef(0)
  const selectedGuidsRef = useRef<string[]>([])

  function mergeFeed(list: ImMessage[]) {
    const usable = list.filter(m => m.chats?.[0]?.guid && !m.associatedMessageType)
    if (!list.length) return
    newestSeen.current = Math.max(newestSeen.current, ...list.map(m => toMs(m.dateCreated)))
    if (!usable.length) return
    setLatest(current => {
      const next = { ...current }
      for (const message of usable) {
        const chat = message.chats![0]
        const previous = next[chat.guid!]
        if (!previous || toMs(message.dateCreated) >= toMs(previous.last.dateCreated)) next[chat.guid!] = { chat: { ...previous?.chat, ...chat }, last: message }
      }
      return next
    })
    if (usable.some(m => selectedGuidsRef.current.includes(m.chats![0].guid!))) setThreadTick(t => t + 1)
    notifyNew(usable)
  }

  /** Desktop notification for incoming messages that arrived after BridgeDeck opened, unless that
   *  conversation is on screen. More than three at once collapse into one summary. */
  function notifyNew(list: ImMessage[]) {
    const fresh = list.filter(m => !m.isFromMe && m.guid && !notified.current.has(m.guid) && toMs(m.dateCreated) > openedAt.current)
    fresh.forEach(m => notified.current.add(m.guid!))
    const unseen = fresh.filter(m => !(visibleRef.current && document.hasFocus() && selectedGuidsRef.current.includes(m.chats![0].guid!)))
    if (!unseen.length) return
    const nameOf = (address?: string | null) => peopleRef.current.get(addressKey(address))?.name ?? formatAddress(address)
    if (unseen.length > 3) { void desktopNotify('Messages', `${unseen.length} new messages`).catch(() => undefined); return }
    for (const m of unseen) {
      const chat = m.chats![0]
      const sender = nameOf(m.handle?.address ?? chat.chatIdentifier)
      const group = (chat.participants?.length ?? 0) > 1 || (chat.guid ?? '').includes(';+;')
      void desktopNotify(group ? `${sender} · ${chat.displayName?.trim() || 'Group'}` : sender, previewText(m) || 'New message').catch(() => undefined)
    }
  }

  // Load 14 days of activity plus the chat list, then poll only for newer messages every 3 s.
  useEffect(() => {
    if (!configured) return
    let cancelled = false
    const describe = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : 'Could not reach the Mac'
    const initial = async () => {
      try {
        const [recent, list] = await Promise.all([
          imessage<ImMessage[]>(peer, { op: 'recent', after: Date.now() - 14 * 86_400_000, limit: 1000 }),
          imessage<ImChat[]>(peer, { op: 'chats', limit: 100 }),
        ])
        if (cancelled) return
        setChats(list)
        mergeFeed(recent)
        setStatus('')
      } catch (error) {
        if (!cancelled) setStatus(describe(error))
      }
    }
    const poll = async () => {
      if (!newestSeen.current) return
      try {
        const recent = await imessage<ImMessage[]>(peer, { op: 'recent', after: Math.floor(newestSeen.current - 2_000), limit: 200 })
        if (!cancelled) mergeFeed(recent)
      } catch { /* next poll retries */ }
    }
    const refreshList = async () => {
      try { const list = await imessage<ImChat[]>(peer, { op: 'chats', limit: 100 }); if (!cancelled) setChats(list) } catch { /* keep list */ }
    }
    void initial()
    const pollTimer = window.setInterval(() => void poll(), 3_000)
    const listTimer = window.setInterval(() => void refreshList(), 60_000)
    return () => { cancelled = true; window.clearInterval(pollTimer); window.clearInterval(listTimer) }
  }, [sourceKey, configured])

  // Every chat we know: chat/query results merged with the feed (newest message from either source).
  const chatList = useMemo(() => {
    const byGuid = new Map<string, ImChat>()
    for (const chat of chats) if (chat.guid) byGuid.set(chat.guid, chat)
    for (const [guid, { chat, last }] of Object.entries(latest)) {
      const base = byGuid.get(guid)
      const baseLast = base?.lastMessage
      const newest = !baseLast || toMs(last.dateCreated) >= toMs(baseLast.dateCreated) ? last : baseLast
      byGuid.set(guid, { ...chat, ...base, participants: base?.participants?.length ? base.participants : chat.participants, lastMessage: newest })
    }
    return [...byGuid.values()]
  }, [chats, latest])

  // One row per person, like Messages: 1:1 threads over iMessage, SMS and RCS, and over any of a contact's
  // numbers or emails, merge into one conversation. Group chats stay separate.
  const conversations = useMemo(() => {
    const groups = new Map<string, ImChat[]>()
    for (const chat of chatList) {
      const participants = chat.participants ?? []
      const oneToOne = participants.length <= 1 && !(chat.guid ?? '').includes(';+;')
      const address = participants[0]?.address ?? chat.chatIdentifier
      const key = oneToOne ? `person:${people.get(addressKey(address))?.id ?? addressKey(address)}` : `group:${chat.guid}`
      groups.set(key, [...(groups.get(key) ?? []), chat])
    }
    const rows: Conversation[] = []
    for (const [key, members] of groups) {
      const byRecency = members.slice().sort((a, b) => toMs(b.lastMessage?.dateCreated) - toMs(a.lastMessage?.dateCreated))
      // Reply over iMessage when that thread exists, otherwise on the most recently used thread.
      const send = members.find(c => c.guid?.startsWith('iMessage;')) ?? byRecency[0]
      rows.push({ key, chat: byRecency[0], guids: members.map(c => c.guid!).filter(Boolean), sendGuid: send.guid ?? '', lastMessage: byRecency[0].lastMessage })
    }
    rows.sort((a, b) => toMs(b.lastMessage?.dateCreated) - toMs(a.lastMessage?.dateCreated))
    // Pinned conversations first, in the order they were pinned.
    const pinned = pins.map(key => rows.find(r => r.key === key)).filter((r): r is Conversation => !!r)
    return [...pinned, ...rows.filter(r => !pins.includes(r.key))]
  }, [chatList, people, pins])

  function togglePin(key: string) {
    setPins(current => { const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key]; savePins(next); return next })
  }

  const selected = conversations.find(c => c.key === selectedKey)
  const selectedGuids = selected?.guids.join('|') ?? ''
  useEffect(() => { selectedGuidsRef.current = selected?.guids ?? [] }, [selectedGuids])
  useEffect(() => { if (!selectedKey && conversations[0]) setSelectedKey(conversations[0].key) }, [selectedKey, conversations])

  // Open conversation (all of its threads): on selection, whenever the feed brings a message for it,
  // and every 15 s as a safety net.
  useEffect(() => {
    if (!configured || !visible || !selectedGuids) return
    let cancelled = false
    const guids = selectedGuids.split('|')
    const load = async () => {
      try {
        const lists = await Promise.all(guids.map(guid => imessage<ImMessage[]>(peer, { op: 'messages', chat: guid, limit: 80 }).catch(() => [] as ImMessage[])))
        if (cancelled) return
        const seen = new Set<string>()
        const merged = lists.flat()
          .filter(m => { if (!m.guid) return true; if (seen.has(m.guid)) return false; seen.add(m.guid); return true })
          .sort((a, b) => toMs(a.dateCreated) - toMs(b.dateCreated))
          .slice(-150)
        setMessages(merged)
        setPending(current => current.filter(p => p.error || !merged.some(m => m.isFromMe && (m.text ?? '') === p.text && toMs(m.dateCreated) >= toMs(p.dateCreated) - 60_000)))
      } catch { /* keep what is shown */ }
    }
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [sourceKey, configured, visible, selectedGuids, threadTick])

  useEffect(() => {
    stickToBottom.current = true
    setPending([])
    setMessages([])
    setEditing(null)
    if (selectedKey) setSeenAt(current => ({ ...current, [selectedKey]: Date.now() }))
  }, [selectedKey])

  const isUnread = (row: Conversation) => !(visible && row.key === selectedKey) && !!row.lastMessage && !row.lastMessage.isFromMe
    && toMs(row.lastMessage.dateCreated) > Math.max(openedAt.current, seenAt[row.key] ?? 0)
  const unreadCount = conversations.filter(isUnread).length
  useEffect(() => { onUnreadChange?.(unreadCount) }, [unreadCount])
  // Opening the page marks the open conversation read.
  useEffect(() => { if (visible && selectedKey) setSeenAt(current => ({ ...current, [selectedKey]: Date.now() })) }, [visible, selectedKey, selected?.lastMessage?.guid])
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, pending, selectedKey])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(row => chatTitle(row.chat).toLowerCase().includes(q) || previewText(row.lastMessage).toLowerCase().includes(q))
  }, [conversations, query, people])

  // Bubbles only: tapbacks become badges on the message they react to; group events become a centered line.
  const visibleMessages = [...messages, ...pending].filter(m => !m.associatedMessageType)
  const lastMineIndex = visibleMessages.map(m => !!m.isFromMe).lastIndexOf(true)
  const reactions = useMemo(() => {
    const byTarget = new Map<string, Map<string, string>>() // target guid -> sender -> emoji (latest wins)
    for (const m of messages) {
      const type = m.associatedMessageType
      if (!type) continue
      const target = reactionTarget(m.associatedMessageGuid)
      const perSender = byTarget.get(target) ?? new Map<string, string>()
      const who = m.isFromMe ? 'me' : addressKey(m.handle?.address)
      if (isReactionRemoval(type)) perSender.delete(who)
      else { const emoji = reactionEmoji(m); if (emoji) perSender.set(who, emoji) }
      byTarget.set(target, perSender)
    }
    return byTarget
  }, [messages])

  // Details panel content, from the contact and the loaded messages of this conversation.
  const details = useMemo(() => {
    if (!selected) return null
    const chat = selected.chat
    const group = isGroup(chat)
    const address = chat.participants?.[0]?.address ?? chat.chatIdentifier
    const person = personFor(address)
    const contact = person.id ? contactById.get(person.id) : undefined
    const entries = contact
      ? [...(contact.phoneNumbers ?? []).map(p => ({ kind: 'Phone', value: p.address ?? '' })), ...(contact.emails ?? []).map(e => ({ kind: 'Email', value: e.address ?? '' }))].filter(e => e.value)
      : address ? [{ kind: address.includes('@') ? 'Email' : 'Phone', value: address }] : []
    const services = [...new Set(selected.guids.map(g => g.split(';')[0]).filter(Boolean))]
    const members = group ? (chat.participants ?? []).map(p => ({ address: p.address ?? '', person: personFor(p.address) })) : []
    const newestFirst = messages.slice().reverse()
    const photos = newestFirst.flatMap(m => (m.attachments ?? []).filter(a => !a.hideAttachment && a.mimeType?.startsWith('image/'))).slice(0, 30)
    const links = [...new Set(newestFirst.flatMap(m => urlsIn(m.text ?? '')))].slice(0, 20)
    const nickKey = nicknameKey(contact, address)
    return { group, person, contact, entries, services, members, photos, links, nickKey, nickname: nicknames[nickKey] || '' }
  }, [selected, messages, people, contactById, nicknames])

  const [nickDraft, setNickDraft] = useState<string | null>(null)
  useEffect(() => { setNickDraft(null) }, [selectedKey])
  function saveNickname(key: string, value: string) {
    const nickname = value.trim().slice(0, 80)
    setConfig(c => {
      const next = { ...c.messages.nicknames }
      if (nickname) next[key] = nickname; else delete next[key]
      return { ...c, messages: { ...c.messages, nicknames: next } }
    })
    setNickDraft(null)
  }

  function startEditing() {
    if (!details) return
    const contact = details.contact
    const phones = contact ? (contact.phoneNumbers ?? []).map(p => p.address ?? '').filter(Boolean) : details.entries.filter(e => e.kind === 'Phone').map(e => e.value)
    const emails = contact ? (contact.emails ?? []).map(e => e.address ?? '').filter(Boolean) : details.entries.filter(e => e.kind === 'Email').map(e => e.value)
    setEditing({
      personId: contact?.id ?? '',
      firstName: contact?.firstName ?? '',
      lastName: contact?.lastName ?? '',
      phones: phones.length ? phones : [''],
      emails,
      // New contact: nothing exists yet, so everything listed is an addition.
      originalPhones: contact ? phones : [],
      originalEmails: contact ? emails : [],
    })
  }

  async function saveContact() {
    if (!editing) return
    const phones = editing.phones.map(v => v.trim()).filter(Boolean)
    const emails = editing.emails.map(v => v.trim()).filter(Boolean)
    if (!editing.firstName.trim() && !editing.lastName.trim()) { setStatus('Enter a first or last name.'); return }
    setSaving(true)
    setStatus('')
    try {
      const id = await contactsSave({
        personId: editing.personId,
        firstName: editing.firstName.trim(),
        lastName: editing.lastName.trim(),
        phonesAdd: phones.filter(v => !editing.originalPhones.includes(v)),
        phonesRemove: editing.originalPhones.filter(v => !phones.includes(v)),
        emailsAdd: emails.filter(v => !editing.originalEmails.includes(v)),
        emailsRemove: editing.originalEmails.filter(v => !emails.includes(v)),
      })
      const personId = id || editing.personId
      if (personId) {
        setContactOverrides(current => ({ ...current, [personId]: {
          id: personId, firstName: editing.firstName.trim(), lastName: editing.lastName.trim(),
          phoneNumbers: phones.map(address => ({ address })), emails: emails.map(address => ({ address })),
          avatar: loadedContacts.find(c => c.id === personId)?.avatar,
        } }))
      }
      setEditing(null)
    } catch (error) {
      setStatus(typeof error === 'string' ? error : error instanceof Error ? error.message : 'Could not save the contact')
    } finally {
      setSaving(false)
    }
  }

  function copy(value: string) {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(value); window.setTimeout(() => setCopied(''), 1500) }).catch(() => undefined)
  }

  async function send() {
    const text = draft.trim()
    const target = selected?.sendGuid
    if (!text || !target) return
    setDraft('')
    setStatus('')
    stickToBottom.current = true
    setPending(current => [...current, { guid: `pending-${Date.now()}`, text, isFromMe: true, dateCreated: Date.now(), pending: true }])
    try {
      await imessage(peer, { op: 'send', chat: target, text })
    } catch (error) {
      setPending(current => current.map(p => p.text === text && p.pending ? { ...p, error: 1 } : p))
      setStatus(typeof error === 'string' ? error : 'Message failed to send')
    }
  }

  async function sendFile() {
    const target = selected?.sendGuid
    if (!target) return
    try {
      const [path] = await pickTransferPaths(false)
      if (!path) return
      setStatus(`Sending ${path.split(/[\\/]/).pop()}…`)
      await imessageSendFile(peer, target, path)
      setStatus('')
      setThreadTick(t => t + 1)
    } catch (error) {
      setStatus(typeof error === 'string' ? error : error instanceof Error ? error.message : 'The file was not sent')
    }
  }

  if (!configured) {
    return <div className="im-shell im-empty-shell"><MessageSquare size={28} /><h3>iMessage</h3><p>{source.detail || 'Looking for your Mac…'}</p></div>
  }

  return (
    <div className="im-shell">
      <aside className="im-sidebar">
        <div className="im-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" /></div>
        <div className="im-list">
          {filtered.map(row => {
            const chat = row.chat
            const last = row.lastMessage
            const title = chatTitle(chat)
            const person = isGroup(chat) ? { name: title } : personFor(chat.participants?.[0]?.address ?? chat.chatIdentifier)
            return (
              <button key={row.key} className={`im-row${row.key === selectedKey ? ' active' : ''}${isUnread(row) ? ' unread' : ''}`} onClick={() => setSelectedKey(row.key)}>
                <span className="im-unread-dot" />
                <Avatar person={person} group={isGroup(chat)} />
                <span className="im-row-body">
                  <span className="im-row-top"><strong>{title}</strong><time>{pins.includes(row.key) && <Pin size={11} className="im-pin" />}{listTime(toMs(last?.dateCreated))}</time></span>
                  <span className="im-row-preview">{last?.isFromMe && previewText(last) ? `You: ${previewText(last)}` : previewText(last)}</span>
                </span>
              </button>
            )
          })}
          {!filtered.length && <p className="im-hint">{status || (chats.length ? 'No matches' : 'Loading conversations…')}</p>}
        </div>
      </aside>

      <section className="im-thread">
        {selected ? <>
          <button className="im-thread-head" onClick={() => setShowDetails(v => !v)} title="Details">
            <Avatar person={isGroup(selected.chat) ? { name: chatTitle(selected.chat) } : personFor(selected.chat.participants?.[0]?.address ?? selected.chat.chatIdentifier)} size={32} group={isGroup(selected.chat)} />
            <strong>{chatTitle(selected.chat)} <Info size={12} className="im-info" /></strong>
          </button>
          <div className="im-scroll" ref={scrollRef} onScroll={e => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
            {visibleMessages.map((message, i) => {
              const at = toMs(message.dateCreated)
              const prev = visibleMessages[i - 1]
              const next = visibleMessages[i + 1]
              const sender = message.isFromMe ? 'me' : addressKey(message.handle?.address)
              const sameAsPrev = prev && (prev.isFromMe ? 'me' : addressKey(prev.handle?.address)) === sender && at - toMs(prev.dateCreated) < GROUP_GAP_MS
              const sameAsNext = next && (next.isFromMe ? 'me' : addressKey(next.handle?.address)) === sender && toMs(next.dateCreated) - at < GROUP_GAP_MS
              const showSeparator = !prev || at - toMs(prev.dateCreated) > SEPARATOR_GAP_MS
              if (message.itemType && message.itemType !== 0) {
                return message.groupTitle ? <div key={message.guid ?? i} className="im-system">Conversation named “{message.groupTitle}”</div> : null
              }
              const text = (message.text ?? '').replace(/￼/g, '').trim()
              const attachments = (message.attachments ?? []).filter(a => !a.hideAttachment)
              const jumbo = !!text && !attachments.length && isJumboEmoji(text)
              return (
                <div key={message.guid ?? i} className="im-item">
                  {showSeparator && <div className="im-separator">{separatorTime(at)}</div>}
                  {!message.isFromMe && isGroup(selected.chat) && (!sameAsPrev || showSeparator) && <div className="im-sender">{personFor(message.handle?.address).name}</div>}
                  <div className={`im-line ${message.isFromMe ? 'mine' : 'theirs'}${sameAsNext ? '' : ' tail'}${sameAsPrev && !showSeparator ? ' cont' : ''}`}>
                    {!message.isFromMe && isGroup(selected.chat) && <span className="im-line-avatar">{!sameAsNext && <Avatar person={personFor(message.handle?.address)} size={26} />}</span>}
                    <div className="im-stack">
                      {attachments.map(a => <AttachmentView key={a.guid} attachment={a} peer={peer} onOpen={setViewer} />)}
                      {text && (jumbo ? <span className="im-jumbo">{text}</span> : <span className={`im-bubble${message.pending ? ' pending' : ''}`}><Linkified text={text} /></span>)}
                      {!!message.guid && !!reactions.get(message.guid)?.size && <span className="im-tapbacks">{[...new Set(reactions.get(message.guid)!.values())].join('')}{reactions.get(message.guid)!.size > 1 ? <small>{reactions.get(message.guid)!.size}</small> : null}</span>}
                    </div>
                  </div>
                  {message.isFromMe && message.error ? <div className="im-receipt error">Not Delivered</div>
                    : i === lastMineIndex && message.isFromMe && <div className="im-receipt">{message.pending ? 'Sending…' : message.dateRead ? `Read ${listTime(message.dateRead)}` : message.dateDelivered ? 'Delivered' : 'Sent'}</div>}
                </div>
              )
            })}
          </div>
          {status && <div className="im-error" role="alert">{status}<button onClick={() => setStatus('')} aria-label="Dismiss">×</button></div>}
          <div className="im-composer">
            <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} placeholder="iMessage" />
            <button className="im-attach" onClick={() => void sendFile()} title="Send a file"><Paperclip size={15} /></button>
            <button className={draft.trim() ? 'ready' : ''} disabled={!draft.trim()} onClick={() => void send()} title="Send"><ArrowUp size={16} strokeWidth={2.5} /></button>
          </div>
          {showDetails && details && <aside className="im-details">
            <button className="im-details-close" onClick={() => setShowDetails(false)} aria-label="Close details"><X size={16} /></button>
            <div className="im-details-hero">
              <Avatar person={details.group ? { name: chatTitle(selected.chat) } : details.person} size={72} group={details.group} />
              <h3>{chatTitle(selected.chat)}</h3>
              <p>{details.group ? `${details.members.length} people` : details.person.realName ? `Nickname · Contacts: ${details.person.realName}` : details.nickname ? 'Nickname · Not in Contacts' : details.contact ? 'Contact' : 'Not in Contacts'}{details.services.length ? ` · ${details.services.join(' · ')}` : ''}</p>
            </div>
            <div className="im-details-actions">
              <button onClick={() => togglePin(selected.key)}>{pins.includes(selected.key) ? <><PinOff size={14} />Unpin</> : <><Pin size={14} />Pin</>}</button>
              {!details.group && nickDraft === null && <button onClick={() => setNickDraft(details.nickname)}><Tag size={14} />Nickname</button>}
              {!details.group && !editing && <button onClick={startEditing}>{details.contact ? <><Pencil size={14} />Edit</> : <><UserPlus size={14} />Add to Contacts</>}</button>}
            </div>
            {nickDraft !== null && !details.group && <section className="im-edit">
              <h4>Nickname</h4>
              <label>Shown instead of the contact name<input value={nickDraft} onChange={e => setNickDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveNickname(details.nickKey, nickDraft) }} placeholder={details.person.realName || details.person.name} autoFocus /></label>
              <p className="im-edit-note">Only visible in BridgeDeck on this computer. Your Contacts aren't changed.</p>
              <div className="im-edit-actions">
                {details.nickname && <button onClick={() => saveNickname(details.nickKey, '')}>Remove</button>}
                <button onClick={() => setNickDraft(null)}>Cancel</button>
                <button className="primary" onClick={() => saveNickname(details.nickKey, nickDraft)}>Save</button>
              </div>
            </section>}
            {editing && <section className="im-edit">
              <h4>{editing.personId ? 'Edit contact' : 'New contact'}</h4>
              <label>First name<input value={editing.firstName} onChange={e => setEditing({ ...editing, firstName: e.target.value })} autoFocus /></label>
              <label>Last name<input value={editing.lastName} onChange={e => setEditing({ ...editing, lastName: e.target.value })} /></label>
              <div className="im-edit-list">
                <span>Phone</span>
                {editing.phones.map((value, i) => <div key={i}><input value={value} onChange={e => setEditing({ ...editing, phones: editing.phones.map((v, j) => j === i ? e.target.value : v) })} placeholder="(555) 123-4567" /><button onClick={() => setEditing({ ...editing, phones: editing.phones.filter((_, j) => j !== i) })} title="Remove"><Minus size={13} /></button></div>)}
                <button className="im-edit-add" onClick={() => setEditing({ ...editing, phones: [...editing.phones, ''] })}><Plus size={13} />Add phone</button>
              </div>
              <div className="im-edit-list">
                <span>Email</span>
                {editing.emails.map((value, i) => <div key={i}><input value={value} onChange={e => setEditing({ ...editing, emails: editing.emails.map((v, j) => j === i ? e.target.value : v) })} placeholder="name@example.com" /><button onClick={() => setEditing({ ...editing, emails: editing.emails.filter((_, j) => j !== i) })} title="Remove"><Minus size={13} /></button></div>)}
                <button className="im-edit-add" onClick={() => setEditing({ ...editing, emails: [...editing.emails, ''] })}><Plus size={13} />Add email</button>
              </div>
              <p className="im-edit-note">Saved to Contacts on the Mac; iCloud syncs it to your other devices.</p>
              <div className="im-edit-actions">
                <button onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
                <button className="primary" onClick={() => void saveContact()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              </div>
              {status && <p className="im-edit-error">{status}</p>}
            </section>}
            {!editing && !details.group && !!details.entries.length && <section>
              <h4>Contact info</h4>
              {details.entries.map(entry => <div className="im-detail-row" key={entry.value}>
                <span><small>{entry.kind}</small>{entry.kind === 'Phone' ? formatAddress(entry.value) : entry.value}</span>
                <button onClick={() => copy(entry.value)} title="Copy">{copied === entry.value ? <Check size={14} /> : <Copy size={14} />}</button>
              </div>)}
            </section>}
            {details.group && <section>
              <h4>Members</h4>
              {details.members.map(member => <div className="im-detail-row member" key={member.address}>
                <Avatar person={member.person} size={28} />
                <span>{member.person.name}{member.person.id && <small>{formatAddress(member.address)}</small>}</span>
                <button onClick={() => copy(member.address)} title="Copy">{copied === member.address ? <Check size={14} /> : <Copy size={14} />}</button>
              </div>)}
            </section>}
            <section>
              <h4>Photos</h4>
              {details.photos.length ? <div className="im-photo-grid">{details.photos.map(a => <AttachmentView key={a.guid} attachment={a} peer={peer} onOpen={setViewer} thumb />)}</div> : <p className="im-hint">No photos in recent messages</p>}
            </section>
            <section>
              <h4>Links</h4>
              {details.links.length ? details.links.map(url => <a className="im-link-row" key={url} href={url} onClick={e => { e.preventDefault(); void openExternal(url) }}><Link2 size={14} /><span>{url.replace(/^https?:\/\//, '')}</span></a>) : <p className="im-hint">No links in recent messages</p>}
            </section>
          </aside>}
        </> : <div className="im-empty-shell"><MessageSquare size={28} /><p>{status || 'Select a conversation'}</p></div>}
      </section>
      {viewer && <div className="im-viewer" onClick={() => setViewer('')} role="dialog" aria-label="Photo"><img src={viewer} alt="" /></div>}
    </div>
  )
}
