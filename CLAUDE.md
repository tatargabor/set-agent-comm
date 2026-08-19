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
src/http.mjs      transport 2: identity = URL path (/mcp/<agent>) + a per-agent token
                  (`sac http-token`) — WITHOUT one, any local process may connect as any agent
bin/sac.mjs       the CLI on the same core, so CLI and MCP cannot drift apart
hooks/*.mjs       session-start (check in + watchPaths) and stop (block on unread mail).
                  Both go SILENT for a headless `claude -p` — see `store.headless`
src/bridge.mjs    the remote leg, client half: push/pull, remote↔local name translation
src/relay.mjs     the remote leg, server half: stateless, in-memory, HMAC tokens
src/crypto.mjs    AES-256-GCM room encryption + stateless token signing
src/triage.mjs    the letterbox: a cheap model deciding whether an entry is worth a turn
src/policy.mjs    the authorization layer's evaluator — PURE, no I/O but reading the policy
                  file. Four verdicts: serve / gate / wake / deny. Nothing calls it yet
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
- **The rooms that WAKE a seat come from the seat's own book, never from the environment**
  (`store.wakingRooms`): configured ∪ declared, minus what it has `part`ed, re-read on every check.
  Measured 2026-08-19: a room joined mid-session was watched by nothing — the Stop hook iterated
  `SET_AGENT_ROOM` and `sac wait` resolved its list once, at arm time — while `send` reported that
  it woke the seat. The one exception is an explicit room list argued to `sac wait`, which means
  exactly those rooms; that is why the SessionStart note passes the rooms in the ENVIRONMENT and
  leaves the argument list empty.
- **A seat name is a complete address** (`store.resolveRoom`, one rule, both faces). An addressee
  reachable in exactly one of your rooms names that room; in several, you are asked; in none, the
  refusal says which room that seat IS in. A room chosen for you is always reported back, because
  the room decides who may read the entry.
- **The letterbox fails OPEN, the safety net fails CLOSED** (`triage.mjs`). Missing a message is
  the failure this project exists to prevent; a needless turn merely costs one. The net is the
  opposite: a net that guesses yes rebuilds the storm it was added to catch.
- **Never `mkdirSync(…, { recursive: true })` — `store.ensureDir` instead.** Node's version
  creates the missing parent and retries the leaf, counting the parent's `EEXIST` as success, so
  where the leaf's `ENOENT` is permanent while the parent exists (procfs) it retries *forever*,
  inside node. Measured 2026-08-09: a `heartbeat.mjs` burning a whole core for 6h09m, orphaned by
  the test run that spawned it. A synchronous loop in a C++ builtin cannot be caught, timed out,
  or defended against by the hook's own `try`/`catch`.
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

### Liveness is fed by a hook, and three-state

`seatState` answers `true` / `null` / `false`, and **`null` means "we do not know", not "dead"** —
never collapse the two, in code or on a screen. From the outside both read as "not true", so the
distinction only survives if every consumer keeps it.

It used to be written **only at session start**. Measured 2026-08-09: `consumer-a#f93ef295` showed
`lastSeen: 11:05` at 12:31 — 86 minutes of apparent silence while it worked throughout — and the
session reading that list addressed its message to a different seat because of it, saying so
explicitly. The signal was real; nobody fed it.

`hooks/heartbeat.mjs` (PostToolUse, wired by `sac install`) feeds it. Three things about it are
load-bearing:

- **It records `ownerPid()`, not `process.pid`.** The hook process is gone milliseconds later; a
  beat that recorded its own pid leaves the seat resolving to `null` — reporting the exact thing
  it exists to correct. Caught while building it, and pinned by a test.
- **It rate-limits (60 s, one stamp file per seat), for correctness rather than speed.**
  `register` rewrites the whole shared registry, and this fires on *every* tool call; several
  sessions doing that at once is a lost-update race on the one file every seat reads.
- **It never blocks, never throws, never prints.** Anything printed lands in the transcript on
  every tool use, and a liveness ping able to fail a turn is worse than the silence it fixes.

A heartbeat sent by the *agent* was rejected: that costs a whole turn — tokens and an interrupted
context — to say nothing. This costs a process.

### `sac admin`

The operator's view: channels, who is subscribed, **who is behind on reading** (from `cursors.json`
— the question no JSON tool answered), and the live flow with who wakes whom. It is
`src/admin-tui.mjs`, zero dependencies, and **read-only by construction**: it derives everything
and writes nothing, so watching a room can never change what the seats in it will see — no cursor
moves, nothing is marked read.

Two judgements in it, both tested, both about not misleading the operator:

- **A closed session is not "behind", it is gone.** Counting its backlog put *5959* unread on a
  room where nobody reachable was behind at all, and a number like that is one you learn to
  ignore — which costs you the real ones. Room totals count reachable seats only (`live !== false`,
  so unknown counts).
- **Unknown liveness is drawn as `?`**, never as an empty circle, for the reason in the section
  above.

Navigation (2026-08-11): one pane is active (`Tab`), every pane scrolls, `↵` opens an entry's whole
text or a seat's detail, `/` searches, `f` filters the flow, `?` lists the keys. `render(snap, ui)`
stays **pure** — that is what keeps a whole screen assertable without a terminal, and every new
behaviour is tested that way. Selection is anchored to an **identity** (room name, seat, `ts|from`),
never an index: the view redraws every second and an index would slide onto a different message the
moment one arrived above the cursor.

### Declared state — the one thing that is not derived

⚠ Added 2026-08-11 from eight days of measured traffic (`docs/internal/field-notes-2026-08-10.md`).
Everything else here is *derived*; these three are *declared*, because a fact that contradicts the
derivation had nowhere to live:

- `rooms.json` — a room exists because somebody opened it. `send` into a room that does not exist
  **fails**; `register`, `install`, `join --create` and redeeming an invite may open one.
  **A channel directory still counts as a room**, which is the entire migration story.
- `members.json` — `{ rooms, left }` per seat. **`left` is why `part` sticks**: the SessionStart
  hook re-registers every configured room on every start, so a membership that only recorded what a
  seat is *in* would have a person's decision undone by the next hook run. The environment may
  ADD a room, never restore one that was left.
  ⚠ **Membership lives in TWO files and only one of them is read by the others** (2026-08-12, from
  the `consumer-a` report). `members.json` is the seat's own book; the ROSTER — `liveSeats`,
  `roomSeats`, and so `send`'s wake report and `sac rooms` — is the registry's per-seat `rooms`.
  Measured: after `joinRoom` the roster was empty (a join nobody else could see, which is why a
  project's worksheet had settled on `sac register` to join with), and after `partRoom` the seat
  was still on it, so the next hook run undid the leaving. `joinRoom` / `partRoom` now write both
  halves (`registerRoom` / `unregisterRoom`), and `register` **skips a room the seat has left** —
  the same asymmetry `seedMembers` already had, applied where it is visible.
- **A DM is a room of two** (`store.dmRoom` / `sac dm`), decided 2026-08-19 — `docs/rooms.md` had
  left it open. `pair: [a, b]` in `rooms.json` is DECLARED, not counted, and it is what makes the
  two exceptions true: **every entry wakes the other side** (`wakes(…, pair)`), and **reading is
  restricted** (`assertMayRead`, the only such place on the bus — a boundary in the tools, not a
  secret: `sac admin` and any process of the same user still see the file). The name is derived from the two seat names (slugged: `#` would cut a relay URL off
  at the fragment), so both sides compute the same one and no pair registry is needed.
  `inviteToRoom` puts the peer in it and **will not undo a `part`**.
- `presence.json` — `quiet`, the fourth state. It lives in `seatPresence()`, **not** as a fourth
  value of `seatState` (which stays `true`/`null`/`false`): every consumer treats those three
  distinctly, and a fourth value would silently reclassify a quiet seat inside all of them. Applied
  in `wakes()` and nowhere else, so delivery is untouched — a quiet seat reads everything.

### The ledger and `sac stats`

`stats/<seat>.jsonl`, append-only, one writer — the same invariant as the channel, and for the same
reason. It records **decisions where they are made** (the rule at write time, the letterbox and the
net in `sac wait`) and **wake-ups where they are delivered** (`sac wait`, the Stop hook). The gap
between the two is the number the project never had: a decision with no delivery is a seat nobody
could wake. It **never blocks, never throws, never prints** (heartbeat rule), is bounded per seat,
and a letterbox *failure* is recorded apart from a letterbox *yes* — the letterbox fails open, so
collapsing them would hide the one number that says whether it earns its cost.

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
`_MODEL` / `_TIMEOUT_MS` · `SET_AGENT_SAFETY_NET=off` · `SET_AGENT_QUIET_MS` ·
`SET_AGENT_HEADLESS=1|0` (force/forbid the silent join; otherwise derived — see `store.headless`).
Relay side: `RELAY_SECRET` (required), `RELAY_HOST`, `PORT`, `RELAY_RETENTION_HOURS`,
`RELAY_DEVICE_TTL_DAYS`, `RELAY_LIMIT_*`, `RELAY_MAX_ROOM_*`.
