import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { AlertTriangle, CheckCircle2, Code2, CornerDownLeft, Download, FlaskConical, Plus, ExternalLink, FilePlus, FolderOpen, Loader2, Play, RefreshCw, Save, ShieldCheck, Sparkles, Square, Trash2, XCircle } from 'lucide-react'
import { codeDelete, codeFiles, codeInput, codeOctaveInstall, codeRun, codeLanguages, codeLoad, codeSave, codeStart, codeStop, isTauri, type CodeEvent, type CodeFile, type CodeLanguage } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { askMimir } from '../mimir'
import { openTab } from '../../core/tabs'
import { useTabContext } from '../../core/tabContext'
import { openCodeRequest } from '../../core/openRequests'
import { useStore } from '../../core/store'
import { errorLines, highlight, indentUnit, newLine, octaveOnly, sameOutput, STARTERS } from './model'

const DRAFTS_KEY = 'bridgedeck.code.drafts'
const LANG_KEY = 'bridgedeck.code.language'
/** Each language's program as last left, so switching languages (or restarting) loses nothing. */
type Test = { input: string; expected: string }
type Draft = { name: string; source: string; input: string; tests?: Test[] }
type TestResult = { state: 'running' | 'pass' | 'fail' | 'error'; got: string; ms: number }
const readDrafts = (): Record<string, Draft> => { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') } catch { return {} } }
const readLang = () => { try { return localStorage.getItem(LANG_KEY) ?? 'python' } catch { return 'python' } }
const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'
const LIMITS = [10, 30, 60, 300, 0]

/** A run as it happens: the build, what the program printed (and what was typed to it), and how it ended. */
type Live = {
  id: number
  file: string
  compile: { text: string; ok: boolean; ms: number } | null
  segments: Array<{ kind: 'out' | 'err' | 'in'; text: string }>
  exit: CodeEvent | null
}

function apply(live: Live, e: CodeEvent): Live {
  if (e.kind === 'compile') return { ...live, file: e.file || live.file, compile: { text: e.text, ok: e.ok, ms: e.ms } }
  if (e.kind === 'exit') return { ...live, file: e.file || live.file, exit: e }
  const last = live.segments[live.segments.length - 1]
  const segments = last?.kind === e.kind ? [...live.segments.slice(0, -1), { kind: e.kind, text: last.text + e.text }] : [...live.segments, { kind: e.kind, text: e.text }]
  return { ...live, segments }
}

/** Write a program in C, Python, MATLAB and more, and run it with the compilers on this computer. */
export default function CodePage({ active }: { active: boolean }) {
  const [langs, setLangs] = useState<CodeLanguage[]>([])
  const [lang, setLang] = useState(readLang)
  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts)
  const draft: Draft = drafts[lang] ?? { name: 'Untitled', source: STARTERS[lang] ?? '', input: '' }
  const [live, setLive] = useState<Live | null>(null)
  const [starting, setStarting] = useState(false)
  const [typed, setTyped] = useState('')
  const [inputClosed, setInputClosed] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [limit, setLimit] = useState(60)
  const [files, setFiles] = useState<CodeFile[]>([])
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState('')
  const [side, setSide] = useState<'input' | 'tests'>('input')
  const [results, setResults] = useState<TestResult[]>([])
  const [testing, setTesting] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const shown = useRef<HTMLPreElement>(null)
  const term = useRef<HTMLDivElement>(null)
  const current = useRef<number | null>(null)
  /** Events for a run whose id hasn't come back yet (a fast program can finish before codeStart returns). */
  const early = useRef(new Map<number, CodeEvent[]>())
  const running = starting || (live !== null && !live.exit)
  const gutter = useRef<HTMLDivElement>(null)
  const info = langs.find(l => l.id === lang)

  useEffect(() => { if (isTauri()) void codeLanguages().then(setLangs).catch(() => undefined) }, [])
  useEffect(() => {
    if (!isTauri()) return
    const off = listen<CodeEvent>('code-event', ({ payload: e }) => {
      if (current.current === e.id) setLive(l => (l && l.id === e.id ? apply(l, e) : l))
      else if (current.current === null) early.current.set(e.id, [...(early.current.get(e.id) ?? []), e])
    })
    return () => { void off.then(f => f()) }
  }, [])
  useEffect(() => { const t = term.current; if (t) t.scrollTop = t.scrollHeight }, [live])
  useEffect(() => { if (active && isTauri()) void codeFiles().then(setFiles).catch(() => undefined) }, [active])
  useEffect(() => { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); localStorage.setItem(LANG_KEY, lang) } catch { /* this run only */ } }, [drafts, lang])

  const edit = (patch: Partial<Draft>) => setDrafts(d => ({ ...d, [lang]: { ...draft, ...patch } }))

  async function run() {
    if (running) return
    setStarting(true); setError(''); setMessage(''); setTyped(''); setInputClosed(false); setLive(null)
    current.current = null
    early.current.clear()
    try {
      const id = await codeStart(lang, draft.source, draft.input, limit)
      current.current = id
      setLive((early.current.get(id) ?? []).reduce(apply, { id, file: '', compile: null, segments: [], exit: null }))
      early.current.clear()
    } catch (e) { setError(errorText(e, 'It didn’t run')) } finally { setStarting(false) }
  }
  // What Mimir sees when asked about this tab: the program, and how its last run and tests went.
  useTabContext('code', () => {
    const name = info?.name ?? lang
    const output = live ? live.segments.map(x => (x.kind === 'in' ? `[typed] ${x.text}` : x.text)).join('').slice(-3000) : ''
    const parts = [`The ${name} program “${draft.name}”:\n\`\`\`${lang}\n${draft.source}\n\`\`\``]
    if (live?.compile && !live.compile.ok) parts.push(`It didn’t compile:\n\`\`\`\n${live.compile.text.slice(-3000)}\n\`\`\``)
    if (output) parts.push(`Its last run printed:\n\`\`\`\n${output}\n\`\`\``)
    if (status) parts.push(`Last run: ${status.text}.`)
    if (results.length) parts.push(`Tests: ${results.filter(r => r.state === 'pass').length} of ${results.length} passed.${results.map((r, i) => (r.state === 'fail' ? `\nTest ${i + 1}: input ${JSON.stringify((draft.tests ?? [])[i]?.input ?? '')}, expected ${JSON.stringify((draft.tests ?? [])[i]?.expected ?? '')}, got ${JSON.stringify(r.got.slice(0, 500))}` : '')).join('')}`)
    return { title: `${name} program “${draft.name}”`, text: parts.join('\n\n') }
  })

  const tests = draft.tests ?? []
  const setTests = (next: Test[]) => { edit({ tests: next }); setResults([]) }
  /** Runs the program once per test, with the test's input, and compares what it prints. */
  async function runTests() {
    if (testing || !tests.length) return
    setTesting(true); setError('')
    const out: TestResult[] = tests.map(() => ({ state: 'running', got: '', ms: 0 }))
    setResults([...out])
    for (let i = 0; i < tests.length; i++) {
      try {
        const r = await codeRun(lang, draft.source, tests[i].input, limit || 60)
        if (r.compile && !r.compile.ok) out[i] = { state: 'error', got: r.compile.stderr || r.compile.stdout, ms: r.compile.ms }
        else if (!r.run || r.run.timedOut) out[i] = { state: 'error', got: 'Stopped after the time limit.', ms: r.run?.ms ?? 0 }
        else out[i] = { state: sameOutput(r.run.stdout, tests[i].expected) ? 'pass' : r.run.ok ? 'fail' : 'error', got: r.run.ok ? r.run.stdout : `${r.run.stdout}${r.run.stderr}`, ms: r.run.ms }
      } catch (e) { out[i] = { state: 'error', got: errorText(e, 'It didn’t run'), ms: 0 } }
      setResults([...out])
    }
    setTesting(false)
  }
  const passed = results.filter(r => r.state === 'pass').length

  function send(close = false) {
    if (!live || live.exit) return
    const text = close ? '' : `${typed}\n`
    if (!close) setLive(l => (l ? { ...l, segments: [...l.segments, { kind: 'in', text }] } : l))
    setTyped('')
    if (close) setInputClosed(true)
    void codeInput(live.id, text, close).catch(e => setError(errorText(e, 'Couldn’t send that')))
  }
  const stop = () => { if (live && !live.exit) void codeStop(live.id).catch(() => undefined) }
  async function save() {
    setError('')
    try { await codeSave(draft.name.trim(), lang, draft.source); setMessage(`Saved as ${draft.name.trim()}.${info?.ext ?? ''} in the shared Code folder.`); setFiles(await codeFiles()) } catch (e) { setError(errorText(e, 'Couldn’t save')) }
  }
  async function open(f: CodeFile) {
    setError('')
    try {
      const source = await codeLoad(f.name, f.language)
      setDrafts(d => ({ ...d, [f.language]: { name: f.name, source, input: d[f.language]?.input ?? '' } }))
      setLang(f.language); setLive(null)
    } catch (e) { setError(errorText(e, 'Couldn’t open it')) }
  }

  // A program picked in search.
  const requested = useStore(openCodeRequest)
  useEffect(() => { if (requested) { openCodeRequest.set(null); void open(requested) } }, [requested])

  // ⌘/Ctrl+Enter runs, ⌘/Ctrl+S saves.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'Enter') { e.preventDefault(); void run() }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); void save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const problems = live ? [live.compile?.text ?? '', ...live.segments.filter(x => x.kind === 'err').map(x => x.text)].join('\n').trim() : ''
  const marked = useMemo(() => new Set(live?.file ? errorLines(problems, live.file) : []), [live?.file, problems])
  const portable = useMemo(() => (lang === 'matlab' ? octaveOnly(draft.source) : []), [lang, draft.source])
  const unportable = useMemo(() => new Set(portable.map(p => p.line)), [portable])
  const usingOctave = lang === 'matlab' && !/^MATLAB/.test(info?.version ?? '')
  /** An Octave package the program needs and doesn't have (the runner names it). */
  const missingPackage = /Octave's (\w+) package/.exec(problems)?.[1] ?? ''
  async function installPackage(name: string) {
    setInstalling(name); setError(''); setMessage('')
    try { setMessage(await codeOctaveInstall(name)) } catch (e) { setError(errorText(e, `Couldn’t install the ${name} package`)) } finally { setInstalling('') }
  }
  function matlabOnline() {
    void navigator.clipboard.writeText(draft.source).catch(() => undefined)
    openTab({ kind: 'web', title: 'MATLAB Online', params: { page: 'matlab-online', url: 'https://matlab.mathworks.com/', title: 'MATLAB Online' } })
    setMessage('Your program is copied: in MATLAB Online make a new script and paste it (your school’s MATLAB licence usually includes MATLAB Online, with Simulink and the toolboxes).')
  }
  const lineCount = draft.source.split('\n').length
  const tokens = useMemo(() => highlight(draft.source, lang), [draft.source, lang])

  const goTo = (line: number) => {
    const t = area.current
    if (!t) return
    const lines = draft.source.split('\n')
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    t.focus()
    t.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
    t.scrollTop = Math.max(0, (line - 4) * 20)
  }

  /** Tab indents (Shift+Tab outdents) the line or the selected lines; Enter keeps the indent. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget
    const { selectionStart: a, selectionEnd: b, value } = t
    const put = (text: string, from: number, to: number, select: [number, number]) => {
      const next = value.slice(0, from) + text + value.slice(to)
      edit({ source: next })
      requestAnimationFrame(() => { t.selectionStart = select[0]; t.selectionEnd = select[1] })
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const unit = indentUnit(lang)
      const lineStart = value.lastIndexOf('\n', a - 1) + 1
      if (a === b && !e.shiftKey) return put(unit, a, b, [a + unit.length, a + unit.length])
      const lines = value.slice(lineStart, b).split('\n')
      const outdent = new RegExp(`^(\\t| {1,${unit === '\t' ? 4 : unit.length}})`)
      const next = lines.map(l => (e.shiftKey ? l.replace(outdent, '') : unit + l))
      const shift = next[0].length - lines[0].length
      const text = next.join('\n')
      return put(text, lineStart, b, a === b ? [Math.max(lineStart, a + shift), Math.max(lineStart, a + shift)] : [lineStart, lineStart + text.length])
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      const text = newLine(value.slice(0, a), lang)
      return put(text, a, b, [a + text.length, a + text.length])
    }
  }

  const sync = () => {
    const t = area.current
    if (!t) return
    if (shown.current) { shown.current.scrollTop = t.scrollTop; shown.current.scrollLeft = t.scrollLeft }
    if (gutter.current) gutter.current.scrollTop = t.scrollTop
  }

  const end = live?.exit
  const status = !live || !end ? null
    : live.compile && !live.compile.ok ? { ok: false, text: 'Didn’t compile' }
      : end.timedOut ? { ok: false, text: `Stopped after the time limit` }
        : end.ok ? { ok: true, text: `Ran in ${end.ms} ms${live.compile ? ` (built in ${live.compile.ms} ms)` : ''}` }
          : end.exitCode === null ? { ok: false, text: end.text || 'Stopped' }
            : { ok: false, text: `Exited with code ${end.exitCode}` }
  const failed = status !== null && !status.ok && !end?.timedOut && problems !== ''

  function ask() {
    const name = info?.name ?? lang
    void askMimir(`My ${name} program ${live?.compile && !live.compile.ok ? 'doesn’t compile' : 'fails when it runs'}. Point at the line that's wrong and explain the mistake in plain words, as a hint. Don't rewrite the program; I'll fix it myself.\n\n\`\`\`${lang}\n${draft.source}\n\`\`\`\n\nThe error:\n\`\`\`\n${problems.slice(-4000)}\n\`\`\``)
  }

  return <div className="code-page">
    <div className="code-bar">
      <Code2 size={16} />
      <input className="code-name" value={draft.name} onChange={e => edit({ name: e.target.value })} aria-label="Program name" />
      <select value={lang} onChange={e => { setLang(e.target.value); setLive(null); setError('') }} aria-label="Language">
        {(langs.length ? langs : Object.keys(STARTERS).map(id => ({ id, name: id, available: true }) as CodeLanguage)).map(l => <option key={l.id} value={l.id}>{l.name}{l.available ? '' : ' (not installed)'}</option>)}
      </select>
      {running
        ? <button className="danger" onClick={stop} disabled={!live} title="Stop the program"><Square size={13} /> Stop</button>
        : <button className="primary" onClick={() => void run()} disabled={!isTauri() || info?.available === false} title={`Run (${MOD} Enter)`}><Play size={14} /> Run</button>}
      <select value={limit} onChange={e => setLimit(Number(e.target.value))} title="Time limit: a program still running after this is stopped">
        {LIMITS.map(s => <option key={s} value={s}>{s === 0 ? 'No limit' : s >= 60 ? `${s / 60} min limit` : `${s} s limit`}</option>)}
      </select>
      <button className="ghost" onClick={() => void save()} disabled={!isTauri()} title={`Save in the shared Code folder (${MOD} S)`}><Save size={14} /> Save</button>
      <details className="logic-open code-open">
        <summary className="ghost"><FolderOpen size={14} /> Open</summary>
        <div className="logic-files">
          {files.length ? files.map(f => <div key={`${f.name}.${f.language}`} className="logic-file">
            <button onClick={e => { void open(f); (e.currentTarget.closest('details') as HTMLDetailsElement).open = false }}><span>{f.name}</span><small>{langs.find(l => l.id === f.language)?.name ?? f.language}</small></button>
            <button className="ghost" title="Delete" onClick={() => { if (window.confirm(`Delete ${f.name}?`)) void codeDelete(f.name, f.language).then(codeFiles).then(setFiles).catch(e => setError(errorText(e, 'Couldn’t delete'))) }}><Trash2 size={12} /></button>
          </div>) : <p className="hint">No saved programs yet.</p>}
        </div>
      </details>
      <button className="ghost" onClick={() => { if (draft.source === (STARTERS[lang] ?? '') || window.confirm('Start over with the example program? (Save first to keep this one.)')) { edit({ name: 'Untitled', source: STARTERS[lang] ?? '' }); setLive(null) } }}><FilePlus size={14} /> New</button>
      <span className="grow" />
      {lang === 'matlab' && <button className="ghost" onClick={matlabOnline} title="Open MATLAB Online (Simulink and every toolbox) with this program copied, ready to paste"><ExternalLink size={13} /> MATLAB Online</button>}
      {info && <span className="code-version" title={info.version}>{info.available ? info.version : 'Not installed'}</span>}
    </div>
    {info && !info.available && <div className="code-missing">
      <AlertTriangle size={14} />
      <span><strong>{info.name} isn’t installed on this computer.</strong> {info.install}</span>
      <button className="ghost" disabled={checking} onClick={() => { setChecking(true); void codeLanguages(true).then(setLangs).finally(() => setChecking(false)) }}><RefreshCw size={13} className={checking ? 'spin' : undefined} /> Check again</button>
    </div>}
    {(message || error) && <p className={error ? 'error-text code-msg' : 'hint code-msg'}>{error || message}</p>}
    {portable.length > 0 && <details className="code-portable">
      <summary><ShieldCheck size={14} /> {portable.length} thing{portable.length === 1 ? '' : 's'} {usingOctave ? 'Octave accepts but' : ''} real MATLAB won’t accept <small>(so it runs where it’s graded)</small></summary>
      <ul>{portable.map((p, i) => <li key={i}><button className="ghost" onClick={() => goTo(p.line)}>Line {p.line}</button><code>{p.found}</code><span>{p.fix}</span></li>)}</ul>
    </details>}
    <div className="code-main">
      <div className="code-editor">
        <div className="code-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => <div key={i} className={marked.has(i + 1) ? 'bad' : unportable.has(i + 1) ? 'warn' : undefined} onClick={() => goTo(i + 1)}>{i + 1}</div>)}
        </div>
        <div className="code-text">
          <pre ref={shown} className="code-shown" aria-hidden="true">{tokens.map((t, i) => (t.kind ? <span key={i} className={`tok-${t.kind}`}>{t.text}</span> : t.text))}{'\n'}</pre>
          <textarea ref={area} value={draft.source} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Program"
            onChange={e => edit({ source: e.target.value })} onKeyDown={onKeyDown} onScroll={sync} />
        </div>
      </div>
      <aside className="code-side">
        <div className="code-side-tabs" role="tablist">
          <button role="tab" aria-selected={side === 'input'} className={side === 'input' ? 'on' : ''} onClick={() => setSide('input')}>Input</button>
          <button role="tab" aria-selected={side === 'tests'} className={side === 'tests' ? 'on' : ''} onClick={() => setSide('tests')}><FlaskConical size={13} /> Tests{tests.length ? ` (${results.length && !testing ? `${passed}/${tests.length}` : tests.length})` : ''}</button>
        </div>
        {side === 'input' ? <label className="code-input">
          <span>Input <small>given at the start (or type answers below while it runs)</small></span>
          <textarea value={draft.input} onChange={e => edit({ input: e.target.value })} spellCheck={false} placeholder="Optional: answers to give the program up front, one per line" />
        </label> : <div className="code-tests">
          {!tests.length && <p className="hint">A test gives the program some input and says what it should print. Run them all to check the program still works after a change, like an autograder.</p>}
          {tests.map((t, i) => { const r = results[i]; return <div key={i} className={`code-test${r ? ` code-test--${r.state}` : ''}`}>
            <div className="code-test__head">
              <strong>Test {i + 1}</strong>
              {r && <em>{r.state === 'running' ? <Loader2 size={12} className="spin" /> : r.state === 'pass' ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {r.state === 'running' ? 'Running…' : r.state === 'pass' ? `Passed (${r.ms} ms)` : r.state === 'fail' ? 'Different output' : 'Didn’t run'}</em>}
              <span className="grow" />
              <button className="ghost" title="Remove this test" onClick={() => setTests(tests.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
            </div>
            <div className="code-test__io">
              <label><small>Input</small><textarea value={t.input} spellCheck={false} onChange={e => setTests(tests.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))} placeholder="(none)" /></label>
              <label><small>Should print</small><textarea value={t.expected} spellCheck={false} onChange={e => setTests(tests.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))} /></label>
            </div>
            {r && (r.state === 'fail' || r.state === 'error') && <div className="code-test__got"><small>{r.state === 'fail' ? 'It printed' : 'What happened'}</small><pre>{r.got || '(nothing)'}</pre>
              {r.state === 'fail' && <button className="ghost" onClick={() => setTests(tests.map((x, j) => (j === i ? { ...x, expected: r.got } : x)))} title="If this output is actually right">Use this as the expected output</button>}</div>}
          </div> })}
          <div className="code-tests__actions">
            <button className="ghost" onClick={() => setTests([...tests, { input: '', expected: '' }])}><Plus size={13} /> Add a test</button>
            <button className="primary" disabled={!tests.length || testing || !isTauri() || info?.available === false} onClick={() => void runTests()}>{testing ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Run all tests</button>
          </div>
          {results.length > 0 && !testing && <p className={passed === tests.length ? 'code-tests__sum ok' : 'code-tests__sum bad'}>{passed === tests.length ? `All ${tests.length} passed.` : `${passed} of ${tests.length} passed.`}</p>}
        </div>}
        <div className="code-output">
          <div className="code-output__head">
            <span>Output</span>
            {running ? <em><Loader2 size={13} className="spin" /> Running…</em>
              : status && <em className={status.ok ? 'ok' : 'bad'}>{status.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {status.text}</em>}
          </div>
          {!live && !running && <p className="hint">Press Run ({MOD} Enter). Your program is built and run on this computer{info?.version ? ` with ${info.version}` : ''}. When it asks for input, type the answer below and press Enter.</p>}
          {starting && !live && <p className="hint">Starting…</p>}
          {live && <div className="code-term" ref={term}>
            {live.compile && live.compile.text && <pre className={live.compile.ok ? 'code-stderr code-stderr--soft' : 'code-stderr'}>{live.compile.text}</pre>}
            {live.segments.length > 0 && <pre className="code-stdout">{live.segments.map((x, i) => <span key={i} className={`code-seg code-seg--${x.kind}`}>{x.text}</span>)}</pre>}
            {live.exit && !live.segments.length && !live.compile?.text && <p className="hint">(No output.)</p>}
            {live.exit && live.exit.workspace?.length > 0 && <details className="code-workspace" open>
              <summary>Workspace <small>{live.exit.workspace.length} variable{live.exit.workspace.length === 1 ? '' : 's'}</small></summary>
              <table><thead><tr><th>Name</th><th>Size</th><th>Class</th><th>Value</th></tr></thead>
                <tbody>{live.exit.workspace.map(v => <tr key={v.name}><td>{v.name}</td><td>{v.size}</td><td>{v.class}</td><td title={v.value}>{v.value}</td></tr>)}</tbody></table>
            </details>}
            {live.exit && live.exit.images.length > 0 && <div className="code-plots">
              {live.exit.images.map((src, i) => <img key={i} src={`data:image/png;base64,${src}`} alt={`Figure ${i + 1}`} />)}
            </div>}
          </div>}
          {live && !live.exit && !inputClosed && <form className="code-typein" onSubmit={e => { e.preventDefault(); send() }}>
            <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type input for the program, then Enter" aria-label="Input for the running program" autoFocus />
            <button type="submit" className="ghost" title="Send this line"><CornerDownLeft size={13} /></button>
            <button type="button" className="ghost" onClick={() => send(true)} title="Tell the program there's no more input (end of file)">End input</button>
          </form>}
          {(marked.size > 0 || failed || missingPackage) && <div className="code-jump">
            {marked.size > 0 && <>Go to line {[...marked].map(n => <button key={n} onClick={() => goTo(n)}>{n}</button>)}</>}
            <span className="grow" />
            {missingPackage && <button className="ghost code-ask" disabled={!!installing} onClick={() => void installPackage(missingPackage)} title="Downloads it from Octave Forge (a few minutes)">{installing ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {installing ? `Installing ${installing}…` : `Install the ${missingPackage} package`}</button>}
            {failed && <button className="ghost code-ask" onClick={ask} title="Mimir explains the error and suggests a fix"><Sparkles size={13} /> Ask Mimir about this error</button>}
          </div>}
        </div>
      </aside>
    </div>
  </div>
}
