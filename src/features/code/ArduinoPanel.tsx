import { useEffect, useRef, useState } from 'react'
import { Cpu, Download, Loader2, Play, RefreshCw, Send, Square, Upload, Usb } from 'lucide-react'
import { arduinoCompile, arduinoPorts, arduinoSetup, arduinoStatus, arduinoUpload, isTauri, type ArduinoPort, type ArduinoStatus } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { CLOCK_HZ, PINS, Uno, type PinLevel } from './arduinoSim'

const BOARDS = [
  { fqbn: 'arduino:avr:uno', name: 'Arduino Uno', simulated: true },
  { fqbn: 'arduino:avr:nano', name: 'Arduino Nano', simulated: true },
  { fqbn: 'arduino:avr:mega', name: 'Arduino Mega 2560', simulated: false },
]
const BOARD_KEY = 'bridgedeck.code.arduinoBoard'
const MAX_SERIAL = 20_000

/** Arduino in the Code tab: build the sketch and run it on a simulated Uno (its pins lit as they
 *  change, a serial monitor, inputs to press), or upload it to a real board over USB. */
export function ArduinoPanel({ source }: { source: string }) {
  const [status, setStatus] = useState<ArduinoStatus | null>(null)
  const [settingUp, setSettingUp] = useState(false)
  const [fqbn, setFqbn] = useState(() => { try { return localStorage.getItem(BOARD_KEY) ?? BOARDS[0].fqbn } catch { return BOARDS[0].fqbn } })
  const [ports, setPorts] = useState<ArduinoPort[] | null>(null)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState<'' | 'build' | 'upload'>('')
  const [output, setOutput] = useState('')
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const [pins, setPins] = useState<PinLevel[]>([])
  const [driven, setDriven] = useState<Record<string, boolean>>({})
  const [serial, setSerial] = useState('')
  const [typed, setTyped] = useState('')
  const [clock, setClock] = useState({ seconds: 0, speed: 1 })
  const uno = useRef<Uno | null>(null)
  const frame = useRef(0)
  const serialBox = useRef<HTMLPreElement>(null)
  const board = BOARDS.find(b => b.fqbn === fqbn) ?? BOARDS[0]
  const ready = !!status?.cli && status.avr

  const check = () => { if (isTauri()) void arduinoStatus().then(setStatus).catch(() => undefined) }
  useEffect(check, [])
  useEffect(() => { try { localStorage.setItem(BOARD_KEY, fqbn) } catch { /* this run only */ } }, [fqbn])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  useEffect(() => { const el = serialBox.current; if (el) el.scrollTop = el.scrollHeight }, [serial])

  async function setup() {
    setSettingUp(true); setMessage('Installing arduino-cli and the Uno’s tools (about 150 MB, a few minutes)…')
    try { setMessage(await arduinoSetup()); check() } catch (e) { setMessage(errorText(e, 'Couldn’t set up Arduino')) } finally { setSettingUp(false) }
  }

  function stop() {
    cancelAnimationFrame(frame.current)
    setRunning(false)
  }

  async function simulate() {
    stop()
    setBusy('build'); setOutput(''); setMessage('')
    try {
      const built = await arduinoCompile(source, board.simulated ? fqbn : 'arduino:avr:uno')
      setOutput(built.output.trim())
      if (!built.ok || !built.hex) { setMessage('It didn’t build: see the messages below.'); return }
      const sim = new Uno(built.hex)
      sim.onSerial = t => setSerial(s => (s + t).slice(-MAX_SERIAL))
      for (const [name, high] of Object.entries(driven)) sim.setInput(name, high)
      uno.current = sim
      setSerial('')
      setRunning(true)
      setMessage(`Built in ${(built.ms / 1000).toFixed(1)} s; running on a simulated ${board.simulated ? board.name : 'Arduino Uno'} at 16 MHz.`)
      let last = performance.now()
      const tick = (now: number) => {
        // Real time, up to 50 ms a frame; slower when this computer can't keep up.
        const wanted = Math.min(now - last, 50) / 1000
        last = now
        const t = performance.now()
        sim.run(Math.round(wanted * CLOCK_HZ))
        const took = (performance.now() - t) / 1000
        setPins(PINS.map(p => sim.pin(p.name)))
        setClock({ seconds: sim.seconds, speed: took > wanted ? wanted / took : 1 })
        frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    } catch (e) { setMessage(errorText(e, 'Couldn’t build it')) } finally { setBusy('') }
  }

  /** An input pin: floating → pulled to ground (a pressed button) → driven high → floating. */
  function press(name: string) {
    const next = { ...driven }
    if (!(name in driven)) next[name] = false
    else if (driven[name] === false) next[name] = true
    else delete next[name]
    setDriven(next)
    uno.current?.setInput(name, name in next ? next[name] : null)
  }

  async function findPorts() {
    try {
      const list = await arduinoPorts()
      setPorts(list)
      const found = list.find(p => p.fqbn) ?? list[0]
      if (found && !list.some(p => p.address === port)) setPort(found.address)
      if (found?.fqbn && BOARDS.some(b => b.fqbn === found.fqbn)) setFqbn(found.fqbn)
    } catch (e) { setMessage(errorText(e, 'Couldn’t look for boards')) }
  }

  async function upload() {
    stop()
    setBusy('upload'); setOutput(''); setMessage('')
    try {
      const done = await arduinoUpload(source, fqbn, port)
      setOutput(done.output.trim())
      setMessage(done.ok ? `Uploaded to the ${board.name} on ${port}.` : 'It didn’t upload: see the messages below.')
    } catch (e) { setMessage(errorText(e, 'Couldn’t upload it')) } finally { setBusy('') }
  }

  function sendLine() {
    if (!uno.current) return
    uno.current.send(`${typed}\n`)
    setTyped('')
  }

  if (!isTauri()) return <div className="arduino"><p className="hint">Arduino needs the BridgeDeck app.</p></div>
  return <div className="arduino">
    <div className="arduino-bar">
      <Cpu size={14} />
      <select value={fqbn} onChange={e => setFqbn(e.target.value)} aria-label="Board">
        {BOARDS.map(b => <option key={b.fqbn} value={b.fqbn}>{b.name}</option>)}
      </select>
      {!ready
        ? <button className="primary" disabled={settingUp || !status} onClick={() => void setup()}>{settingUp ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {settingUp ? 'Setting up…' : 'Set up Arduino'}</button>
        : running
          ? <button className="danger" onClick={stop}><Square size={13} /> Stop</button>
          : <button className="primary" disabled={!!busy} title={board.simulated ? 'Build it and run it on a simulated board' : 'The simulator is an Uno; the Mega’s chip isn’t simulated'} onClick={() => void simulate()}>{busy === 'build' ? <Loader2 size={13} className="spin" /> : <Play size={13} />} {busy === 'build' ? 'Building…' : 'Simulate'}</button>}
    </div>
    {status && !ready && <p className="hint">{status.cli ? 'arduino-cli is here, but not the tools for Uno, Nano and Mega boards.' : 'Arduino needs arduino-cli, the open-source Arduino command line tool.'} Set up installs {status.cli ? 'them' : 'it and them'} (about 150 MB, needs the internet).</p>}
    {message && <p className="hint arduino-msg">{message}</p>}

    {(running || pins.length > 0) && <div className="arduino-board">
      <div className="arduino-led"><i className={pins[13] === 'high' ? 'on' : ''} /><span>L <small>(pin 13)</small></span></div>
      <div className="arduino-pins">{PINS.map((p, i) => {
        const level = pins[i] ?? 'input'
        const input = level === 'input' || level === 'pullup'
        const forced = p.name in driven ? (driven[p.name] ? 'HIGH' : 'LOW') : null
        return <button key={p.name} className={`arduino-pin ${level}`} disabled={!input && !forced} title={input ? `${p.name}: input${level === 'pullup' ? ' (pulled up)' : ''}. Click to pull it low (a pressed button), again for high, again to let go.` : `${p.name}: output ${level.toUpperCase()}`} onClick={() => press(p.name)}>
          <i />{p.name}{forced && <small>{forced}</small>}
        </button>
      })}</div>
      <small className="hint">{clock.seconds.toFixed(1)} s{clock.speed < 0.95 ? ` · ${Math.round(clock.speed * 100)}% of real speed` : ''}</small>
    </div>}

    {(running || serial) && <div className="arduino-serial">
      <div className="arduino-serial-head"><span>Serial monitor <small>9600 baud</small></span><button className="ghost" onClick={() => setSerial('')}>Clear</button></div>
      <pre ref={serialBox}>{serial || ' '}</pre>
      <form onSubmit={e => { e.preventDefault(); sendLine() }}>
        <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Send to the board (Enter)" disabled={!running} />
        <button className="ghost" disabled={!running}><Send size={13} /></button>
      </form>
    </div>}

    {ready && <div className="arduino-upload">
      <Usb size={14} />
      <select value={port} onChange={e => setPort(e.target.value)} aria-label="Port" onFocus={() => { if (!ports) void findPorts() }}>
        {!ports && <option value="">Plug in the board…</option>}
        {ports && !ports.length && <option value="">No boards found</option>}
        {ports?.map(p => <option key={p.address} value={p.address}>{p.board ? `${p.board} · ` : ''}{p.address}</option>)}
      </select>
      <button className="ghost" title="Look for boards again" onClick={() => void findPorts()}><RefreshCw size={13} /></button>
      <button className="ghost" disabled={!port || !!busy} onClick={() => void upload()}>{busy === 'upload' ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} {busy === 'upload' ? 'Uploading…' : 'Upload'}</button>
    </div>}

    {output && <details className="arduino-output" open={!running}>
      <summary>Compiler messages</summary>
      <pre>{output}</pre>
    </details>}
  </div>
}
