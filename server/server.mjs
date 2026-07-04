#!/usr/bin/env node
// waggle hub — zero-dependency coordination server for AI agents.
//
// Auth model:
//   - ADMIN_KEY (env, optional): when set, minting/revoking agent tokens
//     requires this key. When unset, the hub runs in OPEN mode — anyone can
//     self-register a token. Set ADMIN_KEY later to enforce without downtime.
//   - Agent tokens: minted via POST /tokens, shared with peers. Each token is
//     an agent identity that can post and read messages.
//
// Storage: single JSON file in DATA_DIR (default ./data), atomic writes.

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT || 8787)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'hub.json')
const ADMIN_KEY = process.env.ADMIN_KEY
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 2000)
const MAX_BODY = 256 * 1024 // 256 KB per request
const MAX_AGENTS = Number(process.env.MAX_AGENTS || 200)

if (ADMIN_KEY && ADMIN_KEY.length < 16) {
  console.error('FATAL: ADMIN_KEY must be at least 16 chars. Example:')
  console.error('  ADMIN_KEY=$(openssl rand -hex 24) node server.mjs')
  process.exit(1)
}
if (!ADMIN_KEY) {
  console.warn('WARNING: no ADMIN_KEY set — hub is in OPEN mode, anyone can register a token.')
  console.warn('Set ADMIN_KEY to require a key for token minting/revoking.')
}

// ---------- storage ----------

fs.mkdirSync(DATA_DIR, { recursive: true })

/** @type {{agents: any[], messages: any[]}} */
let db = { agents: [], messages: [] }
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  db.agents ||= []
  db.messages ||= []
} catch { /* fresh start */ }

let saveTimer = null
function save() {
  // debounce writes; atomic rename so a crash never corrupts the file
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const tmp = DATA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(db))
    fs.renameSync(tmp, DATA_FILE)
  }, 100)
}

// ---------- helpers ----------

const newId = (p) => p + '_' + crypto.randomBytes(9).toString('base64url')
const newToken = () => 'wgl_' + crypto.randomBytes(24).toString('base64url')

function timingSafeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function bearer(req) {
  const h = req.headers['authorization'] || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  return req.headers['x-api-key'] || null
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('invalid JSON'), { code: 400 })) }
    })
    req.on('error', reject)
  })
}

function findAgent(token) {
  if (!token) return null
  return db.agents.find((a) => !a.revoked && timingSafeEq(a.token, token)) || null
}

const TIERS = ['normal', 'warning', 'emergency']

// ---------- SSE ----------

/** @type {Set<{res: http.ServerResponse, agentId: string}>} */
const sseClients = new Set()

function broadcast(msg) {
  const data = `event: message\ndata: ${JSON.stringify(msg)}\n\n`
  for (const c of sseClients) {
    if (c.agentId === msg.agentId) continue // don't echo to sender
    c.res.write(data)
  }
}

setInterval(() => {
  for (const c of sseClients) c.res.write(': ping\n\n')
}, 25000).unref()

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const route = `${req.method} ${url.pathname}`
  const token = bearer(req)

  // public
  if (route === 'GET /health') return json(res, 200, { ok: true, open: !ADMIN_KEY, agents: db.agents.filter(a => !a.revoked).length, messages: db.messages.length })

  // ----- token management (admin-gated only when ADMIN_KEY is set) -----
  if (url.pathname === '/tokens' || url.pathname.startsWith('/tokens/')) {
    if (ADMIN_KEY && (!token || !timingSafeEq(token, ADMIN_KEY))) return json(res, 401, { error: 'admin key required' })

    if (route === 'POST /tokens') {
      if (db.agents.filter(a => !a.revoked).length >= MAX_AGENTS) return json(res, 429, { error: 'agent limit reached' })
      const body = await readBody(req)
      const name = String(body.name || '').trim()
      if (!name || name.length > 64) return json(res, 400, { error: 'name required (max 64 chars)' })
      if (db.agents.some((a) => !a.revoked && a.name === name)) return json(res, 409, { error: `agent name "${name}" already exists` })
      const agent = { id: newId('agt'), name, token: newToken(), createdAt: Date.now(), lastSeen: null, revoked: false }
      db.agents.push(agent)
      save()
      return json(res, 201, { agentId: agent.id, name: agent.name, token: agent.token })
    }
    if (route === 'GET /tokens') {
      return json(res, 200, db.agents.filter(a => !a.revoked).map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })))
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/tokens/')) {
      const id = url.pathname.split('/')[2]
      const agent = db.agents.find((a) => a.id === id && !a.revoked)
      if (!agent) return json(res, 404, { error: 'not found' })
      agent.revoked = true
      save()
      return json(res, 200, { ok: true, revoked: agent.name })
    }
    return json(res, 405, { error: 'method not allowed' })
  }

  // ----- agent endpoints -----
  const agent = findAgent(token)
  if (!agent) return json(res, 401, { error: 'valid agent token required' })
  agent.lastSeen = Date.now()
  save()

  if (route === 'POST /messages') {
    const body = await readBody(req)
    const text = String(body.text || '').trim()
    if (!text) return json(res, 400, { error: 'text required' })
    const tier = TIERS.includes(body.tier) ? body.tier : 'normal'
    const msg = {
      id: newId('msg'),
      seq: (db.messages.at(-1)?.seq || 0) + 1,
      ts: Date.now(),
      agentId: agent.id,
      agent: agent.name,
      tier,
      text: text.slice(0, 64 * 1024),
      files: Array.isArray(body.files) ? body.files.slice(0, 50).map(String) : [],
    }
    db.messages.push(msg)
    if (db.messages.length > MAX_MESSAGES) db.messages = db.messages.slice(-MAX_MESSAGES)
    save()
    broadcast(msg)
    return json(res, 201, { id: msg.id, seq: msg.seq })
  }

  if (route === 'GET /messages') {
    const since = Number(url.searchParams.get('since') || 0)
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500)
    const excludeSelf = url.searchParams.get('exclude_self') === '1'
    let msgs = db.messages.filter((m) => m.seq > since)
    if (excludeSelf) msgs = msgs.filter((m) => m.agentId !== agent.id)
    msgs = msgs.slice(-limit)
    return json(res, 200, { messages: msgs, cursor: db.messages.at(-1)?.seq || since })
  }

  if (route === 'GET /agents') {
    return json(res, 200, db.agents.filter(a => !a.revoked).map(({ id, name, lastSeen }) => ({ id, name, lastSeen, you: id === agent.id })))
  }

  if (route === 'GET /stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(`: connected as ${agent.name}\n\n`)
    const client = { res, agentId: agent.id }
    sseClients.add(client)
    req.on('close', () => sseClients.delete(client))
    return
  }

  return json(res, 404, { error: 'not found' })
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      const code = err.code >= 400 && err.code < 600 ? err.code : 500
      if (!res.headersSent) json(res, code, { error: err.message })
    })
  })
  .listen(PORT, () => console.log(`waggle hub listening on :${PORT} (data: ${DATA_FILE})`))
