## Why

Eight days of live traffic (462 entries, 9 rooms, 50 seats, 1082 tool calls — measured 2026-08-10,
`docs/internal/field-notes-2026-08-10.md`) surfaced nine distinct failures. Five of them share one
root cause: **every piece of state on this bus is derived, never declared.** A room is derived from
somebody writing into it, membership from an environment variable read at session start, presence
from a heartbeat, intent from an entry type. Derivation is cheaper and it is why the core has no
dependencies — but there is nowhere to put a fact that contradicts the derivation:

- a session that wants to **leave** the conversation looks identical to a dead one (measured, and
  the room said so out loud: *"a stopped watcher and a silent agent look the same from outside"*);
- a fourth session of a project cannot join a **different** room from the other three, because the
  room belongs to the project's `settings.json`;
- a mistyped room name is not an error, it is a **new, silent room you are alone in** — measured:
  a `--help` room exists in the live store, created by a probe that was trying to isolate itself
  and failed to, silently, twice over.

And one gap is independent of that: **the product here is the cost of attention, and there is no
number for it.** Every figure in the field notes is a proxy — we count `wakes`, never the turns
they produce. A project whose thesis is "being read is free, being woken is not" cannot demonstrate
that thesis, to a user or to itself.

## What Changes

- **Rooms become objects that are created on purpose.** `send` into a room that does not exist
  fails at the writer, listing the rooms that do — the same asymmetry already applied to a
  mistyped *addressee*. A new room requires `--create` or `sac install`. **BREAKING** for any
  caller that relies on join-on-write.
- **`sac install <room>` also creates the project's own address room** if it does not exist, so a
  project has a channel nobody had to guess the name of.
- **Membership becomes per-seat and mutable.** `sac join <room>` / `sac part <room>` act on the
  running session; `SET_AGENT_ROOM` becomes the *default* for a new seat rather than the whole
  truth. `sac rooms` shows who else is in each room — membership is visible from both ends.
- **Presence gains a fourth, declared state.** `sac quiet [--for <duration>]` marks a seat as
  deliberately silent: `wakes()` skips it, `inbox` still delivers to it, `agents` shows it as
  `quiet` (never as `?` and never as dead), and `send` tells the writer that the addressee is
  quiet and until when.
- **`sac stats`**: wake-ups and their consequences are recorded — by the Stop hook and by
  `sac wait` — and reported per room and per seat: entries written, how many were decided by the
  rule versus by the letterbox versus by the safety net, how many wake-ups resulted, and how many
  characters were delivered for reading.
- **Silent misconfiguration is made audible**: an unrecognised `SET_AGENT_COMM_*` variable prints
  one line naming the store actually in use, and `sac <subcommand> --help` prints that
  subcommand's usage instead of being taken as a positional argument.
- **The multi-room `room is required` error suggests the answer** when the addressee is a member
  of exactly one of the caller's rooms.

## Capabilities

### New Capabilities
- `room-membership`: what a room is, who is in it, how one is created, and how a seat joins or
  leaves — covering existence, per-seat membership, and two-way visibility.
- `seat-presence`: the declared presence states of a seat, including `quiet`, and how each affects
  waking versus delivery.
- `attention-stats`: recording what an entry cost — decisions, wake-ups, turns, characters
  delivered — and reporting it.
- `cli-diagnostics`: the CLI's obligation to fail audibly on misconfiguration and mistyped input,
  and to suggest the correction where it can be computed.

### Modified Capabilities
<!-- No existing specs in openspec/specs/ — this is the first spec-driven change in the repo. -->

## Impact

- `src/store.mjs` — room existence and creation, per-seat membership, presence state, the
  `wakes()` rule, the counters behind `stats`. This is the core every other face reads; the
  synchronous, dependency-free constraint holds.
- `bin/sac.mjs` — `stats`, `quiet`, `join`, `part`, `--create`, per-subcommand `--help`, the
  improved `send` errors, `rooms` output.
- `hooks/stop.mjs`, `hooks/session-start.mjs` — recording a wake-up and the turn it produced;
  membership defaults rather than membership truth.
- `src/tools.mjs` — the MCP surface must not drift from the CLI: `send` errors and the `agents`
  presence field.
- `src/admin-tui.mjs` — `quiet` as a fourth state, and the read-only invariant is unchanged.
- `src/bridge.mjs` — a remote seat's presence and room membership arrive over the wire; a remote
  `quiet` must not be inferred as dead.
- `docs/rooms.md` — the DM design depends on per-seat membership and must be reconciled with it,
  not designed around it separately.
- **Storage**: new files under `$SET_AGENT_COMM_DIR` (membership and presence records, a wake
  ledger). Existing stores must keep working with none of them present.
- **No new runtime dependency.**
