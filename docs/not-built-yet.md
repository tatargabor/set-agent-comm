# Not built yet — the open ends of 2026-08-19

**Status: nothing here is built.** Written 2026-08-19, after the day that produced `sac dm`, the
seat-as-address rule, `store.wakingRooms` and the HTTP daemon's door (commit *"a seat name is a
complete address, and a room of two that behaves like one"*).

Every item below was reached deliberately and left, either because it needed a decision that was
not ours to make in that hour, or because building it would have been guessing. Each one says what
was **measured**, what it would take, and — where it matters — what would have to be decided first.
Retractions and dead ends stay visible, in the style of the other pages here.

---

## 1. A pair room is a boundary in the tools, not a secret

`assertMayRead` refuses `inbox` / `peek` / `history` to a third seat, and the room's name is not
listed to it either. That is the whole of it, and the limit is deliberate and stated in the code:

- the channel file sits on disk under the same user, so **any process of that user reads it**;
- `sac admin` — the operator's own screen — still shows it, on purpose;
- `sac stats` counts entries and characters in it for whoever runs the command (never the text,
  see the note above that loop, but the *volume* of a pair channel is visible).

⚠ **Why this matters and to whom.** set-core asked for the restriction because their agents run
inside CLIENT projects, where a stated rule says content may not leak anywhere else. They were told
plainly that this is a tool-level boundary. If that is not enough for their rule, the next step is
encryption at rest, and it is not a small one:

- `crypto.mjs` already does AES-256-GCM with a per-room key, for the relay. The primitive is there.
- What is **not** there is anywhere for a local key to live. `relays.json` (mode 600) holds room
  keys today, but only for bridged rooms, and it is written by an explicit `sac relay use`.
- The decisions to make first, none of them obvious: does the key live per pair or per seat; what
  happens to `sac admin` (an operator who cannot read the room is a different product); what
  happens to `sac stats`; and what a lost key means for a channel that is also the log.

**Do not build this because it sounds stronger.** Build it if somebody's rule needs it, and decide
the four questions above on that rule.

## 2. A DM does not cross machines

`sac dm` is local-only, and `docs/rooms.md` has carried the reason since 2026-08-08: `relays.json`
holds **one key per room**, so a bridged pair room would need its own key, and per-pair key
management has never been costed. Nothing here changed that.

One half of it *is* now done, and worth knowing before somebody re-opens the question: the pair
room's name is **slugged** (`store.dmRoom`), precisely so it survives a URL path — a seat name
carries `#`, and `bridge.mjs` puts a room name straight into `/rooms/<room>/entries`, where a `#`
would cut the path off at the fragment. So the naming obstacle is gone; the key one is not.

⚠ And a related latent bug, still unfixed: `bridge.mjs` interpolates the room name into that path
**without `encodeURIComponent`**. Harmless today (room names come from local config), and it is a
one-line change — but the relay's own parsing has to be checked against it in the same pass, so it
is not a drive-by.

## 3. The standing cost per agent is ~101 MB, and the transport is the smaller half

Measured on this machine, 2026-08-19, with `ps -eo pid=,rss=,args=` (the `pgrep -f` form returns
the shell wrapper — set-core lost two rounds to that, and it is worth repeating here):

| | |
|---|---|
| stdio MCP servers | 2 live, **mean 63.2 MB** |
| `sac wait` watches | 6 live, **mean 37.7 MB** |
| bare `node`, nothing imported | **51.7 MB** RSS |
| `+ src/store.mjs` | 54.5 MB (**+2.8 MB** — the zero-dep core is nearly free) |
| `+ the MCP SDK and tools.mjs` | 79.7 MB (**+25 MB**) |

So a fully wired agent costs about **101 MB standing**, and only ~62% of it is the MCP server.
set-core said the watch is the part that matters to them at fleet scale, and the numbers agree.

⚠ **The uncomfortable part: there is almost nothing to trim in our code.** `sac wait` imports the
core and no SDK; it is essentially node's own baseline. The only real lever is **fewer node
processes**, and that runs straight into how a wake-up is delivered: the Monitor's stdout line IS
the turn, so the process that prints it must be the one Claude Code started for that session. A
shared watcher daemon could do the *watching* for everybody, but something per session still has to
be alive to speak. Whether that something can be much cheaper than a node process is unmeasured —
and it is the question worth asking before anything else on this list.

## 4. The HTTP daemon has no lifecycle, and does not check anybody in

`sac http-token` closed the identity hole for framework-launched agents (`src/http.mjs`). What was
never built, because HTTP is **not** becoming the default:

- **No lifecycle.** No systemd user unit, nothing that starts it, nothing that restarts it, no
  answer to "who starts it on a fresh machine". `npm run http` in a terminal is the whole story.
- **It checks nobody in.** `stdio.mjs` calls `claimSeat` + `register` at startup; `http.mjs` calls
  neither, so an agent connected over HTTP does not appear in `agents`, has no seat, no liveness
  and no seeded membership **until its first `send`**. For a fleet view that is exactly backwards:
  the agents you most want listed are the ones that have not spoken yet.
- **Identity is a project, not a seat**, and it cannot be otherwise: measured the same day,
  `${CLAUDE_CODE_SESSION_ID}` in an MCP config is plain environment expansion — it yields the
  *parent's* id in a nested run and stays a literal `%24%7B…%7D` in a window a person opened. So
  two sessions on one HTTP endpoint share a file and a cursor, which is the 2026-08-04 failure
  seats exist to prevent. The framework case escapes this only because the framework invents one
  name per agent.

If the fleet route goes ahead, these three land together or not at all.

## 5. `sac admin` does not know about pair rooms

`src/admin-tui.mjs` has its own `wakesSeat` (line ~221), and it is now **wrong for a pair room**: it
returns false for a broadcast `FACT`, while `store.wakes` returns true there. The operator's screen
will under-report waking in exactly the rooms where every entry wakes somebody.

⚠ This is the thing CLAUDE.md warns about in as many words — *"`wakes()` is the single rule …; do
not re-implement it at a call site"* — and the admin view has quietly been a second implementation
for a while. The fix is not "add a pair check there"; it is to make that view call the one rule.
That is a real refactor, because `render(snap, ui)` is pure by construction and the rule needs the
room, so the room's pair-ness has to reach the snapshot.

## 6. Room hygiene: one archived, one waiting on a decision

Measured 2026-08-19 in `~/.local/share/set-agent-comm/channels`, and set-core's rule for reading it
is the right one: **emptiness marks an abandoned room, not silence.** `consumer-b` had been quiet
for two days while holding 164K from 21 writers — that is a pause, not a death.

- `consumer-e` — 0 writers, 0 entries: **archived** (and neither consumer-e project points at it;
  both are wired to `consumer-e-design`, so the SessionStart hook will not re-open it).
- `consumer-f` — 1 writer, 4K, effectively empty: **left alone**, pending a decision. It is not
  ours alone to retire.

The general form of this is worth having: `sac rooms` shows who is in a room, but nothing yet says
*"this room holds nothing reachable"* in one line. `sac admin` is the closest thing.

## 7. Small things noticed and left

- **`send` reports `wakes` per LIVE seat.** A pair room's other side being closed shows as an empty
  `wakes` with the "no session is running" notice — correct, but somebody will read it as the pair
  rule failing. Nothing to fix; something to know.
- **`participants()` now has two sources** (the agent-level room list and the seat-level one). It
  answers "who may be addressed", which is deliberately broader than `roomSeats`. A third source
  would be one too many — if something needs a narrower answer, it wants `roomSeats`.
