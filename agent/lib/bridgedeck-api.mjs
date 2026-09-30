// Shared client for BridgeDeck's loopback API (used by ai-relay.mjs and bridgedeck-mcp.mjs).
// Only talks to 127.0.0.1; BridgeDeck carries messages to paired devices over its encrypted link.
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const port = Number(process.env.BRIDGEDECK_API_PORT || 41416)

export function tokenCandidates() {
  if (process.env.BRIDGEDECK_AI_TOKEN_FILE) return [process.env.BRIDGEDECK_AI_TOKEN_FILE]
  const home = os.homedir()
  const rel = join('dev.bridgedeck.app', 'bridgelink', 'ai-token')
  if (process.platform === 'win32') return [join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), rel)]
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', rel)]
  return [join(process.env.XDG_CONFIG_HOME || join(home, '.config'), rel)]
}

export function loadToken() {
  if (process.env.BRIDGEDECK_AI_TOKEN) return process.env.BRIDGEDECK_AI_TOKEN.trim()
  for (const path of tokenCandidates()) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  }
  throw new Error(`BridgeDeck AI token not found (looked in ${tokenCandidates().join(', ')}). Start BridgeDeck, or set BRIDGEDECK_AI_TOKEN_FILE.`)
}

/** One request to local BridgeDeck. Resolves with the JSON answer; rejects with BridgeDeck's error text. */
export function request(method, path, body, timeoutMs = 10000) {
  const token = loadToken()
  const payload = body ? JSON.stringify(body) : ''
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path, timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let json
        try { json = JSON.parse(data) } catch { return reject(new Error(`BridgeDeck returned HTTP ${res.statusCode}: ${data}`)) }
        if (res.statusCode >= 300 || json.ok === false) return reject(new Error(json.error || `HTTP ${res.statusCode}`))
        resolve(json)
      })
    })
    req.on('timeout', () => req.destroy(new Error('BridgeDeck did not respond')))
    req.on('error', err => reject(new Error(`Cannot reach BridgeDeck on 127.0.0.1:${port} (${err.message}). Is BridgeDeck running?`)))
    req.end(payload)
  })
}

/** Query string from an object, skipping empty values. */
export const query = params => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export function formatMessage(m) {
  const when = new Date(m.createdAt).toISOString()
  const route = m.direction === 'out' ? `-> ${m.peerName}` : `<- ${m.peerName}`
  const to = m.to?.length ? ` to=${m.to.join(',')}` : ''
  const room = m.room ? ` room=${m.room}` : ''
  return `--- [${when}] ${m.author} ${route} #${m.channel}${to}${room} id=${m.id}${m.replyTo ? ` reply-to=${m.replyTo}` : ''}${m.pending ? ' (queued)' : ''}\n${m.body}`
}
