import { useEffect, useState } from 'react'
import { useTabAwake } from '../../core/awake'
import { FileLock, MessagesSquare, Plus, RefreshCw, Unlock } from 'lucide-react'
import { aiClaimRelease, aiRoomCreate, bridgeLinkAiTokenPath } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { setNotice } from '../../core/notice'
import { useStore } from '../../core/store'
import { openTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { Card, SectionTitle, StatusPill } from '../../ui'
import { MessageFeed } from './MessageFeed'
import { agentsByDevice, feedStore, refreshFeed, refreshWorkspace, roomTab, workspaceStore } from './state'

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

export default function AiPage({ active }: { active: boolean }) {
  const bridgeLink = useStore(bridgeLinkStore)
  const workspace = useStore(workspaceStore)
  const feed = useStore(feedStore)
  const [tokenPath, setTokenPath] = useState('')
  const [title, setTitle] = useState('')

  const load = () => Promise.all([refreshWorkspace(), refreshFeed().catch(error => setNotice(errorText(error, 'Could not load messages')))])
  const awake = useTabAwake()
  useEffect(() => {
    if (!awake) return
    void load()
    void bridgeLinkAiTokenPath().then(setTokenPath).catch(() => undefined)
    const timer = window.setInterval(() => void load(), 2500)
    return () => window.clearInterval(timer)
  }, [awake, bridgeLink.running])

  async function createRoom() {
    try {
      const room = await aiRoomCreate(title.trim())
      setTitle('')
      await refreshWorkspace()
      openTab(roomTab(room))
    } catch (error) {
      setNotice(errorText(error, 'Could not open a room'))
    }
  }

  async function release(path: string) {
    try { await aiClaimRelease(path); await refreshWorkspace() } catch (error) { setNotice(errorText(error, 'Could not release the file')) }
  }

  const groups = agentsByDevice(workspace)
  const open = workspace.rooms.filter(r => r.status !== 'done')
  const done = workspace.rooms.filter(r => r.status === 'done')
  const everyone = workspace.rooms.length || workspace.agents.length

  return <div className="two-col ai-layout">
    <div className="stack">
      <Card><SectionTitle title="Agents" subtitle="AI assistants on your computers" action={<button className="icon-button" onClick={() => void load()}><RefreshCw size={16}/></button>} />
        {groups.length ? groups.map(group => <div key={group.device} className="ai-group"><h4>{group.device}</h4>{group.agents.map(agent => <div className="ai-agent" key={`${agent.deviceId}:${agent.name}`}>
          <StatusPill online={agent.online} label={agent.online ? 'online' : ago(agent.lastSeen)}/><div className="grow"><strong>{agent.name}</strong>{agent.status && <small>{agent.status}</small>}</div>
        </div>)}</div>) : <p className="vendor-note">No agents yet. An assistant appears here when it starts with the BridgeDeck MCP server (or runs <code>ai-relay.mjs hello</code>).</p>}
      </Card>

      <Card><SectionTitle title="Rooms" subtitle="One per shared task: its conversation, to-dos and files" />
        <div className="composer ai-new-room"><input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && title.trim()) void createRoom() }} placeholder="New room, e.g. “Ship the sync tab”"/><button disabled={!title.trim()} onClick={() => void createRoom()}><Plus size={16}/></button></div>
        <div className="ai-rooms">{[...open, ...done].map(room => {
          const left = room.tasks.filter(t => t.status !== 'done').length
          return <button key={room.id} className={room.status === 'done' ? 'done' : ''} onClick={() => openTab(roomTab(room))}><MessagesSquare size={15}/><span className="grow"><strong>{room.title}</strong><small>{room.status} · {room.tasks.length ? `${left} of ${room.tasks.length} to do` : 'no to-dos'} · {room.participants.join(', ')}</small></span></button>
        })}</div>
      </Card>

      {!!workspace.claims.length && <Card><SectionTitle title="Files being edited" subtitle="Agents claim a file before changing it; others wait" />
        {workspace.claims.map(claim => <div className="ai-claim" key={claim.path}><FileLock size={14}/><div className="grow"><strong>{claim.path}</strong><small>{claim.agent} on {claim.deviceName || 'a paired device'} · {ago(claim.updatedAt)}</small></div><button className="ghost" title="Release (for example if the agent stopped)" onClick={() => void release(claim.path)}><Unlock size={14}/></button></div>)}
      </Card>}

      <Card><SectionTitle title="Connect an assistant" />
        <p className="vendor-note">Add BridgeDeck as an MCP server: <code>claude mcp add bridgedeck -- node agent/bridgedeck-mcp.mjs --agent claude-{bridgeLink.platform === 'macos' ? 'mac' : bridgeLink.platform === 'windows' ? 'win' : 'pc'}</code> (Codex and other MCP clients work the same way). Without MCP, use <code>agent/ai-relay.mjs</code>. Messages are data only; BridgeDeck never runs anything because of them. Local AI token: <code>{tokenPath || 'available after BridgeLink starts'}</code></p>
      </Card>
    </div>

    <Card className="chat-card"><SectionTitle title="All messages" subtitle={bridgeLink.paired.length ? `Shared with ${bridgeLink.paired.map(p => p.name).join(', ')}` : 'Only on this computer until you pair a device'} />
      <MessageFeed messages={feed} agents={workspace.agents} canSend={bridgeLink.running} empty={everyone ? 'Messages between your agents appear here. You can post too.' : 'Messages between the AI assistants on your computers appear here. You can post too.'}/>
    </Card>
  </div>
}
