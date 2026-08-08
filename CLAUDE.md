# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                       # one runtime dep: @modelcontextprotocol/sdk
npm test                          # node --test test/*.test.mjs + smoke-mcp + demo/smoke + demo/smoke-remote

node --test test/store.test.mjs                       # one file
node --test --test-name-pattern="lost update"         # one test
node test/smoke-mcp.mjs                               # MCP round trip over a real stdio server
npm run demo:smoke                                    # harness + fake `claude`, free

npm run http                      # HTTP transport, 127.0.0.1:7510/mcp/<agent>
RELAY_SECRET=… npm run relay      # the relay, PORT 7511
npm run demo                      # LIVE run: real `claude -p` sessions, ~$3 and ~30 min
```

`npm run demo` / `demo:remote` spend real money and take half an hour. Use `npm run demo:smoke`
for anything about the harness itself; the live runs only answer "will six real sessions actually
write that way", which no unit test can.

The relay tests (`test/relay.test.mjs`, `test/security.test.mjs`) spawn a real relay process and
talk HTTP to it; they need free ports and a few seconds.

## Architecture

One core, several thin faces. Everything that touches state goes through `src/store.mjs`; nothing
else is allowed to know the on-disk layout.

```
src/store.mjs     the core: registry + channel. ZERO runtime deps, fully SYNCHRONOUS —
                  hooks and cron import it where there is no node_modules and no event loop.
src/tools.mjs     the MCP tool definitions + handlers, transport-independent
src/stdio.mjs     transport 1 (DEFAULT): identity = cwd, unforgeable
src/http.mjs      transport 2: identity = URL path (/mcp/<agent>), for a daemon
bin/sac.mjs       the CLI on the same core, so CLI and MCP cannot drift apart
hooks/*.mjs       session-start (check in + watchPaths) and stop (block on unread mail)
src/bridge.mjs    the remote leg, client half: push/pull, remote↔local name translation
src/relay.mjs     the remote leg, server half: stateless, in-memory, HMAC tokens
src/crypto.mjs    AES-256-GCM room encryption + stateless token signing
src/triage.mjs    the letterbox: a cheap model deciding whether an entry is worth a turn
```

State lives outside the repo, in `$SET_AGENT_COMM_DIR` (default
`~/.local/share/set-agent-comm/`): `registry.json`, `cursors.json`, `nudges.json`, `focus.json`,
`relays.json` (mode 600 — device tokens and room keys), and `channels/<room>/<seat>.md`.

### Invariants — breaking any of these reintroduces a measured failure

- **One file, one writer, append-only.** A seat writes only its own `channels/<room>/<seat>.md`
  and reads the others'. No lockfile: a dead session's lock would stay stuck forever.
- **`from` and the timestamp are server-side.** The model never supplies either. Timestamps carry
  millisecond resolution and a local offset; sorting is by real time (`byTime`), not by string.
- **`isForMe` ≠ `wakes`.** Delivery is cheap, a wake-up is a whole expensive turn. `wakes()` in
  `store.mjs` is the single rule the Stop hook, `sac wait` and `inbox` all read; do not
  re-implement it at a call site.
- **Nothing but `inbox` advances the cursor.** Hooks and `sac wait` pass `advance: false`. A
  notification is not a delivery.
- **The letterbox fails OPEN, the safety net fails CLOSED** (`triage.mjs`). Missing a message is
  the failure this project exists to prevent; a needless turn merely costs one. The net is the
  opposite: a net that guesses yes rebuilds the storm it was added to catch.
- **Interpreters are spelled out** (`process.execPath`), never a bare `node`, in anything written
  into a settings file or a skill — hooks do not run in an interactive shell.
- **Names from the network become file names.** `assertSafeWriter` / `assertSafeTs` are enforced
  by the relay *and*, independently, by the receiver.

### Seats

A seat is `<project>#<session-id-prefix>` — the project comes from the cwd (or `SET_AGENT_NAME`),
the session from `CLAUDE_CODE_SESSION_ID`. But the *window* is identified by the owning `claude`
process (`ownerPid`), because the MCP server and the SessionStart hook can be handed two different
session ids for one window. `claimSeat` may create a seat; a hook that only looks uses `seatOf`.
Remote seats carry a device: `web-app@macmini#3f9c1a20`, and `bridge.mjs` translates that name
back into the target machine's local form as the entry lands.

## Working in this repo

- **This repo is itself on the bus.** `.claude/settings.json` wires its own hooks into room
  `pair-room`. Do not run `sac install` here unless that is the point — it writes into
  `$PWD/.claude/`.
- **After changing anything on the read path, restart what polls.** A running `sac wait` and the
  MCP server loaded their code at startup and both ingest remote entries; the log is append-only,
  so whatever they write meanwhile is written wrong for good. `sac wait`: kill and restart.
  MCP: `/mcp reconnect` or a new session.
- **Tests point at a temp store.** Set `SET_AGENT_COMM_DIR` to a `mkdtemp` dir before importing
  `store.mjs` (it reads `ROOT` at module load). In-process multi-session tests also need
  `SET_AGENT_OWNER_PID`, otherwise the real `claude` ancestor above the test runner correctly
  collapses every simulated session onto one seat. Stub the letterbox with
  `SET_AGENT_TRIAGE_BIN=test/fake-letterbox.mjs` (`SET_AGENT_TRIAGE_SAYS=yes|no|junk|hang`).
- **Assert on the result, not the call** — read the file system back, spawn the hook and the CLI
  as real processes the way Claude Code runs them.
- **The comments are the changelog.** Nearly every non-obvious branch carries a dated, measured
  account of the failure that put it there ("⚠ Measured 2026-08-06 …"). Keep them, and add one in
  the same form when a fix comes from observed behaviour rather than from reasoning. Same for the
  README, which is the design document, not a quickstart.
- **`docs/` holds the plans for what is not built yet**, in the same style — dated measurements,
  and retractions kept visible rather than edited away. Read them before designing anything that
  touches rooms or cross-project traffic: `docs/rooms.md` (what a channel is: DM vs room — upstream
  of the other) and `docs/cross-project-requests.md` (the authorization and wake-up layer).
- Style: ESM, no semicolons, double quotes, 2-space indent, no runtime dependency in the core.

## Env vars worth knowing

`SET_AGENT_COMM_DIR` (store root) · `SET_AGENT_NAME` (override the project name) ·
`SET_AGENT_ROOM` (comma-separated; with several rooms there is **no default room** and `send`
without an explicit room fails) · `SET_AGENT_DEVICE` · `SET_AGENT_LONG_CHARS` (1500) ·
`SET_AGENT_INBOX_CHARS` (1200, `0` = off) · `SET_AGENT_TRIAGE=off` · `SET_AGENT_TRIAGE_BIN` /
`_MODEL` / `_TIMEOUT_MS` · `SET_AGENT_SAFETY_NET=off` · `SET_AGENT_QUIET_MS`.
Relay side: `RELAY_SECRET` (required), `RELAY_HOST`, `PORT`, `RELAY_RETENTION_HOURS`,
`RELAY_DEVICE_TTL_DAYS`, `RELAY_LIMIT_*`, `RELAY_MAX_ROOM_*`.
