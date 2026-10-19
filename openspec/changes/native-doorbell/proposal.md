## Why

The only thing that wakes an idle session on this bus is `sac wait` inside a `Monitor`, and the
harness caps a Monitor at 30 minutes. Measured since 2026-09-22 (`docs/native-messaging.md`): the
watch woke its session 328 times, **229 of them expiries** (184 with no event at all), each a
re-read of the whole context — ~51M tokens in four weeks against 99 real messages. Every update of
this repo also kills every running watch, and each of those wakes its session once more. And a
session nobody armed a watch for is unreachable while idle, which is how 69% of "wake" decisions
in 21 days never reached a session.

Claude Code now binds an inbox socket per session. Measured live (Phase 0): a line posted into it
by an unrelated process wakes an idle `default`/`auto` session in ~2 s, arrives between tool calls
in a busy one, and is labelled as coming from another session — never as the user. A
bypass-permissions receiver holds it (and drops it at expiry) unless its `crossSessionInbound` is
`accept`.

## What Changes

- **Hooks record each seat's doorbell**: socket path (SessionStart, from
  `CLAUDE_CODE_MESSAGING_SOCKET`), permission mode (the mode the window started in at SessionStart;
  the live one from Stop and the watch guard, from `permission_mode` — measured: SessionStart's
  payload has none), and the effective `crossSessionInbound` of the settings that apply. One small file per seat,
  written only by that seat's own hooks.
- **`send` rings** every seat the rule wakes by direct address (or in a pair room): a short notice
  into its socket naming sender, room, type and first line, and telling it to read with `inbox`
  and answer with `send`. It rings only where the line would be delivered; a receiver in bypass
  mode without `accept`, or of unknown mode, is not rung.
- **The result says what happened per seat**: `rang`, and `notRung` with the reason and the
  fallback — the built-in `SendMessage` to `uds:<socket>` when sender and receiver are both in
  bypass mode (the harness's own parity rule), otherwise the Stop hook, plus the one-line setting
  that removes the gap.
- **A rung entry is not announced again by `sac wait`**, and a ring is recorded in the ledger as a
  wake-up (`how: "rang"`).
- **The watch is no longer asked for where the doorbell works.** SessionStart omits the arm line
  for a seat that can be rung and has no relay room, and a `PreToolUse` guard on `Monitor` declines
  an inbox watch for such a seat with the reason.
- **`npm run live`**: real `claude -p` sessions kept alive on stream-json input — not part of
  `npm test`.

## Capabilities

### New Capabilities
- `native-doorbell`: waking a seat through its session's own inbox socket.

### Modified Capabilities
(none written as specs before; the Stop hook and `sac wait` keep their behaviour for seats the
doorbell cannot reach)

## Impact

- `src/store.mjs` (doorbell records, `ringPlan`, rung marks), new `src/doorbell.mjs` (the socket
  I/O — async, so it stays out of the synchronous core)
- `hooks/session-start.mjs`, `hooks/heartbeat.mjs`, `hooks/stop.mjs`, new `hooks/watch-guard.mjs`
- `src/tools.mjs`, `bin/sac.mjs` (`send` rings; `wait` skips rung entries; `install` wires the guard)
- tests: `test/doorbell.test.mjs`; live: `test/live/doorbell.live.mjs`
