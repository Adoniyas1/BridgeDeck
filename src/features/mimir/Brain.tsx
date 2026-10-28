import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleX, Download, Pause, Play, Stethoscope, Trash2 } from 'lucide-react'
import { mimirControl } from '../../lib/bridge'
import { Toggle } from '../../ui'

/** Mimir's brain and model library, set from BridgeDeck's settings. They talk to the running Mimir
 *  through its control channel (src-tauri/src/mimir_host.rs mimir_control); the channel names are
 *  Mimir's own (mimir/src/shared/types.ts IPC). */

const CH = {
  teamGet: 'mimir:team:get-config',
  teamSet: 'mimir:team:set-config',
  setHonchoKey: 'mimir:team:set-honcho-key',
  hermesInstall: 'mimir:hermes:install',
  hermesStatus: 'mimir:hermes:install-status',
  library: 'mimir:models:library',
  quants: 'mimir:models:quants',
  download: 'mimir:models:download',
  pause: 'mimir:models:pause',
  remove: 'mimir:models:remove',
  use: 'mimir:models:use',
  check: 'mimir:ai:check',
} as const

type Engine = 'mimir' | 'hermes' | 'claude-code' | 'opencode'
type Team = {
  engine: Engine
  engineModels: 'team' | 'own'
  engineFallback?: boolean
  engineCommands: Record<'claude-code' | 'opencode' | 'hermes', string | null>
  honcho: { enabled: boolean; baseUrl: string | null; peerName: string; keySaved: boolean }
}
type HermesState = { running: boolean; ok: boolean | null; log: string[]; command: string | null; found: string | null }

