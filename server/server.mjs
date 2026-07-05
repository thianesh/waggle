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
// Privacy model:
//   - Message bodies are end-to-end encrypted by clients (X25519 + AES-256-GCM);
//     the hub stores and relays ciphertext it cannot decrypt. Routing metadata
//     (sender, recipient, tier, thread id, timestamps) stays plaintext so the
//     hub can route without reading bodies.
//   - Messages live in RAM only, swept after MSG_TTL_MS (default 5 min). They
//     are never written to disk; only agent identities persist.
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
const MSG_TTL_MS = Number(process.env.MSG_TTL_MS || 5 * 60 * 1000)

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
} catch { /* fresh start */ }
// messages are ephemeral: RAM only, never loaded from or written to disk
db.messages = []

// migrate pre-hash records: tokens are stored only as sha256 digests at rest
for (const a of db.agents) {
  if (a.token) { a.tokenHash = crypto.createHash('sha256').update(a.token).digest('hex'); delete a.token }
}

let saveTimer = null
function save() {
  // debounce writes; atomic rename so a crash never corrupts the file
  // NOTE: persists agents only — messages must never touch disk
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const tmp = DATA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ agents: db.agents }))
    fs.renameSync(tmp, DATA_FILE)
  }, 100)
}

// sweep expired messages (TTL); cheap head-check since messages are ts-ordered
setInterval(() => {
  const cutoff = Date.now() - MSG_TTL_MS
  if (db.messages.length && db.messages[0].ts < cutoff) {
    db.messages = db.messages.filter((m) => m.ts >= cutoff)
  }
}, 15_000).unref()

// ---------- helpers ----------

const newId = (p) => p + '_' + crypto.randomBytes(9).toString('base64url')
// 16 random bytes = 128-bit entropy, 26-char token — short to share, infeasible to guess
const newToken = () => 'wgl_' + crypto.randomBytes(16).toString('base64url')
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')

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
  const h = hashToken(token)
  return db.agents.find((a) => !a.revoked && timingSafeEq(a.tokenHash, h)) || null
}

const TIERS = ['normal', 'warning', 'emergency']

// seq must stay monotonic across restarts (clients keep cursors); ms clock +
// bump-on-collision gives that without persisting a counter
let lastSeq = Date.now()
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()))

// X25519 public key, base64 spki-der (44 bytes → 60 chars); loose upper bound
const validPubKey = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[A-Za-z0-9+/=]+$/.test(s)

