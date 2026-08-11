## Context

Everything on this bus is **derived**. A room is derived from somebody writing into it; membership
from `SET_AGENT_ROOM`, read out of the project's settings at session start; liveness from a
heartbeat; intent from an entry type. That is why `src/store.mjs` has no dependencies and is
synchronous — there is nothing to reconcile, only to compute.

Eight days of live traffic (`docs/internal/field-notes-2026-08-10.md`) found the boundary of that
approach. Five of nine measured failures are the same shape: **a fact that contradicts the
derivation has nowhere to live.** A session that wants to leave, a session that belongs in a
different room from its siblings, a room that was never meant to exist. And one gap is orthogonal:
the ledger this project's whole thesis rests on does not exist, so every number in the field notes
is a proxy.

Constraints that do not move:

- `store.mjs` stays **synchronous and dependency-free** — hooks and cron import it where there is
  no `node_modules` and no event loop.
- **One file, one writer, append-only. No lockfile** — a dead session's lock stays stuck forever.
- **`isForMe` ≠ `wakes`**, and `wakes()` remains the single rule every consumer reads.
- **Never `mkdirSync(…, { recursive: true })`** — `store.ensureDir` instead.
- Anything on the hot path (the PostToolUse hook, the Stop hook, the long poll) **never blocks,
  never throws, never prints**.
- Existing stores must keep working with none of the new files present.

## Goals / Non-Goals

**Goals:**

- A room exists because someone created it, and a mistyped name is an error rather than a new,
  silent room.
- Membership is a property of the **seat**, changeable at runtime, visible from both ends.
- `quiet` — a fourth, **declared** presence state that suppresses waking and nothing else.
- A ledger of waking decisions and their consequences, and `sac stats` over it.
- Misconfiguration and mistyped input fail **audibly**.

**Non-Goals:**

- DMs and the pairwise channel (`docs/rooms.md`). This change makes them possible by giving
  membership somewhere to live; it does not build them.
- Wiring `src/policy.mjs` to anything.
- Any change to the entry format on disk, or to the relay protocol.
- A daemon, or anything that answers when no session is open.
- Per-thread unread state. A room stays flat.

## Decisions

### D1 — Four small files, not four more keys in `registry.json`

New state lives in `$SET_AGENT_COMM_DIR`:

| file | holds | written by |
|---|---|---|
| `rooms.json` | room existence: name, creator, created-at | whoever creates a room |
| `members.json` | seat → rooms | the seat itself |
| `presence.json` | seat → `{ quiet, until }` | the seat itself |
| `stats/<seat>.jsonl` | the decision ledger, append-only | that seat only |

**Why not `registry.json`:** it is rewritten whole on every `register()`, and the heartbeat work
already measured that as a lost-update race across concurrent sessions — which is precisely why
the heartbeat rate-limits to 60 s. Membership and presence change at moments a person chose, and
must not be lost to a concurrent check-in.

**Why the ledger is per-seat JSONL:** it is the same invariant as the channel — one file, one
writer, append-only, no lock. It is also the only shape where a hook can append on the hot path
without reading anything first.

*Alternative rejected:* one shared `stats.jsonl`. Every seat appending to one file is the lost
update the channel design exists to avoid, and it would need the lock we refuse to have.

### D2 — Room existence falls back to the channel directory

A room exists if `rooms.json` names it **or** `channels/<room>/` is present. Existing stores
therefore keep every room they have, with no migration step and no dated file to write.

*Alternative rejected:* a migration that writes `rooms.json` from the directory listing on first
run. It is a write to a shared file triggered by an arbitrary process, and it would have to be
right the first time on a store we cannot see.

### D3 — `SET_AGENT_ROOM` seeds a seat once, and never again

On first check-in a seat with no `members.json` record is seeded from the configured rooms.
Afterwards the record is the truth, and the environment is ignored for that seat.

This is what makes `part` survive the next tool call: without it, any hook run would restore the
configured rooms and silently undo what the person asked for.

*Consequence, stated:* changing `SET_AGENT_ROOM` in a project's settings no longer affects seats
that already exist. New sessions get the new default. This is the intended direction — it is
exactly the property that lets a fourth session live in a different room.

### D4 — `quiet` is a new function, not a fourth return value of `seatState`

`seatState` keeps answering `true` / `null` / `false`, and `null` keeps meaning "we do not know".
A new `seatPresence(seat)` returns `{ live, quiet, until }`, and `wakes()` reads it.

**Why:** every existing consumer of `seatState` treats the three values distinctly and correctly.
Adding a fourth value would silently reclassify a quiet seat as something else in every one of
them — the exact failure mode the three-state rule exists to prevent.

### D5 — `wakes()` reads presence; nothing else changes

