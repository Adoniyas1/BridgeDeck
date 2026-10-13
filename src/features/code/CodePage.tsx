import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Code2, FilePlus, FolderOpen, Loader2, Play, RefreshCw, Save, Trash2, XCircle } from 'lucide-react'
import { codeDelete, codeFiles, codeLanguages, codeLoad, codeRun, codeSave, isTauri, type CodeFile, type CodeLanguage, type CodeRun } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { errorLines, highlight, indentUnit, newLine, STARTERS } from './model'

const DRAFTS_KEY = 'bridgedeck.code.drafts'
const LANG_KEY = 'bridgedeck.code.language'
/** Each language's program as last left, so switching languages (or restarting) loses nothing. */
type Draft = { name: string; source: string; input: string }
const readDrafts = (): Record<string, Draft> => { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') } catch { return {} } }
const readLang = () => { try { return localStorage.getItem(LANG_KEY) ?? 'python' } catch { return 'python' } }
const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Write a program in C, Python, MATLAB and more, and run it with the compilers on this computer. */
export default function CodePage({ active }: { active: boolean }) {
  const [langs, setLangs] = useState<CodeLanguage[]>([])
  const [lang, setLang] = useState(readLang)
  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts)
  const draft: Draft = drafts[lang] ?? { name: 'Untitled', source: STARTERS[lang] ?? '', input: '' }
  const [result, setResult] = useState<CodeRun | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [limit, setLimit] = useState(10)
  const [files, setFiles] = useState<CodeFile[]>([])
  const [checking, setChecking] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const shown = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const info = langs.find(l => l.id === lang)

  useEffect(() => { if (isTauri()) void codeLanguages().then(setLangs).catch(() => undefined) }, [])
  useEffect(() => { if (active && isTauri()) void codeFiles().then(setFiles).catch(() => undefined) }, [active])
  useEffect(() => { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); localStorage.setItem(LANG_KEY, lang) } catch { /* this run only */ } }, [drafts, lang])

  const edit = (patch: Partial<Draft>) => setDrafts(d => ({ ...d, [lang]: { ...draft, ...patch } }))

  async function run() {
    if (running) return
    setRunning(true); setError(''); setMessage('')
    try { setResult(await codeRun(lang, draft.source, draft.input, limit)) } catch (e) { setResult(null); setError(errorText(e, 'It didn’t run')) } finally { setRunning(false) }
  }
  async function save() {
    setError('')
    try { await codeSave(draft.name.trim(), lang, draft.source); setMessage(`Saved as ${draft.name.trim()}.${info?.ext ?? ''} in the shared Code folder.`); setFiles(await codeFiles()) } catch (e) { setError(errorText(e, 'Couldn’t save')) }
  }
  async function open(f: CodeFile) {
    setError('')
    try {
      const source = await codeLoad(f.name, f.language)
      setDrafts(d => ({ ...d, [f.language]: { name: f.name, source, input: d[f.language]?.input ?? '' } }))
      setLang(f.language); setResult(null)
    } catch (e) { setError(errorText(e, 'Couldn’t open it')) }
  }

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

  const output = result ? [result.compile?.stdout, result.compile?.stderr, result.run?.stderr].filter(Boolean).join('\n') : ''
  const marked = useMemo(() => new Set(result ? errorLines(output, result.file) : []), [result, output])
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

  const status = !result ? null
    : result.compile && !result.compile.ok ? { ok: false, text: 'Didn’t compile' }
      : result.run?.timedOut ? { ok: false, text: `Stopped after ${limit} s` }
        : result.run?.ok ? { ok: true, text: `Ran in ${result.run.ms} ms${result.compile ? ` (built in ${result.compile.ms} ms)` : ''}` }
          : { ok: false, text: `Exited with code ${result.run?.exitCode ?? '?'}` }

  return <div className="code-page">
    <div className="code-bar">
      <Code2 size={16} />
      <input className="code-name" value={draft.name} onChange={e => edit({ name: e.target.value })} aria-label="Program name" />
      <select value={lang} onChange={e => { setLang(e.target.value); setResult(null); setError('') }} aria-label="Language">
        {(langs.length ? langs : Object.keys(STARTERS).map(id => ({ id, name: id, available: true }) as CodeLanguage)).map(l => <option key={l.id} value={l.id}>{l.name}{l.available ? '' : ' (not installed)'}</option>)}
      </select>
      <button className="primary" onClick={() => void run()} disabled={running || !isTauri() || info?.available === false} title={`Run (${MOD} Enter)`}>
        {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Run
      </button>
      <select value={limit} onChange={e => setLimit(Number(e.target.value))} title="Time limit: a program still running after this is stopped">
        {[5, 10, 30, 60, 120].map(s => <option key={s} value={s}>{s} s limit</option>)}
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
      <button className="ghost" onClick={() => { if (draft.source === (STARTERS[lang] ?? '') || window.confirm('Start over with the example program? (Save first to keep this one.)')) { edit({ name: 'Untitled', source: STARTERS[lang] ?? '' }); setResult(null) } }}><FilePlus size={14} /> New</button>
      <span className="grow" />
      {info && <span className="code-version" title={info.version}>{info.available ? info.version : 'Not installed'}</span>}
    </div>
    {info && !info.available && <div className="code-missing">
      <AlertTriangle size={14} />
      <span><strong>{info.name} isn’t installed on this computer.</strong> {info.install}</span>
      <button className="ghost" disabled={checking} onClick={() => { setChecking(true); void codeLanguages(true).then(setLangs).finally(() => setChecking(false)) }}><RefreshCw size={13} className={checking ? 'spin' : undefined} /> Check again</button>
    </div>}
    {(message || error) && <p className={error ? 'error-text code-msg' : 'hint code-msg'}>{error || message}</p>}
    <div className="code-main">
      <div className="code-editor">
        <div className="code-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => <div key={i} className={marked.has(i + 1) ? 'bad' : undefined} onClick={() => goTo(i + 1)}>{i + 1}</div>)}
        </div>
        <div className="code-text">
          <pre ref={shown} className="code-shown" aria-hidden="true">{tokens.map((t, i) => (t.kind ? <span key={i} className={`tok-${t.kind}`}>{t.text}</span> : t.text))}{'\n'}</pre>
          <textarea ref={area} value={draft.source} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Program"
            onChange={e => edit({ source: e.target.value })} onKeyDown={onKeyDown} onScroll={sync} />
        </div>
      </div>
      <aside className="code-side">
        <label className="code-input">
          <span>Input <small>what the program reads (scanf, input(), cin…)</small></span>
          <textarea value={draft.input} onChange={e => edit({ input: e.target.value })} spellCheck={false} placeholder="Type the program’s input here, one line per answer" />
        </label>
        <div className="code-output">
          <div className="code-output__head">
            <span>Output</span>
            {running ? <em><Loader2 size={13} className="spin" /> Running…</em>
              : status && <em className={status.ok ? 'ok' : 'bad'}>{status.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {status.text}</em>}
          </div>
          {!result && !running && <p className="hint">Press Run ({MOD} Enter). Your program is built and run on this computer{info?.version ? ` with ${info.version}` : ''}.</p>}
          {result && <>
            {result.run?.stdout && <pre className="code-stdout">{result.run.stdout}</pre>}
            {output && <pre className="code-stderr">{output}</pre>}
            {result.run && !result.run.stdout && !output && <p className="hint">(No output.)</p>}
            {marked.size > 0 && <div className="code-jump">Go to line {[...marked].map(n => <button key={n} onClick={() => goTo(n)}>{n}</button>)}</div>}
          </>}
        </div>
      </aside>
    </div>
  </div>
}