// landing page (served at GET /) — optional, hub works without it
let HOMEPAGE = null
try { HOMEPAGE = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8') } catch { /* absent */ }

// SEO: canonical origin for robots/sitemap (override with SITE_ORIGIN env)
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://waggle.solvehub.network'
const ROBOTS_TXT = `User-agent: *\nAllow: /\nDisallow: /messages\nDisallow: /tokens\nDisallow: /stream\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_ORIGIN}/</loc>
    <lastmod>2026-07-05</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`

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
  if (route === 'GET /health') return json(res, 200, { ok: true, open: !ADMIN_KEY, e2e: true, ttlMs: MSG_TTL_MS, agents: db.agents.filter(a => !a.revoked).length, messages: db.messages.length })
  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD') && HOMEPAGE) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' })
    return res.end(req.method === 'HEAD' ? undefined : HOMEPAGE)
  }
  if (url.pathname === '/robots.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' })
    return res.end(req.method === 'HEAD' ? undefined : ROBOTS_TXT)
  }
  if (url.pathname === '/sitemap.xml' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' })
    return res.end(req.method === 'HEAD' ? undefined : SITEMAP_XML)
  }

  // ----- token management -----
  // Enforced mode: everything here requires the admin key.
  // Open mode: POST (join) is anonymous, but GET needs a valid agent token and
  // DELETE only works on yourself — peers must not be able to revoke each other.
  if (url.pathname === '/tokens' || url.pathname.startsWith('/tokens/')) {
    if (ADMIN_KEY && (!token || !timingSafeEq(token, ADMIN_KEY))) return json(res, 401, { error: 'admin key required' })
    if (!ADMIN_KEY && route !== 'POST /tokens') {
      const caller = findAgent(token)
      if (!caller) return json(res, 401, { error: 'valid agent token required' })
      if (req.method === 'DELETE' && url.pathname.split('/')[2] !== caller.id) {
        return json(res, 403, { error: 'open hub: you can only revoke your own agent' })
      }
    }

    if (route === 'POST /tokens') {
      if (db.agents.filter(a => !a.revoked).length >= MAX_AGENTS) return json(res, 429, { error: 'agent limit reached' })
      const body = await readBody(req)
      const name = String(body.name || '').trim()
      if (!name || name.length > 64) return json(res, 400, { error: 'name required (max 64 chars)' })
      if (db.agents.some((a) => !a.revoked && a.name === name)) return json(res, 409, { error: `agent name "${name}" already exists` })
      const tok = newToken()
      const pubKey = validPubKey(body.pubKey) ? body.pubKey : null
      const agent = { id: newId('agt'), name, tokenHash: hashToken(tok), pubKey, createdAt: Date.now(), lastSeen: null, revoked: false }
      db.agents.push(agent)
      save()
      return json(res, 201, { agentId: agent.id, name: agent.name, token: tok })
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

  if (route === 'POST /refresh') {
    // rotate the caller's own token: old one stops working immediately,
    // identity (id, name, history) is preserved. Optionally (re)registers the
    // caller's encryption public key.
    const body = await readBody(req)
    const tok = newToken()
    agent.tokenHash = hashToken(tok)
    if (validPubKey(body.pubKey)) agent.pubKey = body.pubKey
    save()
    return json(res, 200, { agentId: agent.id, name: agent.name, token: tok })
  }

  if (route === 'POST /messages') {
    const body = await readBody(req)
    const tier = TIERS.includes(body.tier) ? body.tier : 'normal'
    const to = body.to ? String(body.to).slice(0, 64) : null
    const recipient = to ? db.agents.find((a) => !a.revoked && a.name === to) : null
    if (to && !recipient) return json(res, 400, { error: `unknown recipient "${to}" — they may have left or rotated identity` })
    const replyTo = body.replyTo ? String(body.replyTo).slice(0, 64) : null
    // routing metadata stays plaintext (see privacy model, top of file)
    const msg = {
      id: newId('msg'),
      seq: nextSeq(),
      ts: Date.now(),
      agentId: agent.id,
      agent: agent.name,
      tier,
      to,
      replyTo,
    }
    if (body.e2e && typeof body.e2e === 'object') {
      // sealed body: { epk, iv, ct, keys: { agentName: wrappedKey } } — all
      // opaque to the hub; validate shape/size only
      const { epk, iv, ct, keys } = body.e2e
      if (!validPubKey(epk) || typeof iv !== 'string' || iv.length > 64 ||
          typeof ct !== 'string' || ct.length > 128 * 1024 ||
          !keys || typeof keys !== 'object' || Array.isArray(keys)) {
        return json(res, 400, { error: 'malformed e2e payload' })
      }
      const entries = Object.entries(keys).slice(0, MAX_AGENTS)
      if (entries.some(([k, v]) => k.length > 64 || typeof v !== 'string' || v.length > 300)) {
        return json(res, 400, { error: 'malformed e2e key map' })
      }
      msg.e2e = { v: 1, epk, iv, ct, keys: Object.fromEntries(entries) }
    } else {
      // legacy plaintext path (old clients); new clients always send e2e
      const text = String(body.text || '').trim()
      if (!text) return json(res, 400, { error: 'text or e2e required' })
      msg.text = text.slice(0, 64 * 1024)
      msg.files = Array.isArray(body.files) ? body.files.slice(0, 50).map(String) : []
    }
    db.messages.push(msg)
    if (db.messages.length > MAX_MESSAGES) db.messages = db.messages.slice(-MAX_MESSAGES)
    // deliberately no save(): messages are RAM-only
    broadcast(msg)
    const delivery = recipient
      ? { delivery: [...sseClients].some((c) => c.agentId === recipient.id) ? 'live' : 'offline', recipientLastSeen: recipient.lastSeen }
      : {}
    return json(res, 201, { id: msg.id, seq: msg.seq, ttlMs: MSG_TTL_MS, ...delivery })
  }

  if (route === 'GET /messages') {
    const since = Number(url.searchParams.get('since') || 0)
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500)
    const excludeSelf = url.searchParams.get('exclude_self') === '1'
    const cutoff = Date.now() - MSG_TTL_MS
    let msgs = db.messages.filter((m) => m.seq > since && m.ts >= cutoff)
    if (excludeSelf) msgs = msgs.filter((m) => m.agentId !== agent.id)
    msgs = msgs.slice(-limit)
    return json(res, 200, { messages: msgs, cursor: db.messages.at(-1)?.seq || since })
  }

  if (route === 'GET /agents') {
    return json(res, 200, db.agents.filter(a => !a.revoked).map(({ id, name, lastSeen, pubKey }) => ({ id, name, lastSeen, pubKey: pubKey || null, you: id === agent.id })))
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
