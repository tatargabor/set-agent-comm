## 1. Audible failures — independent, reversible, ship first

- [x] 1.1 `sac` warns on stderr when the environment holds an unrecognised `SET_AGENT_COMM_*` variable, naming the store directory actually in use; recognised variables stay silent (`cli-diagnostics`)
- [x] 1.2 Test: `SET_AGENT_COMM_HOME` set → the warning names it and names the real store path; stdout is unchanged so machine-readable output still parses
- [x] 1.3 `sac <subcommand> --help` prints that subcommand's usage and exits with no side effect; a room argument starting with `--` is a usage error, never a room name
- [x] 1.4 Test: `sac send --help` writes nothing to the store and prints the `send` usage — the regression that created the `--help` room

## 2. Read side — no behaviour change yet

- [x] 2.1 `store.roomExists(room)`: true if `rooms.json` names it **or** `channels/<room>/` exists (D2 fallback), so existing stores keep every room
- [x] 2.2 `store.members(seat)` / `store.setMembers(seat, rooms)` over `members.json`, using `ensureDir` — never `mkdirSync(recursive)`
- [x] 2.3 `store.seatPresence(seat)` → `{ live, quiet, until }` over `presence.json`; absent record means not quiet; an expiry in the past means not quiet, with no cleanup process required (D4)
- [x] 2.4 `seatState` keeps returning `true` / `null` / `false` unchanged — assert this in a test, so a later edit cannot quietly make it four-valued
- [x] 2.5 Test: a store with none of the new files behaves exactly as before across `send`, `inbox`, `agents`, `rooms`

## 3. Membership becomes per-seat

- [x] 3.1 Seed a seat's membership from `SET_AGENT_ROOM` **once**, on first check-in only; afterwards `members.json` is the truth and the environment is ignored for that seat (D3)
- [x] 3.2 `sac join <room> [--create]` and `sac part <room>` act on the calling seat and take effect without a restart
- [x] 3.3 `part` never deletes or alters the seat's entry file; `history` still reads back for everyone else
- [x] 3.4 `part` on the last room succeeds and states that this seat will now receive nothing
- [x] 3.5 Test: seat A parts `team`, seat B of the same project starts — B's membership is unaffected
- [x] 3.6 Test: a joined room survives a resume of the same seat, and the configured default does not remove it
- [x] 3.7 `sac rooms` lists, per room, the other member seats and their liveness — unknown never rendered as dead; a room with nobody else says so (H9)
- [x] 3.8 Test: `rooms` output names the other members and distinguishes their states

## 4. `quiet` — the fourth, declared state

- [x] 4.1 `sac quiet [--for <duration>] [--off]` writes the calling seat's presence; the response states when it ends
- [x] 4.2 `wakes()` excludes a quiet seat — in `wakes()` only, so the Stop hook, `sac wait` and `inbox` inherit it from the one rule (D5)
- [x] 4.3 Test: an entry addressed to a quiet seat omits it from `wakes`, does not block its turn, and is not announced by `sac wait`
- [x] 4.4 Test: a quiet seat still receives every entry through `inbox`, marked for it as before, and the cursor does not move while it is quiet
- [x] 4.5 Test: the letterbox is never consulted for a quiet seat — the rule excluded it first
- [x] 4.6 `send` reports a quiet addressee and its expiry in the response `notice`, at the moment of writing
- [x] 4.7 Test: `--to` a quiet seat produces the notice; `--to` a project whose live sessions are all quiet reports that it wakes nobody
- [x] 4.8 `agents` and the MCP `agents` tool report quiet distinctly — not `?`, not dead
- [x] 4.9 Admin TUI: quiet gets its own marker, and a quiet seat's backlog is reported apart from the reachable seats' totals; the read-only invariant is unchanged
- [ ] 4.10 Bridge: a remote seat's quiet travels; absent presence stays unknown, never quiet and never dead. **Not started.** The local half holds (an absent presence record reads as not-quiet, and liveness stays three-state), so the failure direction is already safe; what is missing is carrying the declaration across the relay
- [ ] 4.11 Test: unknown remote presence is not rendered as quiet or dead