const ENGINES: Array<{ id: Engine; name: string; what: string }> = [
  { id: 'mimir', name: 'Mimir', what: 'Its own agent and your models (the Brain team).' },
  { id: 'hermes', name: 'Hermes', what: 'Nous Research’s agent: learns skills and remembers between chats, with Mimir’s tools.' },
  { id: 'claude-code', name: 'Claude Code', what: 'Anthropic’s coding agent, with Mimir’s tools.' },
  { id: 'opencode', name: 'OpenCode', what: 'The open-source coding agent, with Mimir’s tools.' },
]

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Which agent runs Mimir's chat, Hermes's install, and Honcho as its memory. */
export function MimirBrain() {
  const [team, setTeam] = useState<Team | null>(null)
  const [hermes, setHermes] = useState<HermesState | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void mimirControl<Team>(CH.teamGet).then(setTeam).catch(e => setError(errorText(e))) }, [])
  useEffect(() => {
    if (team?.engine !== 'hermes') return
    let stop = false
    let timer = 0
    const poll = async () => {
      const state = await mimirControl<HermesState>(CH.hermesStatus).catch(() => null)
      if (stop) return
      setHermes(state)
      // Keep watching while it installs.
      if (state?.running) timer = window.setTimeout(() => void poll(), 1500)
      else if (state?.ok) void mimirControl<Team>(CH.teamGet).then(setTeam).catch(() => undefined)
    }
    void poll()
    return () => { stop = true; window.clearTimeout(timer) }
  }, [team?.engine, hermes?.running])

  if (!team) return error ? <p className="notes-error">{error}</p> : null
  async function save(patch: Partial<Team>) {
    setError('')
    try { setTeam(await mimirControl<Team>(CH.teamSet, [patch])) } catch (e) { setError(errorText(e)) }
  }
  async function install() {
    setError('')
    try { setHermes({ ...(await mimirControl<HermesState>(CH.hermesInstall)), found: null }) } catch (e) { setError(errorText(e)) }
  }
  async function saveKey() {
    try { setTeam(await mimirControl<Team>(CH.setHonchoKey, [key])); setKey('') } catch (e) { setError(errorText(e)) }
  }

  return <div className="settings-block">
    <h3>Mimir’s brain</h3>
    <div className="skill-pack-list">{ENGINES.map(e => <label key={e.id} className="skill-pack">
      <input type="radio" name="mimir-engine" checked={team.engine === e.id} onChange={() => void save({ engine: e.id })} />
      <span className="grow"><strong>{e.name}</strong><small>{e.what}</small></span>
    </label>)}</div>
    {team.engine !== 'mimir' && <Toggle checked={team.engineModels === 'team'} onChange={on => void save({ engineModels: on ? 'team' : 'own' })} label="Use the Brain team’s models (off: the agent’s own models and login)" />}
    {team.engine !== 'mimir' && <Toggle checked={team.engineFallback !== false} onChange={on => void save({ engineFallback: on })} label="When it can’t answer (not installed, signed out, an error), Mimir answers with its own model and says why" />}

    {team.engine === 'hermes' && <>
      <p className="hint">
        {hermes?.running ? 'Installing Hermes…'
          : hermes?.found ? `Hermes is installed (${hermes.found}).`
          : 'Hermes isn’t installed on this computer yet. Install sets it up without its browser and computer-use parts, adds what Mimir talks to it with (ACP), and checks it.'}
      </p>
      <div className="actions">
        <button disabled={!!hermes?.running} onClick={() => void install()}><Download size={15} />{hermes?.running ? 'Installing…' : hermes?.found ? 'Reinstall or update Hermes' : 'Install Hermes'}</button>
      </div>
      {!!hermes?.log.length && <pre className="mimir-log">{hermes.log.slice(-40).join('\n')}</pre>}

      <Toggle checked={team.honcho.enabled} onChange={enabled => void save({ honcho: { ...team.honcho, enabled } })} label="Honcho memory: Hermes builds a picture of you across chats (honcho.dev)" />
      {team.honcho.enabled && <>
        <label>Honcho API key {team.honcho.keySaved ? '(saved)' : ''}
          <span className="key-row"><input type="password" value={key} placeholder={team.honcho.keySaved ? 'Saved. Type to replace it' : 'From app.honcho.dev'} onChange={e => setKey(e.target.value)} />
            <button className="secondary" disabled={!key.trim()} onClick={() => void saveKey()}>Save key</button></span>
        </label>
        <label>Your own Honcho server (optional)
          <input value={team.honcho.baseUrl ?? ''} placeholder="Blank: honcho.dev" onChange={e => setTeam({ ...team, honcho: { ...team.honcho, baseUrl: e.target.value || null } })} onBlur={() => void save({ honcho: team.honcho })} />
        </label>
        <label>Your name to Honcho
          <input value={team.honcho.peerName} onChange={e => setTeam({ ...team, honcho: { ...team.honcho, peerName: e.target.value } })} onBlur={() => void save({ honcho: team.honcho })} />
        </label>
        <p className="hint">Mimir’s own memory stays in your notes either way (“Mimir’s memory” and “About you (Mimir)”). If Hermes was installed before Honcho was turned on, install again to add Honcho’s plugin.</p>
      </>}
    </>}
    {error && <p className="notes-error">{error}</p>}
  </div>
}

type Fit = { ok: boolean; level: 'fits' | 'tight' | 'too-big'; detail: string }
type Library = {
  computer: 'mac' | 'pc'
  room: { disk: number; ram: number; vram: number }
  catalog: Array<{ id: string; name: string; repo: string; quant: string; approxGb: number; note: string; vision?: boolean; fit: Fit; forThisComputer: boolean; roles: Role[] }>
  downloads: Array<{ id: string; repo: string; file: string; path: string; done: number; total: number; status: 'downloading' | 'paused' | 'done' | 'error'; error: string | null; speed: number }>
  local: Array<{ repo: string; file: string; path: string; bytes: number; roles: Role[] }>
}
type Role = 'head' | 'executor' | 'checker'
const ROLE_NAMES: Record<Role, string> = { head: 'Head', executor: 'Executor', checker: 'Checker' }

