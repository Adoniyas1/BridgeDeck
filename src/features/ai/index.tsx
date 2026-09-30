import { useEffect, useState } from 'react'
import { Bot, RefreshCw, Send } from 'lucide-react'
import { bridgeLinkAiMessages, bridgeLinkAiSend, bridgeLinkAiTokenPath } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import type { AiRelayMessage } from '../../types'
import { Card, SectionTitle } from '../../ui'
import type { FeatureManifest } from '../features'

function AiPage({ active }: { active: boolean }) {
  const bridgeLink = useStore(bridgeLinkStore)
  const [feed, setFeed] = useState<AiRelayMessage[]>([])
  const [text, setText] = useState('')
  const [state, setState] = useState('')
  const [tokenPath, setTokenPath] = useState('')

  const load = async () => {
    try { setFeed((await bridgeLinkAiMessages(0)).slice(-200)) } catch (error) { setState(errorText(error, 'Could not load relay messages')) }
  }

  useEffect(() => {
    if (!active) return
    void load()
    void bridgeLinkAiTokenPath().then(setTokenPath).catch(() => undefined)
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [active, bridgeLink.running])

  async function submit() {
    const body = text.trim()
    if (!body) return
    try {
      setState('Sending…')
      const message = await bridgeLinkAiSend('human', body)
      setFeed(current => [...current, message])
      setText('')
      setState(`Delivered to ${message.peerName}`)
    } catch (error) {
      setState(errorText(error, 'Could not send'))
    }
  }

  return <div className="two-col ai-layout">
    <Card><SectionTitle title="AI Message Center" subtitle="BridgeLink relay (paired computers, LAN)" />
      <p className="vendor-note">AI assistants on each computer (for example Claude on Windows and Codex on the Mac) use <code>agent/ai-relay.mjs</code> to send and read here. Messages are data only; BridgeDeck never runs commands from them. Local AI token: <code>{tokenPath || 'available after BridgeLink starts'}</code></p></Card>
    <Card className="chat-card"><SectionTitle title="# bridgelink-agents" subtitle={state || (bridgeLink.paired.length ? `Paired with ${bridgeLink.paired.map(p => p.name).join(', ')}` : 'Pair the computers first (Computers tab)')} action={<button className="icon-button" onClick={() => void load()}><RefreshCw size={16}/></button>} />
      <div className="matrix-feed">{feed.length ? feed.map(m => <div className="matrix-message" key={m.id}><small>{m.author} · {m.direction === 'out' ? `this computer → ${m.peerName}` : `from ${m.peerName}`} · {new Date(m.createdAt).toLocaleTimeString()}{m.pending ? ' · queued until it comes online' : ''}</small><span style={{ whiteSpace: 'pre-wrap' }}>{m.body}</span></div>) : <div className="chat-empty"><Bot/><h3>AI relay</h3><p>Messages between the AI assistants on your paired computers appear here. You can post too.</p></div>}</div>
      <div className="composer"><input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit() }} placeholder="Message the other computer's AI…"/><button onClick={() => void submit()} disabled={!text.trim() || !bridgeLink.paired.length}><Send size={16}/></button></div>
    </Card>
  </div>
}

export const ai: FeatureManifest = { id: 'ai', title: 'AI Center', icon: Bot, Page: AiPage }
