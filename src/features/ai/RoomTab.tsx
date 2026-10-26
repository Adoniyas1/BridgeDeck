import { useEffect, useState } from 'react'
import { useTabAwake } from '../../core/awake'
import { Check, Circle, CircleDot, FileLock, Plus, Trash2, Unlock } from 'lucide-react'
import { aiClaimRelease, aiRoomRemove, aiRoomUpdate, aiTaskAdd, aiTaskUpdate } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { setNotice } from '../../core/notice'
import { useStore } from '../../core/store'
import { closeTab, type DynamicTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import type { AiTask } from '../../types'
import { Card, SectionTitle } from '../../ui'
import { MessageFeed } from './MessageFeed'
import { feedStore, refreshFeed, refreshWorkspace, workspaceStore } from './state'

const next: Record<AiTask['status'], AiTask['status']> = { todo: 'doing', doing: 'done', done: 'todo' }
const TaskIcon = ({ status }: { status: AiTask['status'] }) => status === 'done' ? <Check size={15}/> : status === 'doing' ? <CircleDot size={15}/> : <Circle size={15}/>

/** One room: its to-dos, its conversation and the files its agents are editing. */
export default function RoomTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const id = String(tab.params?.room ?? '')
  const workspace = useStore(workspaceStore)
  const feed = useStore(feedStore)
  const running = useStore(bridgeLinkStore).running
  const [task, setTask] = useState('')
  const room = workspace.rooms.find(r => r.id === id)

  const awake = useTabAwake()
  useEffect(() => {
    if (!awake) return
    const load = () => Promise.all([refreshWorkspace(), refreshFeed().catch(() => undefined)])
    void load()
    const timer = window.setInterval(() => void load(), 2500)
    return () => window.clearInterval(timer)
  }, [awake, id])

  const act = async (what: string, change: () => Promise<unknown>) => {
    try { await change(); await refreshWorkspace() } catch (error) { setNotice(errorText(error, `Could not ${what}`)) }
  }

  if (!room) return <Card><div className="bb-placeholder">This room was removed, or hasn't reached this computer yet.</div></Card>

  const messages = feed.filter(m => m.room === id)
  const claims = workspace.claims.filter(c => c.room === id)
  const assignees = [...new Set([...room.participants, ...workspace.agents.map(a => a.name)])].sort()

  return <div className="two-col ai-layout">
    <div className="stack">
      <Card><SectionTitle title={room.title} subtitle={`Opened by ${room.createdBy} · ${room.participants.join(', ')}`} action={
        <select value={room.status} onChange={e => void act('change the room', () => aiRoomUpdate(id, { status: e.target.value }))}><option value="open">Open</option><option value="in-progress">In progress</option><option value="done">Done</option></select>} />
        <div className="ai-tasks">{room.tasks.map(t => <div key={t.id} className={`ai-task ${t.status}`}>
          <button className="ghost" title={`Mark ${next[t.status]}`} onClick={() => void act('update the to-do', () => aiTaskUpdate(id, t.id, { status: next[t.status] }))}><TaskIcon status={t.status}/></button>
          <span className="grow">{t.title}</span>
          <select value={t.assignee ?? ''} onChange={e => void act('assign the to-do', () => aiTaskUpdate(id, t.id, { assignee: e.target.value }))}><option value="">Anyone</option>{assignees.map(a => <option key={a} value={a}>{a}</option>)}</select>
        </div>)}</div>
        <div className="composer ai-new-room"><input value={task} onChange={e => setTask(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && task.trim()) void act('add the to-do', () => aiTaskAdd(id, task.trim())).then(() => setTask('')) }} placeholder="Add a to-do…"/><button disabled={!task.trim()} onClick={() => void act('add the to-do', () => aiTaskAdd(id, task.trim())).then(() => setTask(''))}><Plus size={16}/></button></div>
        {room.status === 'done' && <div className="actions"><button className="danger" onClick={() => void act('remove the room', async () => { await aiRoomRemove(id); closeTab(tab.id) })}><Trash2 size={14}/>Remove room</button></div>}
      </Card>
      {!!claims.length && <Card><SectionTitle title="Files being edited here" />
        {claims.map(claim => <div className="ai-claim" key={claim.path}><FileLock size={14}/><div className="grow"><strong>{claim.path}</strong><small>{claim.agent} on {claim.deviceName || 'a paired device'}</small></div><button className="ghost" title="Release" onClick={() => void act('release the file', () => aiClaimRelease(claim.path))}><Unlock size={14}/></button></div>)}
      </Card>}
    </div>
    <Card className="chat-card"><SectionTitle title="Conversation" subtitle="Messages sent in this room" />
      <MessageFeed messages={messages} agents={workspace.agents} room={id} canSend={running} empty="Agents talk here when they send with this room's id. Post the plan to get them started."/>
    </Card>
  </div>
}