export const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`
const FIT_WORDS: Record<Fit['level'], string> = { fits: 'Fits', tight: 'Tight', 'too-big': 'Too big' }

function FitBadge({ fit }: { fit: Fit }) {
  return <small className={`model-fit model-fit--${fit.level}`} title={fit.detail}>{FIT_WORDS[fit.level]}</small>
}

/** Download models for Mimir's Brain team and give them to a role. */
export function ModelLibrary() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [repo, setRepo] = useState('')
  const [quants, setQuants] = useState<Array<{ quant: string; bytes: number; fit: Fit }> | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const load = () => mimirControl<Library>(CH.library).then(setLibrary).catch(e => setError(errorText(e)))
  useEffect(() => { void load() }, [])
  const downloading = !!library?.downloads.some(d => d.status === 'downloading')
  useEffect(() => {
    if (!downloading) return
    const timer = window.setInterval(() => void load(), 1000)
    return () => window.clearInterval(timer)
  }, [downloading])

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label); setError(''); setNote('')
    try { await action() } catch (e) { setError(errorText(e)) } finally { setBusy(''); void load() }
  }
  const download = (r: string, quant: string) => run(`${r}:${quant}`, () => mimirControl(CH.download, [r, quant]))
  const lookUp = () => run('repo', async () => { setQuants(null); setQuants(await mimirControl(CH.quants, [repo.trim()])) })
  const use = (file: string, role: Role) => run(file, async () => setNote(await mimirControl<string>(CH.use, [file, role])))

  if (!library) return error ? <p className="notes-error">{error}</p> : null
  const jobFor = (r: string, quant: string) => library.downloads.find(d => d.id === `${r}:${quant}`)
  const room = library.computer === 'pc' && library.room.vram ? `${gb(library.room.vram)} graphics memory, ${gb(library.room.ram)} RAM` : `${gb(library.room.ram)} memory`

  return <div className="settings-block">
    <h3>AI models</h3>
    <p className="hint">Download models for Mimir to run on this computer ({room}, {gb(library.room.disk)} free disk). Picked for your {library.computer === 'mac' ? 'Mac' : 'PC'} first; any GGUF model on Hugging Face works too.</p>
    <div className="skill-pack-list">{library.catalog.map(m => {
      const job = jobFor(m.repo, m.quant)
      return <div key={m.id} className="skill-pack">
        <span className="grow"><strong>{m.name} <FitBadge fit={m.fit} /></strong><small>{m.note}</small><small>~{m.approxGb} GB · {m.repo} ({m.quant}){m.vision ? ' · reads pictures' : ''}{m.forThisComputer ? '' : ' · made for the other computer'}</small></span>
        <DownloadButton job={job} busy={busy === `${m.repo}:${m.quant}`} disabled={!m.fit.ok} onStart={() => void download(m.repo, m.quant)} onPause={() => void run('', () => mimirControl(CH.pause, [job?.id]))} />
      </div>
    })}</div>

    <label>A model from Hugging Face
      <span className="key-row"><input value={repo} placeholder="owner/name, e.g. unsloth/Qwen3.5-9B-GGUF" onChange={e => setRepo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && repo.trim()) void lookUp() }} />
        <button className="secondary" disabled={!repo.trim() || busy === 'repo'} onClick={() => void lookUp()}>{busy === 'repo' ? 'Looking…' : 'Look up'}</button></span>
    </label>
    {quants && (quants.length ? <div className="skill-pack-list">{quants.map(q => <div key={q.quant} className="skill-pack">
      <span className="grow"><strong>{q.quant} <FitBadge fit={q.fit} /></strong><small>{gb(q.bytes)} · {q.fit.detail}</small></span>
      <DownloadButton job={jobFor(repo.trim(), q.quant)} busy={busy === `${repo.trim()}:${q.quant}`} disabled={!q.fit.ok} onStart={() => void download(repo.trim(), q.quant)} onPause={() => void run('', () => mimirControl(CH.pause, [`${repo.trim()}:${q.quant}`]))} />
    </div>)}</div> : <p className="hint">That repo has no .gguf files.</p>)}

    {library.downloads.filter(d => d.status !== 'done').map(d => <div key={d.id} className="model-download">
      <span className="grow"><strong>{d.file.split('/').pop()}</strong>
        <small>{d.status === 'error' ? d.error : d.status === 'paused' ? `Paused at ${gb(d.done)} of ${gb(d.total)}` : `${gb(d.done)} of ${gb(d.total)}${d.speed ? ` · ${(d.speed / 1024 ** 2).toFixed(1)} MB/s` : ''}`}</small>
        <div className="progress-line"><i style={{ width: d.total ? `${(d.done / d.total) * 100}%` : 0 }} /></div>
      </span>
      <button className="secondary" title="Stop and delete" onClick={() => void run('', () => mimirControl(CH.remove, [d.id]))}><Trash2 size={14} /></button>
    </div>)}

    {!!library.local.length && <>
      <h3>Downloaded</h3>
      {library.local.map(m => <div key={m.path} className="model-download">
        <span className="grow"><strong>{m.file}</strong><small>{gb(m.bytes)} · {m.repo}{m.roles.length ? ` · the ${m.roles.map(r => ROLE_NAMES[r]).join(' and ')}` : ''}</small></span>
        <select value="" disabled={busy === m.path} onChange={e => { if (e.target.value) void use(m.path, e.target.value as Role) }} aria-label="Use this model for">
          <option value="">{busy === m.path ? 'Switching…' : 'Use for…'}</option>
          {(Object.keys(ROLE_NAMES) as Role[]).map(r => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
        </select>
      </div>)}
    </>}
    {note && <p className="hint">{note}</p>}
    {error && <p className="notes-error">{error}</p>}
  </div>
}

function DownloadButton({ job, busy, disabled, onStart, onPause }: { job: Library['downloads'][number] | undefined; busy: boolean; disabled: boolean; onStart: () => void; onPause: () => void }) {
  if (job?.status === 'done') return <small>Downloaded</small>
  if (job?.status === 'downloading') return <button className="secondary" onClick={onPause}><Pause size={14} />{job.total ? `${Math.floor((job.done / job.total) * 100)}%` : '…'}</button>
  return <button className="secondary" disabled={busy || (disabled && !job)} title={disabled ? 'Too big for this computer' : undefined} onClick={onStart}>
    {job?.status === 'paused' || job?.status === 'error' ? <><Play size={14} />Resume</> : <><Download size={14} />{busy ? 'Starting…' : 'Download'}</>}
  </button>
}

type Check = { label: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }
const CHECK_ICONS = { ok: CircleCheck, warn: CircleAlert, fail: CircleX }

/** "Test my AI setup": each part Mimir's answers depend on, checked by Mimir (health/aiCheck.ts),
 *  with what's wrong in plain words and what to do. */
export function AiCheckup({ running }: { running: boolean }) {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run() {
    setBusy(true); setError('')
    try { setChecks(await mimirControl<Check[]>(CH.check)) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const bad = checks?.filter(c => c.status === 'fail').length ?? 0
  return <div className="settings-block">
    <h3>Test my AI setup</h3>
    <p className="hint">Checks everything Mimir’s answers depend on: who answers and on which model, whether its servers and models are there, Hermes and the context it needs, and BridgeDeck’s link. Nothing is changed.</p>
    <div className="actions"><button disabled={!running || busy} onClick={() => void run()}><Stethoscope size={15} />{busy ? 'Testing…' : checks ? 'Test again' : 'Test my AI setup'}</button></div>
    {!running && <p className="hint">Start Mimir first (Run Mimir with BridgeDeck, above).</p>}
    {checks && <>
      <p className="hint">{bad ? `${bad} thing${bad === 1 ? '' : 's'} to fix.` : checks.some(c => c.status === 'warn') ? 'Working, with something to look at.' : 'Everything works.'}</p>
      <div className="ai-checks">{checks.map(c => {
        const Icon = CHECK_ICONS[c.status]
        return <div key={c.label} className={`ai-check ai-check--${c.status}`}>
          <Icon size={16} />
          <span className="grow"><strong>{c.label}</strong><small>{c.detail}</small>{c.fix && <small className="ai-check__fix">{c.fix}</small>}</span>
        </div>
      })}</div>
    </>}
    {error && <p className="notes-error">{error}</p>}
  </div>
}