## 5. Rooms must exist — the breaking step, last of the behaviour changes

- [x] 5.1 `send` into a room that does not exist fails at the writer, listing the caller's rooms and naming `--create` as the way to open one (H1)
- [x] 5.2 `send --create` creates the room, records creator and timestamp in `rooms.json`, enrols the caller, writes the entry, and says a new room was created; re-creation is idempotent
- [x] 5.3 Test: sending into `"tema"` while a member of `"team"` creates no `channels/tema/` and the error names `team`
- [x] 5.4 `sac install <room>` creates the named room **and** the project's own address room if absent, enrolling the seat in both (H2)
- [x] 5.5 Test: `sac install team` in project `web-app` yields both rooms; a re-run creates no duplicate and loses no membership
- [x] 5.6 The `room is required` error suggests the room when the `to` addressee is a member of exactly one of the caller's rooms; lists them without guessing when it is several (H5)
- [x] 5.7 Test: all three branches of 5.6 — narrowed to one, ambiguous, and no addressee at all

## 6. The ledger

- [x] 6.1 `store.recordDecision(...)` appends to `stats/<seat>.jsonl`: entry id, seat, decider (`rule` / `letterbox` / `net` / `quiet` / `letterbox-failed`), and which way it went (D6)
- [x] 6.2 A letterbox failure is recorded as the failure path, distinguishable from a letterbox that answered yes
- [x] 6.3 `sac wait` records a delivered wake-up when it announces; the Stop hook records a turn held open
- [x] 6.4 Recording never blocks, never throws, never prints; a failed append is dropped and the turn proceeds (D7)
- [x] 6.5 Test: an unwritable ledger changes nothing about delivery, waking or the turn, and prints nothing to the transcript
- [x] 6.6 Per-seat count ceiling applied oldest-first on append
- [x] 6.7 Test: a corrupt line is skipped by `stats` and fails no caller

## 7. `sac stats`

- [x] 7.1 `sac stats [room…] [--since <duration>]`: entries written, decisions by decider, wake-ups delivered, turns held open, characters delivered and clipped — per room, and per seat on request
- [x] 7.2 The output states the window the numbers actually cover, given the ceiling
- [x] 7.3 An empty ledger reports "nothing recorded yet" rather than a measured zero
- [x] 7.4 `stats` moves no cursor, marks nothing read, changes no room state — read-only by construction, like `sac admin`
- [x] 7.5 Test: 7.3 and 7.4 both asserted by reading the file system back

## 8. Cross-cutting and closing

- [x] 8.1 MCP surface: room-not-found, the room suggestion, and quiet in `agents` reach both faces with identical wording, from the core (D9)
- [ ] 8.2 Test: the same `send` failure through `sac send` and through the MCP tool names the same rooms. **The code is in place on both faces; only the cross-face test is missing** — `smoke-mcp.mjs` is where it belongs, since it already drives a real MCP server over stdio
- [x] 8.3 Add the dated, measured comment above every non-obvious branch introduced here — the field-notes reference and the number that put it there
- [x] 8.4 README: `quiet`, `join`/`part`, `stats`, `--create` in the CLI list; the limitations table updated where this change closes or moves an edge
- [x] 8.5 `docs/rooms.md`: note that per-seat membership now exists and is the piece the DM design was missing — without deciding whether a DM is a two-member room (design.md, open question 3)
- [ ] 8.6 Run the field-notes scripts (`docs/internal/scan.mjs`, `meta.mjs`, `verify.mjs`) against the live store after this lands, and record whether the measured failures actually stopped. **Cannot be done yet: the fixes have not been in front of live traffic.** Re-run in a week — that is the experiment, and running it early would only re-measure the old eight days
