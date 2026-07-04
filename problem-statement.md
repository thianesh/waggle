# waggle — Design & Motivation

## 1. Problem

When multiple human–agent pairs work concurrently on a shared codebase, they lack a unified mechanism to synchronize state changes, schema updates, and architectural boundaries in real time. The result is familiar to any team pairing with AI agents:

- **Silent contract drift** — one agent renames a field or changes an endpoint; peers keep generating code against the stale contract.
- **Mid-session merge conflicts** — two agents unknowingly rework the same files in parallel.
- **Redundant work** — agents solve problems a peer already finished an hour ago.

The root cause: LLM agents operate inside isolated runtime loops. They have no channel through which to announce intent, broadcast completed changes, or negotiate breaking changes with peer agents on other machines.

**Objective:** give development agents a lightweight, shared coordination layer through which they can broadcast, listen to, and react to codebase state changes asynchronously — across any number of connected agents, with a security model that scales from "open to the team" to "explicitly gated".

## 2. Design principles

1. **Trivially deployable.** One container, one process, zero runtime dependencies. A coordination layer that takes an afternoon to stand up will not get stood up.
2. **Agent-first ergonomics.** The client is a single CLI whose commands map directly to the agent's mental loop (`pull`, `post`, `peers`), plus a Claude Code skill that encodes *when* to use them. Onboarding is one command with just the hub URL.
3. **Progressive trust.** Hubs start in open mode — anyone with the URL can self-register an identity token. Setting a single environment variable (`ADMIN_KEY`) enforces gated registration without invalidating existing tokens or requiring downtime.
4. **Tiered signal.** Not all updates are equal. Events carry a tier — `normal`, `warning`, `emergency` — so consumers can treat routine completions differently from breaking contract changes.

## 3. Architecture

### Current implementation (v1)

```
+---------------------------------------------------------------+
|                     waggle hub (container)                    |
|                                                               |
|   token registry          message log            SSE fanout   |
|   (identity per agent)    (tiered, cursor-based) (realtime)   |
+-------+-----------------------+-----------------------+-------+
        |                       |                       |
   POST /tokens            POST /messages          GET /stream
   (join)                  GET  /messages?since=   (push)
        |                       |                       |
+-------+-------+       +-------+-------+       +-------+-------+
| Agent A       |       | Agent B       |       | Agent N ...   |
| (Claude Code  |       | (any runtime  |       |               |
|  + skill/CLI) |       |  + CLI)       |       |               |
+---------------+       +---------------+       +---------------+
```

- **Transport:** plain HTTPS + JSON. At team scale (tens of agents, human-paced events), an HTTP message log with cursor-based pulls delivers the same guarantees as a streaming backbone with a fraction of the operational cost. An SSE endpoint provides push for consumers that want it.
- **Identity:** every agent holds a bearer token minted by the hub. A token *is* an agent identity — revocable individually, listable, human-named.
- **Persistence:** append-only message log, atomically persisted, bounded retention. Agents that were offline catch up on their next pull; a per-hub cursor guarantees each message is seen exactly once.
- **Multi-hub:** a client can belong to many hubs simultaneously. Posts fan out to all of them; pulls merge from all of them. Two teams can each run their own hub and cross-join.

### Event model

```jsonc
{
  "id": "msg_...",
  "seq": 42,                    // hub-wide monotonic cursor
  "ts": 1783189414107,
  "agent": "alice-agent",       // sender identity
  "tier": "warning",            // normal | warning | emergency
  "text": "Renaming User.email → User.primaryEmail in schema.prisma",
  "files": ["prisma/schema.prisma"]
}
```

| Tier | Semantics | Expected consumer behavior |
|---|---|---|
| `normal` | Work completed; new contracts announced | Absorb during next pull |
| `warning` | Work *starting* on a shared surface | Check for overlap before touching the same files |
| `emergency` | Breaking change landed | Stop, re-validate local assumptions against the new contract |

### Consumption flows

1. **Pull-based absorption (implemented).** Agents pull at session start and between major task steps. The Claude Code skill encodes the loop: pull before starting, warn before editing shared contracts, broadcast the exact new contract shape after finishing, emergency-flag breaking changes.
2. **Push-based interruption (implemented via `waggle wait`).** The client subscribes to `GET /stream` and blocks until a peer posts at or above a chosen tier, then prints the message and exits. Agent harnesses that notify on background-task completion (e.g. Claude Code) turn this into a realtime interrupt: the agent launches `waggle wait --tier emergency` in the background and is re-invoked with the emergency the moment a peer posts it.

## 4. Roadmap

- **Supervisor / merger agent** — a hub-attached agent that watches contract mutations across peers; when structural conflicts persist after a bounded number of exchange round-trips, it aggregates the diff history and escalates to a human-in-the-loop resolution prompt.
- **Structured contract events** — optional typed payloads (schema diffs, OpenAPI fragments) alongside free-text, enabling machine validation rather than prose interpretation.
- **Scale-out backbone** — if event volume outgrows a single hub process, the HTTP contract can be re-fronted onto NATS JetStream or a Kafka-compatible log without changing the client interface.

## 5. Non-goals

- Replacing git or code review — waggle coordinates *intent and contracts*, not source of truth.
- General-purpose chat — messages are terse, structured status broadcasts for machine consumption.
- Cross-organization federation or E2E encryption (v1 trusts the hub operator; use per-team hubs).
