import { useState } from 'react'
import { Bug } from 'lucide-react'
import { openPath, problemReport } from '../lib/bridge'
import { tabsStore } from '../core/tabs'
import { features } from '../features/registry'
import { Card, SectionTitle } from '../ui'
import { errorText } from '../core/util'

/** The tabs in use, most recent first, as words for the report. */
function tabsInUse() {
  const { active, split, history, dynamic } = tabsStore.get()
  const name = (id: string) => features.find(f => f.id === id)?.title ?? dynamic.find(t => t.id === id)?.title ?? id
  return [`On screen: ${name(active)}${split ? ` (beside ${name(split)})` : ''}`, `Recently: ${history.slice(0, 6).map(name).join(', ')}`, dynamic.length ? `Open tabs: ${dynamic.map(t => `${t.title} (${t.kind})`).join(', ')}` : ''].filter(Boolean).join('\n')
}

/** "Report a problem": what went wrong, in your words, with everything that helps find it, saved as
 *  one file in Downloads and copied, ready to paste to Claude (src-tauri diagnostics.rs). */
export function ProblemReport() {
  const [what, setWhat] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ path: string } | null>(null)
  const [error, setError] = useState('')
  async function make() {
    setBusy(true); setError(''); setDone(null)
    try {
      const report = await problemReport(what, tabsInUse())
      await navigator.clipboard.writeText(report.text).catch(() => undefined)
      setDone({ path: report.path })
    } catch (e) { setError(errorText(e, 'Couldn’t make the report')) } finally { setBusy(false) }
  }
  return <Card><SectionTitle title="Report a problem" subtitle="Everything that helps find it, in one file to paste to Claude" action={<Bug size={18} />} />
    <textarea className="problem-what" rows={3} value={what} onChange={e => setWhat(e.target.value)} placeholder="What went wrong? What were you doing, and what did you expect?" />
    <div className="actions"><button disabled={busy} onClick={() => void make()}><Bug size={15} />{busy ? 'Collecting…' : 'Make the report'}</button>
      {done && <button className="secondary" onClick={() => void openPath(done.path)}>Open it</button>}</div>
    <p className="hint">{done ? `Saved as ${done.path} and copied: paste it into your chat with Claude.` : 'It has this computer’s and your other computer’s status, recent errors, the tabs you were in, and Mimir’s checkup and last few questions. No passwords, keys or message text.'}</p>
    {error && <p className="notes-error">{error}</p>}
  </Card>
}
