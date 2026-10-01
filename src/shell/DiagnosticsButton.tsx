import { useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { diagnosticsReport } from '../lib/bridge'
import { setNotice } from '../core/notice'
import { errorText } from '../core/util'

/** Copies a report about this computer and the paired ones (no passwords, keys or message text). */
export default function DiagnosticsButton({ className = 'secondary' }: { className?: string }) {
  const [busy, setBusy] = useState(false)
  async function copy() {
    setBusy(true)
    try {
      const report = await diagnosticsReport()
      await navigator.clipboard.writeText(report)
      setNotice('Diagnostics copied. Paste them into your chat with Claude.')
    } catch (error) {
      setNotice(errorText(error, 'Could not collect diagnostics'))
    } finally {
      setBusy(false)
    }
  }
  return <button className={className} disabled={busy} onClick={() => void copy()} title="A report about both computers to paste when something isn't working (no passwords, keys or message text)">
    <ClipboardList size={16}/>{busy ? 'Collecting…' : 'Copy diagnostics'}
  </button>
}
