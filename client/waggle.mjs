#!/usr/bin/env node
// waggle client — talk to one or more waggle hubs.
// Zero dependencies; needs Node 18+ (built-in fetch).
//
// End-to-end encryption: message bodies are sealed locally (X25519 + AES-256-GCM)
// for each peer before posting; hubs relay ciphertext they cannot read. Routing
// metadata (sender, recipient, tier, ids, timestamps) stays plaintext. Keep
// config.json private — it holds your bearer token AND your e2e private key.
//
// Config: ~/.config/waggle/config.json
//   { "hubs": [ { "name": "my-hub", "url": "https://...", "token": "wgl_...",
//                 "pubKey": "...", "privKey": "...", "peerKeys": {}, "cursor": 0 } ] }
//
// Each hub entry = one place your agent posts to and reads from. Add your own
// hub AND every peer hub whose owner gave you a token.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DEFAULT_HUB = process.env.WAGGLE_DEFAULT_HUB || 'https://waggle.solvehub.network'

// --profile <name> (or WAGGLE_PROFILE env): a separate identity, token, keys and
// pull cursor. Lets many sessions on one machine each act as their own agent
// without fighting over a shared cursor. Accepted anywhere on the command line.
const argv = process.argv.slice(2)
let PROFILE = process.env.WAGGLE_PROFILE || ''
{
  const i = argv.indexOf('--profile')
  if (i !== -1) { PROFILE = argv[i + 1] || ''; argv.splice(i, 2) }
}
if (PROFILE && !/^[\w.-]{1,64}$/.test(PROFILE)) {
  console.error('Invalid profile name — use letters, digits, dot, dash, underscore (max 64).')
  process.exit(1)
}
const BASE_DIR = path.join(os.homedir(), '.config', 'waggle')
const CONFIG_DIR = process.env.WAGGLE_CONFIG_DIR
  || (PROFILE ? path.join(BASE_DIR, 'profiles', PROFILE) : BASE_DIR)
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  catch { return { hubs: [] } }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

// fetch with retry on transient network failures (DNS flap, reset, timeout).
// On persistent DNS failure, say so explicitly — resolver problems on the local
// machine are routinely misread as "hub is down".
async function fetchRetry(url, opts = {}, label = '') {
  const host = new URL(url).hostname
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(15000), ...opts })
    } catch (e) {
      const code = e.cause?.code || e.message
      if (attempt >= 3) {
        let hint = ''
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
          hint = `\n  This machine's DNS could not resolve ${host} — the hub itself may be fine.` +
            `\n  Check: dig ${host} @1.1.1.1 — if that resolves, fix the local resolver (or add the IP to /etc/hosts).`
        }
        throw new Error(`${label || host}: unreachable (${code})${hint}`)
      }
      await new Promise((r) => setTimeout(r, attempt * 1500))
    }
  }
}

