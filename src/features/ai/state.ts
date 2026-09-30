import { aiWorkspace, bridgeLinkAiMessages, bridgeLinkAiSend } from '../../lib/bridge'
import { createStore } from '../../core/store'
import type { AiRelayMessage, AiWorkspace } from '../../types'

export const workspaceStore = createStore<AiWorkspace>({ agents: [], rooms: [], claims: [] })
export const feedStore = createStore<AiRelayMessage[]>([])
/** Rooms not marked done (the tab's badge). */
export const openRoomsStore = createStore(0)

/** Name used for messages and rooms made by the person at this computer. */
export const HUMAN = 'human'

export async function refreshWorkspace() {
  try {
    const workspace = await aiWorkspace()
    workspaceStore.set(workspace)
    openRoomsStore.set(workspace.rooms.filter(r => r.status !== 'done').length)
  } catch { /* browser mode or BridgeLink stopped */ }
}

export async function refreshFeed() {
  feedStore.set((await bridgeLinkAiMessages(0)).slice(-300))
}

export async function sendAsHuman(body: string, options: { to?: string[]; room?: string } = {}) {
  const message = await bridgeLinkAiSend(HUMAN, body, options)
  feedStore.set(current => [...current, message])
  return message
}

export const roomTab = (room: { id: string; title: string }) => ({ id: `ai-room:${room.id}`, kind: 'ai-room', title: room.title, params: { room: room.id } })

/** Agent names grouped by the device they run on, local device first. */
export function agentsByDevice(workspace: AiWorkspace) {
  const groups = new Map<string, { device: string; local: boolean; agents: AiWorkspace['agents'] }>()
  for (const agent of workspace.agents) {
    const key = agent.local ? 'local' : agent.deviceId
    const group = groups.get(key) ?? { device: agent.local ? 'This computer' : agent.deviceName || 'Paired device', local: agent.local, agents: [] }
    group.agents.push(agent)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => Number(b.local) - Number(a.local) || a.device.localeCompare(b.device))
}

export const who = (m: AiRelayMessage) => `${m.author} · ${m.direction === 'out' ? `this computer → ${m.peerName}` : `from ${m.peerName}`}${m.to?.length ? ` · to ${m.to.join(', ')}` : ''}`
