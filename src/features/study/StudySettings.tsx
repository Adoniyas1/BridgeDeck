import { useEffect, useState } from 'react'
import { Languages } from 'lucide-react'
import { isTauri, ocrLanguagesDownload, ocrLanguagesStatus } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'

/** Languages text recognition can read in scanned books, besides English (codes Tesseract uses). */
export const OCR_LANGUAGES: Array<[string, string]> = [
  ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['rus', 'Russian'],
  ['ara', 'Arabic'], ['hin', 'Hindi'], ['chi_sim', 'Chinese (simplified)'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['amh', 'Amharic'],
]

/** Settings → Study: which languages scanned book pages are read in. */
export function StudySettings() {
  const config = useConfig()
  const chosen = config.study.ocrLanguages
  const [have, setHave] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (isTauri()) void ocrLanguagesStatus().then(setHave).catch(() => undefined) }, [])

  async function toggle(code: string) {
    const next = chosen.includes(code) ? chosen.filter(c => c !== code) : [...chosen, code]
    setConfig(c => ({ ...c, study: { ...c.study, ocrLanguages: next } }))
    if (!next.includes(code) || have.includes(code) || !isTauri()) return
    setBusy(true); setError('')
    try { setHave(await ocrLanguagesDownload(next)) } catch (e) { setError(errorText(e, 'The language didn’t download')) } finally { setBusy(false) }
  }

  return <Card><SectionTitle title="Scanned books" subtitle="Languages text recognition reads, besides English" action={<Languages size={18} />} />
    <div className="ocr-languages">{OCR_LANGUAGES.map(([code, name]) => <label key={code}>
      <input type="checkbox" checked={chosen.includes(code)} disabled={busy} onChange={() => void toggle(code)} /> {name}{chosen.includes(code) && !have.includes(code) ? <small> (downloading…)</small> : null}
    </label>)}</div>
    {error && <p className="error-text">{error}</p>}
    <p className="hint">Each language is a few megabytes, downloaded once. They’re used for books indexed from now on.</p>
  </Card>
}
