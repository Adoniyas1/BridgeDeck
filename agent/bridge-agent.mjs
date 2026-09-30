#!/usr/bin/env node
import http from 'node:http'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'

const host = process.env.BRIDGE_AGENT_HOST || '127.0.0.1'
const port = Number(process.env.BRIDGE_AGENT_PORT || 4141)
const allowOrigin = process.env.BRIDGE_AGENT_ALLOW_ORIGIN || '*'
const token = process.env.BRIDGE_AGENT_TOKEN || ''
const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'

if (!isLoopback && !token) {
  console.error('Refusing to bind Bridge Agent to a non-loopback address without BRIDGE_AGENT_TOKEN.')
  console.error('Generate one with: node agent/generate-token.mjs')
  process.exit(2)
}

function isAuthorized(req) {
  if (isLoopback && !token) return true
  const auth = req.headers.authorization || ''
  const expected = `Bearer ${token}`
  if (auth.length !== expected.length) return false
  try { return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected)) } catch { return false }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function probe(targetHost, targetPort) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: targetHost, port: targetPort })
    let settled = false
    const done = (ok, error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, error })
    }
    socket.setTimeout(900)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false, 'timeout'))
    socket.once('error', err => done(false, err.code || err.message))
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    })
    return res.end()
  }

  if (!isAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })

  if (req.method === 'GET' && req.url === '/status') {
    return json(res, 200, {
      ok: true,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      loadAverage: os.loadavg(),
      timestamp: new Date().toISOString(),
    })
  }

  if (req.method === 'GET' && req.url === '/services') {
    const checks = await Promise.all([
      ['syncthing', 8384],
    ].map(async ([id, servicePort]) => [id, await probe('127.0.0.1', Number(servicePort))]))
    return json(res, 200, { ok: true, services: Object.fromEntries(checks) })
  }

  if (req.method === 'GET' && req.url?.startsWith('/probe?')) {
    const u = new URL(req.url, `http://${host}:${port}`)
    const targetHost = u.searchParams.get('host') || '127.0.0.1'
    const targetPort = Number(u.searchParams.get('port') || 0)
    if (!targetPort) return json(res, 400, { ok: false, error: 'port is required' })
    if (!['127.0.0.1', 'localhost', '::1'].includes(targetHost)) {
      return json(res, 400, { ok: false, error: 'probe is limited to localhost targets' })
    }
    return json(res, 200, await probe(targetHost, targetPort))
  }

  json(res, 404, { ok: false, error: 'not found' })
})

server.listen(port, host, () => {
  console.log(`Bridge Agent listening on http://${host}:${port}`)
  console.log(isLoopback && !token ? 'Localhost mode: no token required.' : 'Authenticated mode: bearer token required.')
  console.log('Read-only by design: /status, /services, and localhost-only /probe.')
})