Quiet is applied in exactly one place, because `wakes()` is the single rule the Stop hook,
`sac wait` and `inbox` all read. Delivery, cursors, `isForMe` and the letterbox are untouched: a
quiet seat's letterbox is never consulted, because the rule already excluded it before the model
would have been asked. That is a cost saving, not a behaviour change.

### D6 — The ledger records decisions where they are made, wake-ups where they are delivered

Two different facts, recorded in two different places, and the gap between them is the number
worth having:

- **decision** — written by whatever evaluated the entry (`wakes()`'s caller, the letterbox, the
  net);
- **delivery** — written by `sac wait` when it announces, and by the Stop hook when it blocks.

A decision with no matching delivery means a seat that was judged worth waking and had no watcher
armed. That is the *"weakest link in the chain"* from the README, and this is the first time it
would produce a number.

### D7 — Recording fails silent, and is bounded by count per seat

Same rule as the heartbeat: never block, never throw, never print. A failed append is dropped.
`stats` skips unparseable lines rather than failing.

The ceiling is per-seat and by count, checked on append, oldest-first. Not by time: the measured
runaway case here is one project minting ~27 seats an hour, which a time window does not bound.
`stats` prints the window its numbers actually cover.

### D8 — `--create` is a flag on `send` and `join`; there is no `sac room new`

A room is created by the act that needs it, made explicit. This keeps the CLI at its current size
(the field notes' explicit warning about the 40+ command competitor) and puts the decision where
the mistake happens.

### D9 — Every new error and state crosses to MCP through `tools.mjs`

The two faces sit on one core so they cannot disagree. The `--help` and env-warning work is
CLI-only by nature; everything else — room-not-found, the room suggestion, quiet in `agents` — is
core behaviour and reaches both faces without being written twice.

## Risks / Trade-offs

- **Refusing join-on-write is a breaking change.** → The fallback in D2 means no existing room
  breaks. What breaks is a script that opened a room by writing into it; that is the behaviour
  being removed on purpose, and the error names `--create`.
- **Two more file reads on the hot path.** `wakes()` gains `presence.json`; `send` gains
  `rooms.json`. → Both are small JSON files the process already opens siblings of; the store is
  synchronous by design and this is the same order of cost as `cursors.json`.
- **The ledger grows on the busiest path there is.** → Per-seat file, append-only, capped by
  count, fail-silent. Worst case it is dropped, and nothing above it notices.
- **`stats` could become a way to snoop on a room.** → It reports decisions and volumes, never
  entry bodies, and it moves no cursor. Same read-only-by-construction rule as `sac admin`.
- **Per-seat membership makes `SET_AGENT_ROOM` weaker than people expect.** → D3 states the
  consequence; `rooms` shows the seat's actual membership, so the truth is one call away.
- **A remote seat's quiet depends on the bridge pulling.** → Absent presence stays *unknown*, never
  quiet and never dead, per the spec. The failure direction matches the existing three-state rule.
- **Scope: this is nine measured fixes in one change.** → They are one change because five of them
  share the root cause; the tasks are ordered so the small audible-failure fixes (H3, H4) land
  first and independently.

## Migration Plan

1. Ship the read side first: room existence with the D2 fallback, `seatPresence` defaulting to
   "not quiet", `stats` reporting an empty ledger honestly. Nothing changes behaviour yet.
2. Ship the audible-failure fixes (env warning, subcommand `--help`, the room suggestion). These
   are independent and reversible.
3. Ship recording. Still no behaviour change — only the ledger fills.
4. Ship `quiet`, `join`/`part`, and last the refusal to create a room implicitly, because that one
   is the breaking step and wants the others already in place.
5. **Restart what polls.** `sac wait` and the MCP server load their code at startup and both
   ingest remote entries; after this lands they must be restarted, or they will write
   pre-change decisions into an append-only ledger.
6. Rollback: delete the new files. The D2 fallback and the "not quiet by default" rule mean an
   older binary reads a newer store without error.

## Open Questions

1. **Does `part` remove the seat from `agents` for that room?** Its entry file stays (history is
   never deleted), so it is still a writer in the room's past. Leaning: shown, marked as having
   left — a reader who sees the entries should be able to see why no answer is coming.
2. **Does `quiet` survive a `--resume`?** A resumed session gets its seat back. Leaning: yes,
   because it was a person's decision about that seat, and re-declaring it is a turn.
3. **Is a DM a room with two members, or a different object?** `docs/rooms.md` leaves this open,
   and per-seat membership is the piece it was missing. This change must not foreclose either
   answer — hence no assumption that membership is symmetric.
4. **Does the ledger record entry ids or hashes?** Ids are `sha256(writer|ts)` and predictable;
   storing them makes `stats` joinable with the channel. Leaning: yes, ids — but this is the one
   place where a stats file starts to say *what* was said, and that deserves a second look.
