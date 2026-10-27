export const fmtBytes = (value?: number) => value ? `${(value / 1024 ** 3).toFixed(1)} GB` : '—'
export const fmtUptime = (value?: number) => value ? `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m` : '—'
export const fmtSize = (value = 0) => value < 1000 ? `${value} B` : value < 1_000_000 ? `${(value / 1000).toFixed(1)} KB` : value < 1_000_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${(value / 1_000_000_000).toFixed(2)} GB`
export const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
export const agentUrlFor = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`

/** True when `saved` points at a private LAN IPv4 on the same port as `current` but another host, i.e. the
 *  peer moved to a new DHCP address. Hand-entered hostnames and other ports are left alone. */
export const isStaleLanUrl = (saved: string, current: string) => {
  try {
    const a = new URL(saved), b = new URL(current)
    return a.port === b.port && a.hostname !== b.hostname && /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(a.hostname)
  } catch { return false }
}

/** Native (Tauri) command errors arrive as plain strings, not Error objects. */
export const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === 'string' && error ? error : fallback

export const platformLabel = (platform: string) =>
  ({ macos: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', ipados: 'iPadOS', android: 'Android' } as Record<string, string>)[platform.toLowerCase()] || platform || 'Unknown'

/** A one-row toolbar that scrolls sideways: a mouse's up/down wheel scrolls it too (a trackpad
 *  already swipes it). */
export function scrollSideways(e: { deltaX: number; deltaY: number; currentTarget: HTMLElement }) {
  const el = e.currentTarget
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY
}
