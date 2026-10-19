## Context

Phase 0, measured 2026-10-19 with real `claude -p` targets on stream-json input and a private
`--messaging-socket-path`:

| target | posted line |
|---|---|
| default / auto | delivered, idle session woke in ~2 s |
| bypass | held (`cause: no-mode-asserted`), dropped at expiry |
| bypass + `crossSessionInbound: accept` | delivered |
| busy (inside a tool call) | delivered between tool calls |

A sender-asserted `from_mode` does not release a bypass hold — the receiver verifies. Hook stdin:
SessionStart has no `permission_mode`; PostToolUse and Stop do. MCP servers inherit
`CLAUDE_CODE_MESSAGING_SOCKET`.

## Goals / Non-Goals

**Goals:** wake an idle seat without a per-session watcher; never cause a held-message dialog;
say per seat what happened.

**Non-Goals:** relay rooms (their entries still arrive through a pull, so their watch stays);
asserting a permission mode we do not have; replacing the Stop hook.

## Decisions

- **D1 — A file per seat** (`doorbells/<seat>.json`), written only by that seat's hooks. The Stop
  hook fires every turn; putting this in the shared registry would reintroduce the lost-update race
  the heartbeat rate-limits against.
- **D2 — Ring only what the rule already wakes by direct address or in a pair room.** Broadcast
  QUESTION/REQUEST to a room stays with the letterbox and the watch: ringing every seat of a room
  for a broadcast is the storm the letterbox exists to stop.
- **D3 — Deliverability is decided before posting, from what the receiver recorded.** `refuse` or
  `hold` → no. `accept` → yes. Otherwise by mode: `default`, `auto`, `acceptEdits`, `dontAsk` → yes;
  `bypassPermissions`, `plan`, unknown → no. A failed connect (`ENOENT`, `ECONNREFUSED`) marks the
  record stale.
- **D4 — The ring is a notice, not the message.** Who, which room, the type, the first ~200
  characters, and the instruction to read with `inbox` and answer with `send` — so the reply and
  the record stay on the bus. `from_name` carries the sender's name; no `from`, so the receiver is
  not offered a native reply that would bypass the record.
- **D5 — Ringing does not spend the Stop hook's nudge.** If the receiver ignores the ring, the Stop
  hook still blocks once at the end of its turn — the second delivery is the cheap one.
- **D6 — Busy receivers are rung too.** The line lands between tool calls in a loaded context; that
  is the cheap delivery `seatBusy` was protecting, not the expensive one.
- **D7 — The socket I/O is `src/doorbell.mjs`** (async, `node:net` only). The core stays
  synchronous and dependency-free; it only decides (`ringPlan`) and records.

## Risks / Trade-offs

- The socket format is not documented beyond the auth line; the live test is the guard and runs
  before any release.
- Settings precedence is approximated (any `refuse` wins, then `hold`, then `accept`); a wrong
  `accept` reading would cause a held dialog — so only an explicit `accept` counts.
