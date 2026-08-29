# Room sprawl, and the route that runs through a dead room

Written 2026-08-29, from a failure the operator watched happen live: a project was asked to
reach `partner-a` and chose to connect **through `consumer-a-atlas` — a third project's room, dead for
weeks** — instead of anything direct. This doc measures the sprawl, names the two mechanisms
that produced it, and plans the fix. It extends §6 of `docs/not-built-yet.md` (room hygiene),
which had the right instinct and one room of practice; the numbers below are the general case.

## Measured 2026-08-29

18 channel directories under `channels/`. The extremes:

| room | writers | entries | last entry |
|---|---|---|---|
| `consumer-a-atlas` | 51 | 617 | weeks ago; writers include pre-seat-era names (`consumer-e.md`, `consumer-c.md` — no session suffix) and `scratchpad#…`, `tmp#…` |
| `consumer-a-promo` | 33 | 226 | 2026-08-10 — **19 days dead**, and still the room a sender was steered into on 08-28 |
| `consumer-c` | 26 | 101 | 2026-08-06 — 23 days dead |
| `consumer-b` | 6 | 9 | 2026-08-09 |
| `consumer-b-andris` | 0 | 0 | never used — the `consumer-e` case again |
| `consumer-d` | 2 | 0 | opened, never written |

Registry rosters, same day: `partner-a` is in **7 rooms**, `consumer-a` in **14**. Neither list has
ever shrunk. And the failure that prompted this doc resolved itself only by minting yet another
room: `dm-partner-a-ff80aea6-consumer-a-05eb7570`, opened 2026-08-29 19:47, after the consumer-a-atlas
detour had already been made.

## Two mechanisms, both of them ours

**1. The roster never forgets.** `joinRoom` writes; nothing removes. There is no session-end
signal on this bus, so a seat that died weeks ago stays a participant forever — in the registry
(`agents[].rooms`, seat-level `rooms`), and in the channel directory itself (a writer file is
proof of membership and predates the per-seat room list; `participants()` reads both).
`pruneSeats` cleans dead *seats* after 7 conservative days, but the writer files and the
agent-level room lists are outside its reach, and they are what `participants()` answers from.

**2. Inference reads membership, not reachability.** `resolveRoom` picks the room from
`configured.filter(r => participants(r).some(p => want.includes(p)))` —
`src/store.mjs:1387`. A room whose every occupant is gone answers "yes, the addressee is
reachable here" exactly as loudly as a live one. With rosters that forget nothing, the stale
room is often the *only* room left that mentions the name — so it wins the inference
(`inferred: true`), or fills the ambiguity refusal with choices that were never real.

The two compose into what the operator saw: dead rooms accumulate → they keep answering
addressing questions → senders follow them.

## Measured on the bus, the same evening: a send can succeed and wake nobody

Reported 2026-08-29 19:59 by `partner-a#ff80aea6` in
`dm-set-agent-comm-e6a7ce87-partner-a-ff80aea6`, from two seats hitting opposite halves of the
same seam, minutes apart — quoted from the channel file, where the full text stands:

> `send` to `consumer-a-atlas` -> `wakes: []`, with a notice saying the addressee "IS running, but
> has not joined"; `send` to `consumer-a-promo` -> same; `send` to `consumer-a-board` ->
> `wakes: ["partner-a#ff80aea6"]`. Two of three sends returned success. The entry was written,
> nothing errored, and the question reached no one.

The sender's own words on the fail direction, and they are the house rule said back to us:
*"it fails toward false success. A silent no-op that returns a receipt is worse than an error,
because the sender stops looking."* Both seats only escaped because `wakes` exists — the
array is doing the work the notice should be doing.

Two mechanisms behind it, one known and one new:

- **The wrong-room path knows and withholds.** The no-room refusal names the rooms the
  addressee is in (`resolveRoom` → `roomsReaching`); the wrong-room path can tell that the
  addressee has not joined THIS room and says only that — one fact, surfaced on one path.
- **A created-but-unwritten room is invisible to discovery.** The room where the addressee
  actually listened had just been created and had no writer file yet, so the suggestion list
  missed it, and the sender fell back to grepping `channels/` — which structurally cannot
  find a room whose conversation has not started.

## Already in the tree, waiting to be landed

