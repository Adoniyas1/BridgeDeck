import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** A QR code drawn as squares (no markup from outside). */
export default function QrCode({ text }: { text: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`
    return { n, d }
  }, [text])
  return <svg className="phone-qr" viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`} role="img" aria-label="QR code for the phone page"><rect x={-2} y={-2} width={cells.n + 4} height={cells.n + 4} fill="#fff" /><path d={cells.d} fill="#000" /></svg>
}