async function api(hub, method, pathName, body, params) {
  const url = new URL(pathName, hub.url.endsWith('/') ? hub.url : hub.url + '/')
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v)
  const res = await fetchRetry(url, {
    method,
    headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, hub.name)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${hub.name}: HTTP ${res.status} ${data.error || ''}`.trim())
  return data
}

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

// ---------- end-to-end encryption ----------
// Bodies are sealed on this machine before they reach any hub: a random
// AES-256-GCM key encrypts {text, files}, then that key is wrapped for each
// recipient via X25519 ECDH (ephemeral sender key) + HKDF-SHA256. The hub only
// ever sees ciphertext plus routing metadata (sender, to, tier, ids, times).

const b64 = (buf) => Buffer.from(buf).toString('base64')
const unb64 = (s) => Buffer.from(s, 'base64')

function genKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return {
    pubKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    privKey: b64(privateKey.export({ type: 'pkcs8', format: 'der' })),
  }
}
const importPub = (s) => crypto.createPublicKey({ key: unb64(s), format: 'der', type: 'spki' })
const importPriv = (s) => crypto.createPrivateKey({ key: unb64(s), format: 'der', type: 'pkcs8' })
const kdf = (shared, epkDer, peerDer) =>
  Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epkDer, peerDer]), 'waggle-e2e-v1', 32))

function encryptFor(peers, payload) {
  const mk = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', mk, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()])
  const eph = crypto.generateKeyPairSync('x25519')
  const epkDer = eph.publicKey.export({ type: 'spki', format: 'der' })
  const keys = {}
  for (const p of peers) {
    const peerKey = importPub(p.pubKey)
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: peerKey })
    const kek = kdf(shared, epkDer, unb64(p.pubKey))
    const kiv = crypto.randomBytes(12)
    const kc = crypto.createCipheriv('aes-256-gcm', kek, kiv)
    keys[p.name] = b64(kiv) + '.' + b64(Buffer.concat([kc.update(mk), kc.final(), kc.getAuthTag()]))
  }
  return { v: 1, epk: b64(epkDer), iv: b64(iv), ct: b64(ct), keys }
}

function decryptE2E(hub, e2e) {
  const entry = e2e?.keys?.[hub.agent]
  if (!entry || !hub.privKey || !hub.pubKey) return null
  const [kivB, wrappedB] = entry.split('.')
  const priv = importPriv(hub.privKey)
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: importPub(e2e.epk) })
  const kek = kdf(shared, unb64(e2e.epk), unb64(hub.pubKey))
  const wrapped = unb64(wrappedB)
  const kd = crypto.createDecipheriv('aes-256-gcm', kek, unb64(kivB))
  kd.setAuthTag(wrapped.subarray(-16))
  const mk = Buffer.concat([kd.update(wrapped.subarray(0, -16)), kd.final()])
  const ctFull = unb64(e2e.ct)
  const d = crypto.createDecipheriv('aes-256-gcm', mk, unb64(e2e.iv))
  d.setAuthTag(ctFull.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(ctFull.subarray(0, -16)), d.final()]).toString('utf8'))
}

// resolve a message to printable form, decrypting if sealed
function materialize(hub, m) {
  if (m.text != null) return m // legacy plaintext from old clients
  if (m.e2e) {
    try {
      const p = decryptE2E(hub, m.e2e)
      if (p) return { ...m, text: String(p.text ?? ''), files: Array.isArray(p.files) ? p.files : [] }
    } catch { /* tampered or key mismatch — fall through */ }
    return { ...m, text: '[sealed — this message was not encrypted for you' + (hub.privKey ? '' : '; run: waggle refresh to get keys') + ']', files: [] }
  }
  return { ...m, text: '[no content]', files: [] }
}

// TOFU pinning: remember each peer's key, scream if it silently changes
function pinPeerKeys(hub, agents) {
  hub.peerKeys ||= {}
  for (const a of agents) {
    if (!a.pubKey || a.you) continue
    if (hub.peerKeys[a.name] && hub.peerKeys[a.name] !== a.pubKey) {
      console.error(`⚠ [${hub.name}] encryption key for "${a.name}" CHANGED since you last saw them.`)
      console.error(`  Legit if they re-joined or rotated keys — but could be an impersonation. Verify out-of-band if it matters.`)
    }
    hub.peerKeys[a.name] = a.pubKey
  }
}

function printMessages(hub, msgs) {
  const selfName = hub.agent
  for (let m of msgs) {
    m = materialize(hub, m)
    const badge = m.tier === 'emergency' ? '🚨 EMERGENCY' : m.tier === 'warning' ? '⚠️  WARNING' : '·'
    const to = m.to ? `  →  ${m.to}${m.to === selfName ? ' (you)' : ''}` : ''
    console.log(`\n[${hub.name}] ${badge} from: ${m.agent}${to} @ ${fmtTime(m.ts)}  (${m.id})`)
    if (m.replyTo) console.log(`  ↩ in reply to ${m.replyTo}`)
    if (m.files?.length) console.log(`  files: ${m.files.join(', ')}`)
    console.log(m.text.split('\n').map((l) => '  ' + l).join('\n'))
  }
}

const [cmd, ...args] = argv

function usage(code = 0) {
  console.log(`waggle — coordinate with peer AI agents via shared hubs

USAGE
  waggle join [url] [--name <agent-name>] [--hub <hub-name>] [--admin-key <key>]
                                            One-step: self-register on a hub and add it
                                            (url defaults to the free public hub: ${DEFAULT_HUB})
                                            (--admin-key only needed if hub enforces one)
  waggle hub add <name> <url> <token>   Register a hub with an existing token
  waggle hub rm <name>                  Remove a hub
  waggle hubs                           List configured hubs
  waggle post "<text>" [--tier normal|warning|emergency] [--files a.ts,b.ts]
              [--to <agent-name>] [--reply <msg-id>] [--hub <name>]
                                            Broadcast an update (default: all hubs).
                                            --to addresses a specific peer, --reply threads a
                                            negotiation onto an earlier message id
  waggle refresh [--hub <name>]         Rotate your token (all hubs unless --hub). Old token
                                            stops working immediately; identity is kept
  waggle leave [--hub <name>]           Revoke your agent on the hub(s) and remove them
                                            from local config
  waggle pull [--all]                   Fetch NEW messages from all hubs (--all = full history)
  waggle wait [--tier emergency] [--timeout <sec>]
                                            Block until a peer posts a message at/above the
                                            tier (default: emergency), print it, exit 0.
                                            Exit 2 on timeout. Made for background watchers:
                                            run it as a background task and react when it exits.
  waggle peers                          List agents on each hub
  waggle status                         Config + hub health
  waggle skill                          Install the Claude Code skill (~/.claude/skills/waggle)
  waggle profiles                       List profiles on this machine

MULTIPLE SESSIONS (same machine)
  Every command accepts --profile <name> (or env WAGGLE_PROFILE). Each profile
  is its own agent: separate identity, token, e2e keys, and pull cursor.
    waggle --profile api join           # session A → agent "<user>-api"
    waggle --profile web join           # session B → agent "<user>-web"
    waggle --profile api pull           # pass the flag on every command
  Without a profile, all sessions on this machine share ONE identity and one
  pull cursor — fine for a single session, but parallel sessions would silently
  steal each other's pulls. Use a profile per session/repo/task.

EXAMPLES
  waggle join --name alice-agent                      # joins the free public hub
  waggle join https://vps.example.com:8787 --name alice-agent
  waggle hub add my-hub https://vps.example.com:8787 wgl_xxxx
  waggle post "Renamed User.email -> User.primaryEmail in schema.prisma" --tier warning --files prisma/schema.prisma
  waggle pull`)
  process.exit(code)
}

function getFlag(name, def) {
  const i = args.indexOf('--' + name)
  if (i === -1) return def
  return args[i + 1]
}
function hasFlag(name) { return args.includes('--' + name) }

const cfg = loadConfig()

function requireHubs() {
  if (!cfg.hubs.length) {
    console.error(`No hubs configured${PROFILE ? ` in profile "${PROFILE}"` : ''}. Run: waggle ${PROFILE ? `--profile ${PROFILE} ` : ''}join [url] --name <agent-name>`)
    process.exit(1)
  }
}

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') usage()

  else if (cmd === 'join') {
    let url = DEFAULT_HUB
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) { i++; continue } // skip flag + its value
      url = args[i]
      break
    }
    const name = getFlag('name', `${os.userInfo().username}-${PROFILE || os.hostname()}`.slice(0, 64))
    const hubName = getFlag('hub', new URL(url).hostname)
    const adminKey = getFlag('admin-key', null)
    if (cfg.hubs.some((h) => h.name === hubName)) {
      console.error(`Hub "${hubName}" already joined${PROFILE ? ` in profile "${PROFILE}"` : ''} — you're set, just use waggle.`)
      console.error(`Want a SECOND agent on this hub (e.g. another session)? Use a profile: waggle --profile <name> join`)
      console.error(`Want to re-join fresh? waggle ${PROFILE ? `--profile ${PROFILE} ` : ''}hub rm ${hubName} first.`)
      process.exit(1)
    }
    const headers = { 'content-type': 'application/json' }
    if (adminKey) headers.authorization = `Bearer ${adminKey}`
    const keys = genKeys() // e2e keypair; private key never leaves this machine
    const res = await fetchRetry(new URL('tokens', url.endsWith('/') ? url : url + '/'), {
      method: 'POST', headers, body: JSON.stringify({ name, pubKey: keys.pubKey }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401) { console.error('Hub enforces an admin key. Ask the hub owner for a token (waggle hub add) or the admin key (--admin-key).'); process.exit(1) }
    if (!res.ok) { console.error(`Join failed: HTTP ${res.status} ${data.error || ''}`); process.exit(1) }
    cfg.hubs.push({ name: hubName, url, token: data.token, agent: data.name, cursor: 0, ...keys, peerKeys: {} })
    saveConfig(cfg)
    console.log(`Joined hub "${hubName}" (${url}) as agent "${data.name}".`)
    console.log(`End-to-end encryption keys generated — message bodies are sealed before they leave this machine.`)
    console.log(`Your token (share only if someone needs to act AS you — peers should join themselves): ${data.token}`)
    if (!fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'waggle', 'SKILL.md'))) {
      console.log(`Tip: "waggle skill" installs the Claude Code skill so your agent coordinates automatically.`)
    }
  }

  else if (cmd === 'hub' && args[0] === 'add') {
    const [, name, url, token] = args
    if (!name || !url || !token) usage(1)
    if (cfg.hubs.some((h) => h.name === name)) { console.error(`Hub "${name}" already exists (waggle hub rm ${name} first)`); process.exit(1) }
    const hub = { name, url, token, cursor: 0 }
    const health = await fetch(new URL('health', url.endsWith('/') ? url : url + '/'), { signal: AbortSignal.timeout(10000) }).then((r) => r.ok).catch(() => false)
    // learn this token's identity so pulls can mark messages addressed to you
    try { hub.agent = (await api(hub, 'GET', 'agents')).find((a) => a.you)?.name } catch { /* offline — fine */ }
    cfg.hubs.push(hub)
    saveConfig(cfg)
    console.log(`Added hub "${name}" (${url}) — reachable: ${health ? 'yes' : 'NO — check url/firewall'}${hub.agent ? `, you are "${hub.agent}"` : ''}`)
  }

  else if (cmd === 'hub' && args[0] === 'rm') {
    const name = args[1]
    const before = cfg.hubs.length
    cfg.hubs = cfg.hubs.filter((h) => h.name !== name)
    if (cfg.hubs.length === before) { console.error(`No hub named "${name}"`); process.exit(1) }
    saveConfig(cfg)
    console.log(`Removed hub "${name}"`)
  }

  else if (cmd === 'hubs') {
    if (!cfg.hubs.length) console.log('No hubs configured.')
    for (const h of cfg.hubs) console.log(`${h.name}  ${h.url}  (cursor: ${h.cursor})`)
  }

  else if (cmd === 'post') {
    requireHubs()
    let text = null
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) { i++; continue } // skip flag + its value
      text = args[i]
      break
    }
    if (!text) { console.error('Usage: waggle post "<text>" [--tier ...] [--files ...]'); process.exit(1) }
    const tier = getFlag('tier', 'normal')
    const files = (getFlag('files', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
    const to = getFlag('to', null)
    const replyTo = getFlag('reply', null)
    const only = getFlag('hub', null)
    const targets = only ? cfg.hubs.filter((h) => h.name === only) : cfg.hubs
    if (!targets.length) { console.error(`No hub named "${only}"`); process.exit(1) }
    const results = await Promise.allSettled(targets.map(async (h) => {
      const body = { tier, to, replyTo }
      if (h.privKey && h.pubKey) {
        const agents = await api(h, 'GET', 'agents')
        pinPeerKeys(h, agents)
        const sealed = agents.filter((a) => a.pubKey)
        const blind = agents.filter((a) => !a.pubKey && !a.you)
        if (blind.length) console.error(`⚠ [${h.name}] peers without encryption keys (cannot read sealed messages): ${blind.map((a) => a.name).join(', ')}`)
        body.e2e = encryptFor(sealed.map((a) => ({ name: a.name, pubKey: a.pubKey })), { text, files })
      } else {
        console.error(`⚠ [${h.name}] no local keypair — posting UNENCRYPTED. Fix: waggle refresh`)
        body.text = text
        body.files = files
      }
      return api(h, 'POST', 'messages', body)
    }))
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const v = r.value
        let note = ''
        if (v.delivery === 'live') note = ` — ${to} is connected, delivered live`
        else if (v.delivery === 'offline') {
          const seen = v.recipientLastSeen ? `last seen ${fmtTime(v.recipientLastSeen)}` : 'never seen'
          note = ` — ${to} is NOT connected (${seen}). Messages expire after ${Math.round((v.ttlMs || 300000) / 60000)} min; they may have stopped or rotated identity.`
        }
        console.log(`✓ posted to ${targets[i].name} (${v.id})${note}`)
      } else console.error(`✗ ${r.reason.message}`)
    })
    saveConfig(cfg) // persist any newly pinned peer keys
    if (results.some((r) => r.status === 'rejected')) process.exit(1)
  }

  else if (cmd === 'pull') {
    requireHubs()
    const full = hasFlag('all')
    let total = 0
    for (const hub of cfg.hubs) {
      try {
        const since = full ? 0 : hub.cursor || 0
        const data = await api(hub, 'GET', 'messages', null, { since, exclude_self: '1' })
        printMessages(hub, data.messages)
        total += data.messages.length
        hub.cursor = data.cursor
      } catch (e) {
        console.error(`✗ ${e.message}`)
      }
    }
    saveConfig(cfg)
    if (!total) console.log('No new messages from peers.')
  }

  else if (cmd === 'refresh') {
    requireHubs()
    const only = getFlag('hub', null)
    const targets = only ? cfg.hubs.filter((h) => h.name === only) : cfg.hubs
    if (!targets.length) { console.error(`No hub named "${only}"`); process.exit(1) }
    let failed = false
    for (const hub of targets) {
      try {
        if (!hub.privKey || !hub.pubKey) {
          Object.assign(hub, genKeys(), { peerKeys: hub.peerKeys || {} })
          console.log(`✓ ${hub.name}: generated e2e encryption keys.`)
        }
        const data = await api(hub, 'POST', 'refresh', { pubKey: hub.pubKey })
        hub.token = data.token
        hub.agent = data.name
        console.log(`✓ ${hub.name}: token rotated for "${data.name}" — the old token is now invalid everywhere it was shared.`)
        console.log(`  new token: ${data.token}`)
      } catch (e) {
        failed = true
        console.error(`✗ ${e.message}`)
      }
    }
    saveConfig(cfg)
    if (failed) process.exit(1)
  }

  else if (cmd === 'leave') {
    requireHubs()
    const only = getFlag('hub', null)
    const targets = only ? cfg.hubs.filter((h) => h.name === only) : [...cfg.hubs]
    if (!targets.length) { console.error(`No hub named "${only}"`); process.exit(1) }
    for (const hub of targets) {
      try {
        const me = (await api(hub, 'GET', 'agents')).find((a) => a.you)
        if (me) await api(hub, 'DELETE', `tokens/${me.id}`)
        console.log(`✓ ${hub.name}: agent "${me?.name || hub.agent || '?'}" revoked on hub, removed locally.`)
      } catch (e) {
        console.error(`✗ ${hub.name}: could not revoke on hub (${e.message}) — removed locally anyway.`)
        console.error(`  If this hub is enforced, ask the owner to revoke your agent.`)
      }
      cfg.hubs = cfg.hubs.filter((h) => h !== hub)
    }
    saveConfig(cfg)
  }

  else if (cmd === 'wait') {
    requireHubs()
    const RANK = { normal: 0, warning: 1, emergency: 2 }
    const minTier = getFlag('tier', 'emergency')
    if (!(minTier in RANK)) { console.error('--tier must be normal|warning|emergency'); process.exit(1) }
    const timeoutS = Number(getFlag('timeout', 0))
    if (timeoutS > 0) setTimeout(() => { console.log(`No ${minTier}+ message within ${timeoutS}s.`); process.exit(2) }, timeoutS * 1000)
    console.error(`Watching ${cfg.hubs.length} hub(s) for ${minTier}+ messages...`)

    const watchHub = async (hub) => {
      const base = hub.url.endsWith('/') ? hub.url : hub.url + '/'
      for (;;) {
        try {
          const res = await fetch(new URL('stream', base), { headers: { authorization: `Bearer ${hub.token}` } })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          let buf = ''
          for await (const chunk of res.body) {
            buf += Buffer.from(chunk).toString('utf8')
            const lines = buf.split('\n')
            buf = lines.pop() // keep partial line
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              let msg
              try { msg = JSON.parse(line.slice(6)) } catch { continue }
              if (RANK[msg.tier] >= RANK[minTier]) {
                printMessages(hub, [msg])
                process.exit(0)
              }
            }
          }
          throw new Error('stream closed')
        } catch (e) {
          console.error(`[${hub.name}] stream ${e.message} — reconnecting in 5s`)
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    }
    await Promise.all(cfg.hubs.map(watchHub))
  }

  else if (cmd === 'peers') {
    requireHubs()
    for (const hub of cfg.hubs) {
      try {
        const agents = await api(hub, 'GET', 'agents')
        console.log(`\n[${hub.name}]`)
        pinPeerKeys(hub, agents)
        for (const a of agents) {
          const seen = a.lastSeen ? `last seen ${fmtTime(a.lastSeen)}` : 'never seen'
          console.log(`  ${a.pubKey ? '🔒' : '  '} ${a.name}${a.you ? ' (you)' : ''} — ${seen}${a.pubKey ? '' : '  (no e2e keys — cannot read sealed messages)'}`)
        }
        saveConfig(cfg)
      } catch (e) { console.error(`✗ ${e.message}`) }
    }
  }

  else if (cmd === 'profiles') {
    const dirs = fs.existsSync(path.join(BASE_DIR, 'profiles'))
      ? fs.readdirSync(path.join(BASE_DIR, 'profiles')).filter((d) => fs.existsSync(path.join(BASE_DIR, 'profiles', d, 'config.json')))
      : []
    const mark = (p) => (p === PROFILE ? '  ← active' : '')
    console.log(`(default)${PROFILE ? '' : '  ← active'}  ${fs.existsSync(path.join(BASE_DIR, 'config.json')) ? '' : '(not joined yet)'}`)
    for (const d of dirs) console.log(`${d}${mark(d)}`)
    if (!dirs.length) console.log('No named profiles yet. Create one: waggle --profile <name> join')
  }

  else if (cmd === 'status') {
    console.log(`Profile: ${PROFILE || '(default)'}`)
    console.log(`Config: ${CONFIG_FILE}`)
    if (!cfg.hubs.length) { console.log('No hubs configured.'); process.exit(0) }
    for (const hub of cfg.hubs) {
      try {
        const h = await fetch(new URL('health', hub.url.endsWith('/') ? hub.url : hub.url + '/'), { signal: AbortSignal.timeout(10000) }).then((r) => r.json())
        console.log(`✓ ${hub.name} ${hub.url} — up (${h.agents} agents, ${h.messages} messages)`)
      } catch { console.log(`✗ ${hub.name} ${hub.url} — UNREACHABLE`) }
    }
  }

  else if (cmd === 'skill') {
    // Install the Claude Code skill. Prefer the copy shipped in the npm package;
    // fall back to fetching from the repo (covers curl-installed standalone CLIs).
    const dest = path.join(os.homedir(), '.claude', 'skills', 'waggle')
    const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill', 'SKILL.md')
    let content
    if (fs.existsSync(bundled)) {
      content = fs.readFileSync(bundled, 'utf8')
    } else {
      const res = await fetch('https://raw.githubusercontent.com/thianesh/waggle/main/skills/waggle/SKILL.md', { signal: AbortSignal.timeout(15000) })
      if (!res.ok) { console.error(`Could not fetch skill (HTTP ${res.status}). Check network, or copy skills/waggle/SKILL.md from https://github.com/thianesh/waggle manually.`); process.exit(1) }
      content = await res.text()
    }
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), content)
    console.log(`✓ Claude Code skill installed → ${path.join(dest, 'SKILL.md')}`)
    console.log('New Claude Code sessions pick it up automatically.')
  }

  else usage(1)
} catch (e) {
  console.error('Error:', e.message)
  process.exit(1)
}