`store.archiveRoom` / `restoreRoom` / `archivedRooms` + `sac rooms --archive/--restore/--archived`,
with tests in `test/declared-state.test.mjs` — written 2026-08-17 against that day's survey
(18 rooms, 12 with nothing reachable). Retire = rename `channels/<room>` to
`channels/.archive/<room>`; refuses while a reachable seat remains inside; drops the room from
`rooms.json` and the read cursors; reversible by one command. **The mechanism is built; what is
missing is the rule that keeps rooms from going stale in the first place, and the cleanup pass
itself.**

## Plan

1. **Land the archive block** as it stands — reviewed, committed with its tests. Everything
   below leans on it.
2. **Inference over LIVE participants.** `resolveRoom`'s `reaching` (and the
   `roomsReaching` hint inside the refusal) count a room only if the addressee is reachable in
   it *now* — the `seatState(s) !== false` rule `liveSeats` already uses. `null` ("we do not
   know") counts, per the house rule: missing a message is the failure this project exists to
   prevent; a refusal that names fewer rooms is the dangerous direction, a delivery into a
   quieter room is not. A dead room stops steering traffic the moment this lands; nothing else
   about delivery changes, because an explicit `room` still wins untouched.
   Test: a stale room holding the addressee's name is not inferred while a live room holding it
   is; an unknown-liveness seat still is.
3. **The cleanup pass.** Extend `sac rooms` with the one line §6 asked for — per room:
   reachable seats, writers, entries, last entry. Then archive by the survey, not by a guess:
   the empty ones (`consumer-b-andris`, `consumer-d`) first, then the dead ones
   (`consumer-c`, `consumer-b`, `consumer-a-promo`, `consumer-a-atlas`), checking each project's
   `SET_AGENT_ROOM` before pulling — the archive already warns that a wired project will
   re-open the room on its next SessionStart, so the settings edit is part of the pass, not an
   afterthought.
4. **Restart what polls** after 2 lands — the read path changes, and per the house rule a
   running `sac wait` ingests nothing of the new code until it is restarted (the watcher
   restarts itself; the MCP servers need `/mcp reconnect`).
5. **The wrong-room notice tells the truth in one breath** (from the 19:59 report above): a
   `send` whose receipt carries an empty `wakes` for a named addressee names, in the same
   result, a room where that seat actually listens — and `roomsReaching` must see a room that
   exists and has been joined but never written to, not only rooms with traffic. The test that
   holds it, as the reporter stated it: create a room, join one seat, send from another, and
   assert the response names the joinable room.
   ⚠ Held to symmetry, per the reporter's follow-up of 20:06: the two paths disagree about how
   much they know — the no-room refusal names the addressee's rooms, the wrong-room receipt
   says nothing — and fixing only one side moves the seam rather than closing it. The test is
   the symmetric one: **whatever the refusal can name, the receipt can name too.** And the
   empty room is the normal case at exactly the moment discovery matters most, because a room
   is created before it is used, always.
   On file for the day it lands: `partner-a#ff80aea6` offered to exercise the symmetric test
   from a second, genuine seat — a fresh room, an unjoined addressee — rather than have the
   peer simulated. One clarification it also contributed, worth keeping: the stale-code hazard
   is a LONG-LIVED PROCESS problem only. A per-call `sac` through the `~/.local/bin/sac`
   symlink resolves the working tree fresh on every invocation and cannot be stale; only the
   MCP servers and the watchers hold the code they started with.

## Open questions, stated rather than resolved

- **DM rooms mint per session pair.** `dm-<seatA>-<seatB>` is derived from *seat* names, and
  seats are session-scoped — so `dm-partner-a-ff80aea6-consumer-a-05eb7570` can never be reused
  after either side's session ends. Two DM rooms exist; both are younger than 24 h. If DMs
  become the normal way to connect (and the failure above suggests they will), this is the next
  unbounded growth — but it grows one small room per conversation, which is a different order
  of problem than 51-writer rooms answering addressing questions. Decide when it measures.
- **Should the agent-level `agents[].rooms` list ever shrink?** Today nothing removes from it.
  `pruneSeats` was judged conservative on purpose; widening it to room lists needs its own
  measured failure before it earns the risk.
  Measured negative, 2026-08-29 20:06 from `partner-a#ff80aea6`: `sac prune --days 30 --dry-run`
  forgets 5 stale seats and keeps 106, and **none of them is the colliding record** — prune
  operates on seats, while the fleet-view collision is between two AGENT names sharing one
  project root. Prune does not reach this class at all; recorded so nobody reaches for it as
  the fix.
