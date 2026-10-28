import { useState } from 'react'
import { CheckCircle2, CircleHelp, Loader2, RefreshCw, Stethoscope, X, XCircle } from 'lucide-react'
import { arduinoCompile, codeLanguages, codeRun, isTauri, type CodeLanguage } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { judgeSelfTest, SELF_TESTS, type SelfTest } from './model'

const RESULTS_KEY = 'bridgedeck.code.selftests'
const readResults = (): Record<string, SelfTest> => { try { return JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '{}') as Record<string, SelfTest> } catch { return {} } }
const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(at).toLocaleDateString() }

/** Arduino's check: the test sketch built for an Uno, then run on the simulated one, which must
 *  print the mark on Serial. */
async function testArduino(): Promise<SelfTest> {
  const built = await arduinoCompile(SELF_TESTS.arduino, 'arduino:avr:uno')
  const step = { ok: built.ok, stdout: '', stderr: built.output, ms: built.ms, timedOut: false }
  if (!built.ok || !built.hex) return judgeSelfTest({ compile: { ...step, ok: false }, run: null })
  const { Uno, CLOCK_HZ } = await import('./arduinoSim')
  const uno = new Uno(built.hex)
  let printed = ''
  uno.onSerial = t => { printed += t }
  const t = performance.now()
  uno.run(CLOCK_HZ * 0.3)
  return judgeSelfTest({ compile: step, run: { ok: true, stdout: printed, stderr: '', ms: Math.round(performance.now() - t), timedOut: false } })
}

/** Every language: whether its compiler is on this computer (where, which version), and a test that
 *  builds and runs a tiny program through the same path as Run, so "works" means Run will work. */
export function CompilersPanel({ langs, onLangs, onClose }: { langs: CodeLanguage[]; onLangs: (l: CodeLanguage[]) => void; onClose: () => void }) {
  const [results, setResults] = useState(readResults)
  const [testing, setTesting] = useState<string[]>([])
  const [looking, setLooking] = useState(false)
  const keep = (id: string, r: SelfTest) => setResults(all => { const next = { ...all, [id]: r }; try { localStorage.setItem(RESULTS_KEY, JSON.stringify(next)) } catch { /* this run only */ } return next })

  async function test(id: string) {
    setTesting(t => [...t, id])
    try { keep(id, id === 'arduino' ? await testArduino() : judgeSelfTest(await codeRun(id, SELF_TESTS[id], '', 60))) }
    catch (e) { keep(id, { ok: false, ms: 0, at: Date.now(), detail: errorText(e, 'Couldn’t start it') }) }
    finally { setTesting(t => t.filter(x => x !== id)) }
  }
  /** Looks for the compilers again (after installing one), then tests every one that's there. */
  async function testAll() {
    setLooking(true)
    let fresh = langs
    try { fresh = await codeLanguages(true); onLangs(fresh) } catch { /* keep the old list */ } finally { setLooking(false) }
    for (const l of fresh.filter(x => x.available && SELF_TESTS[x.id])) await test(l.id)
  }

  const installed = langs.filter(l => l.available)
  const working = installed.filter(l => results[l.id]?.ok).length
  return <div className="code-compilers">
    <div className="code-compilers-head">
      <Stethoscope size={15} />
      <strong>Compilers</strong>
      <small>{installed.length} of {langs.length} installed{Object.keys(results).length ? ` · ${working} tested working` : ''}</small>
      <span className="grow" />
      <button className="ghost" disabled={!isTauri() || looking || testing.length > 0} title="Look for them again (after installing one) and build and run a test program in each" onClick={() => void testAll()}>
        {looking || testing.length ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Check all</button>
      <button className="ghost" title="Close" onClick={onClose}><X size={13} /></button>
    </div>
    <div className="code-compilers-list">{langs.map(l => {
      const r = results[l.id]
      const busy = testing.includes(l.id)
      const state = !l.available ? 'missing' : busy ? 'busy' : !r ? 'untested' : r.ok ? 'ok' : 'bad'
      return <div key={l.id} className={`code-compiler ${state}`}>
        {state === 'ok' ? <CheckCircle2 size={14} /> : state === 'bad' || state === 'missing' ? <XCircle size={14} /> : state === 'busy' ? <Loader2 size={14} className="spin" /> : <CircleHelp size={14} />}
        <span className="code-compiler-name">{l.name}</span>
        <span className="grow code-compiler-what">
          {l.available
            ? <>{l.version || 'Installed'}{l.paths.length > 0 && <small title={l.paths.join('\n')}>{l.paths.join(' + ')}</small>}</>
            : <>Not installed. <small>{l.install}</small></>}
          {r && l.available && <small className={r.ok ? 'ok' : 'bad'}>{r.detail} · {ago(r.at)}</small>}
        </span>
        {l.available && <button className="ghost" disabled={!isTauri() || busy} onClick={() => void test(l.id)}>{busy ? 'Testing…' : 'Test'}</button>}
      </div>
    })}</div>
  </div>
}
