#!/usr/bin/env node
// waggle client — talk to one or more waggle hubs.
// Zero dependencies; needs Node 18+ (built-in fetch).
//
// Config: ~/.config/waggle/config.json
//   { "hubs": [ { "name": "my-hub", "url": "https://...", "token": "wgl_...", "cursor": 0 } ] }
//
// Each hub entry = one place your agent posts to and reads from. Add your own
// hub AND every peer hub whose owner gave you a token.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_HUB = process.env.WAGGLE_DEFAULT_HUB || 'https://waggle.solvehub.network'
const CONFIG_DIR = process.env.WAGGLE_CONFIG_DIR || path.join(os.homedir(), '.config', 'waggle')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  catch { return { hubs: [] } }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

async function api(hub, method, pathName, body, params) {
  const url = new URL(pathName, hub.url.endsWith('/') ? hub.url : hub.url + '/')
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${hub.name}: HTTP ${res.status} ${data.error || ''}`.trim())
  return data
}

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function printMessages(hubName, msgs) {
  for (const m of msgs) {
    const badge = m.tier === 'emergency' ? '🚨 EMERGENCY' : m.tier === 'warning' ? '⚠️  WARNING' : '·'
    console.log(`\n[${hubName}] ${badge} ${m.agent} @ ${fmtTime(m.ts)}`)
    if (m.files?.length) console.log(`  files: ${m.files.join(', ')}`)
    console.log(m.text.split('\n').map((l) => '  ' + l).join('\n'))
  }
}

const [, , cmd, ...args] = process.argv

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
  waggle post "<text>" [--tier normal|warning|emergency] [--files a.ts,b.ts] [--hub <name>]
                                            Broadcast an update (default: all hubs)
  waggle pull [--all]                   Fetch NEW messages from all hubs (--all = full history)
  waggle wait [--tier emergency] [--timeout <sec>]
                                            Block until a peer posts a message at/above the
                                            tier (default: emergency), print it, exit 0.
                                            Exit 2 on timeout. Made for background watchers:
                                            run it as a background task and react when it exits.
  waggle peers                          List agents on each hub
  waggle status                         Config + hub health

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
    console.error('No hubs configured. Run: waggle hub add <name> <url> <token>')
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
    const name = getFlag('name', `${os.userInfo().username}-${os.hostname()}`.slice(0, 64))
    const hubName = getFlag('hub', new URL(url).hostname)
    const adminKey = getFlag('admin-key', null)
    if (cfg.hubs.some((h) => h.name === hubName)) { console.error(`Hub "${hubName}" already exists (waggle hub rm ${hubName} first)`); process.exit(1) }
    const headers = { 'content-type': 'application/json' }
    if (adminKey) headers.authorization = `Bearer ${adminKey}`
    const res = await fetch(new URL('tokens', url.endsWith('/') ? url : url + '/'), {
      method: 'POST', headers, body: JSON.stringify({ name }), signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401) { console.error('Hub enforces an admin key. Ask the hub owner for a token (waggle hub add) or the admin key (--admin-key).'); process.exit(1) }
    if (!res.ok) { console.error(`Join failed: HTTP ${res.status} ${data.error || ''}`); process.exit(1) }
    cfg.hubs.push({ name: hubName, url, token: data.token, cursor: 0 })
    saveConfig(cfg)
    console.log(`Joined hub "${hubName}" (${url}) as agent "${data.name}".`)
    console.log(`Your token (share only if someone needs to act AS you — peers should join themselves): ${data.token}`)
  }

  else if (cmd === 'hub' && args[0] === 'add') {
    const [, name, url, token] = args
    if (!name || !url || !token) usage(1)
    if (cfg.hubs.some((h) => h.name === name)) { console.error(`Hub "${name}" already exists (waggle hub rm ${name} first)`); process.exit(1) }
    const hub = { name, url, token, cursor: 0 }
    const health = await fetch(new URL('health', url.endsWith('/') ? url : url + '/'), { signal: AbortSignal.timeout(10000) }).then((r) => r.ok).catch(() => false)
    cfg.hubs.push(hub)
    saveConfig(cfg)
    console.log(`Added hub "${name}" (${url}) — reachable: ${health ? 'yes' : 'NO — check url/firewall'}`)
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
    const only = getFlag('hub', null)
    const targets = only ? cfg.hubs.filter((h) => h.name === only) : cfg.hubs
    if (!targets.length) { console.error(`No hub named "${only}"`); process.exit(1) }
    const results = await Promise.allSettled(targets.map((h) => api(h, 'POST', 'messages', { text, tier, files })))
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') console.log(`✓ posted to ${targets[i].name}`)
      else console.error(`✗ ${r.reason.message}`)
    })
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
        printMessages(hub.name, data.messages)
        total += data.messages.length
        hub.cursor = data.cursor
      } catch (e) {
        console.error(`✗ ${e.message}`)
      }
    }
    saveConfig(cfg)
    if (!total) console.log('No new messages from peers.')
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
                printMessages(hub.name, [msg])
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
        for (const a of agents) {
          const seen = a.lastSeen ? `last seen ${fmtTime(a.lastSeen)}` : 'never seen'
          console.log(`  ${a.name}${a.you ? ' (you)' : ''} — ${seen}`)
        }
      } catch (e) { console.error(`✗ ${e.message}`) }
    }
  }

  else if (cmd === 'status') {
    console.log(`Config: ${CONFIG_FILE}`)
    if (!cfg.hubs.length) { console.log('No hubs configured.'); process.exit(0) }
    for (const hub of cfg.hubs) {
      try {
        const h = await fetch(new URL('health', hub.url.endsWith('/') ? hub.url : hub.url + '/'), { signal: AbortSignal.timeout(10000) }).then((r) => r.json())
        console.log(`✓ ${hub.name} ${hub.url} — up (${h.agents} agents, ${h.messages} messages)`)
      } catch { console.log(`✗ ${hub.name} ${hub.url} — UNREACHABLE`) }
    }
  }

  else usage(1)
} catch (e) {
  console.error('Error:', e.message)
  process.exit(1)
}
