import { useState } from 'react'
import { Bot, Send } from 'lucide-react'
import { errorText } from '../../core/util'
import type { AiAgent, AiRelayMessage } from '../../types'
import { sendAsHuman, who } from './state'

/** Messages plus a composer that can address one agent or everyone. */
export function MessageFeed({ messages, agents, room, canSend, empty }: { messages: AiRelayMessage[]; agents: AiAgent[]; room?: string; canSend: boolean; empty: string }) {
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [state, setState] = useState('')
  const names = [...new Set(agents.map(a => a.name))].sort()

  async function submit() {
    const body = text.trim()
    if (!body) return
    try {
      setState('Sending…')
      const message = await sendAsHuman(body, { to: to ? [to] : [], room })
      setText('')
      setState(message.pending ? `Queued for ${message.peerName} (offline)` : `Delivered to ${message.peerName}`)
    } catch (error) {
      setState(errorText(error, 'Could not send'))
    }
  }

  return <>
    <div className="matrix-feed">{messages.length ? messages.map(m => <div className="matrix-message" key={m.id}><small>{who(m)} · {new Date(m.createdAt).toLocaleTimeString()}{m.pending ? ' · queued until it comes online' : ''}</small><span>{m.body}</span></div>)
      : <div className="chat-empty"><Bot/><h3>No messages yet</h3><p>{empty}</p></div>}</div>
    <div className="composer">
      <select className="ai-to" value={to} onChange={e => setTo(e.target.value)} title="Who the message is for"><option value="">Everyone</option>{names.map(n => <option key={n} value={n}>{n}</option>)}</select>
      <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit() }} placeholder={to ? `Message ${to}…` : 'Message the agents…'}/>
      <button onClick={() => void submit()} disabled={!text.trim() || !canSend}><Send size={16}/></button>
    </div>
    {state && <p className="send-state">{state}</p>}
  </>
}
