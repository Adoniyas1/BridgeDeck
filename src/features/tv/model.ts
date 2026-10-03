/** Streaming services offered on the TV tab. They open inside BridgeDeck like any website; the
 *  person signs in with their own account. Free ones need no account. */
export type Service = { name: string; url: string; color: string; free: boolean }

export const SERVICES: Service[] = [
  { name: 'YouTube', url: 'https://www.youtube.com/', color: '#ff0033', free: true },
  { name: 'Tubi', url: 'https://tubitv.com/', color: '#7408ff', free: true },
  { name: 'Pluto TV', url: 'https://pluto.tv/', color: '#2c2c2c', free: true },
  { name: 'The Roku Channel', url: 'https://therokuchannel.roku.com/', color: '#6c3c97', free: true },
  { name: 'PBS', url: 'https://www.pbs.org/video/', color: '#2638c4', free: true },
  { name: 'Internet Archive films', url: 'https://archive.org/details/movies', color: '#4a4a4a', free: true },
  { name: 'Netflix', url: 'https://www.netflix.com/', color: '#e50914', free: false },
  { name: 'Prime Video', url: 'https://www.primevideo.com/', color: '#00a8e1', free: false },
  { name: 'Disney+', url: 'https://www.disneyplus.com/', color: '#113ccf', free: false },
  { name: 'Hulu', url: 'https://www.hulu.com/', color: '#1ce783', free: false },
  { name: 'Max', url: 'https://play.max.com/', color: '#002be7', free: false },
  { name: 'Apple TV+', url: 'https://tv.apple.com/', color: '#1d1d1f', free: false },
  { name: 'Paramount+', url: 'https://www.paramountplus.com/', color: '#0064ff', free: false },
  { name: 'Peacock', url: 'https://www.peacocktv.com/', color: '#000000', free: false },
  { name: 'Crunchyroll', url: 'https://www.crunchyroll.com/', color: '#f47521', free: false },
]

/** A typed shortcut address as a web address (adds https:// to a bare domain), or null. */
export function shortcutUrl(input: string): string | null {
  const text = input.trim()
  if (!text || /\s/.test(text)) return null
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(withScheme)
    return url.hostname.includes('.') ? url.href : null
  } catch { return null }
}

/** A name for a shortcut from its address when none is given: the site's name. */
export function shortcutName(url: string) {
  const host = new URL(url).hostname.replace(/^www\./, '')
  const name = host.split('.').slice(-2, -1)[0] ?? host
  return name.charAt(0).toUpperCase() + name.slice(1)
}
