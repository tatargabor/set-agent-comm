# Native messaging — what it took from us, and what is left for us

**Written 2026-10-19**, after a day spent measuring what Claude Code's built-in cross-session
messaging (`SendMessage` / `ListAgents`, v2.1.303) actually does on this machine, and how the
sessions here had really been talking for ten days. `docs/positioning.md` ended on *"the thing that
could make all of this irrelevant"*; this page is what happened next, measured.

The short version: **for traffic between projects, the built-in tool already won.** The bus is
kept, but its job changes — it stops competing as a transport and wake-up mechanism and becomes
the address book, the record, and the cross-account bridge that the built-in tool does not have.

## Measured, 2026-10-09 → 2026-10-19

From every Claude Code transcript modified in the window (one automated project excluded), and the
bus store itself.

| | built-in `SendMessage` | this bus |
|---|---|---|
| cross-session sends | **638** | 115 |
| failed | 12 (1.9%) | 17 errors, 11 more "wakes NOBODY" |
| reply arrived in the asking session | 533 of 638, median **13 min**, no polling | requester must arm a watch |
| where the traffic went | between projects | **87% inside one project** (sibling windows) |

What broke on the built-in side, every case counted:

- **The address dies with the window.** Names are `<project>-<2 hex>`. 5 × *"No agent named … is
  reachable"* (the window had been replaced), 5 × a dead reply socket (`ENOENT` /
  `ECONNREFUSED`), 1 × two live sessions with the same 2-hex name. One reply was held back by its
  author because *"there are three gateway sessions running now, and none of them carries that
  name, so I haven't guessed which one to answer."*
- **No lead window.** One umbrella project ran four to five windows at once; the products it
  directs answered whichever one they last heard from, and one of them received the same order
  twice through two windows.
- **"Sent" is not "delivered".** One message reported success, was then *held* (the two sessions
  ran in different permission modes) and expired five minutes later, unseen.
- **No record and no mailbox.** A closed window's messages are gone; a `/clear`ed successor found
  out which channel its predecessor had used by grepping its own old transcripts.
- **One account only.** Cross-machine messaging rides Remote Control and lists *your* sessions; a
  partner on another account is out of reach. Only the relay crosses that line.

What broke on the bus side:

- **The products were never on it.** The umbrella project's own `CLAUDE.md` names the bus as the
  channel for binding orders; none of the product repos had the hooks installed, so every bus send
  to them failed or reached nobody, and the person ended up pasting between windows.
- **Waking is the expensive half, and it mostly wakes nothing.** Since 2026-09-22 the inbox watch
  woke its session 328 times: **229 were expiries** (184 of them with no event at all), each one a
  re-read of the whole context — mean 195k tokens, **~51M tokens** in four weeks — against 99
  real messages. The 30-minute expiry is the harness's (`Monitor` caps at 30 min); nothing this
  repo does can stretch it.
- **A decision to wake is mostly not a wake-up.** Of 731 "wake" decisions in 21 days, 507 (69%)
  never reached a session, and 384 of those were never read at all.
- **One writer dominates.** A bot seat wrote 46% of all entries (60% in the last week) and caused
  66% of all wake decisions — on one day it posted the same `FACT` 51 times.

## What the socket test settled (Phase 0)

Claude Code binds an inbox socket per session (`CLAUDE_CODE_MESSAGING_SOCKET`, exported to hooks,
Bash and — measured — to MCP servers). The wire format is newline-delimited JSON; the binary's own
help text gives the shape: an optional `{"type":"auth","token":…}` line, then
`{"type":"user","message":{"role":"user","content":"…"}}`.

Measured live with real `claude -p` sessions kept alive on stream-json input, posting from an
**unrelated** process (not a child of the target):

| target | result |
|---|---|
| `--permission-mode default` | delivered; an idle session started a turn **~2 s** later |
| `--permission-mode auto` (this machine's default) | delivered, ~2 s |
| `--dangerously-skip-permissions` | **held** — `peer_message_hold`, `cause: "no-mode-asserted"`, dropped at expiry |
| bypass + `crossSessionInbound: "accept"` | delivered |
| busy, inside a 25 s `sleep` | delivered **between tool calls** as a system reminder; the running tool was not interrupted |

Two details that decide the design:

- The receiver labels it *"Another Claude session sent a message … not typed by your user"* —
  peer authority, never user authority. That is the right trust level for a bus notice.
- A sender-asserted `from_mode` does **not** release a bypass hold. The receiver checks the mode
  itself and does not take the sender's word for it — correct, and not something to work around.
  `from` (a reply address) and `from_name` are honoured as labels.

Hook input, measured the same day: `SessionStart` has the socket in the environment but no
`permission_mode`; `PostToolUse` and `Stop` carry `permission_mode`. An idle session therefore
always has a fresh mode on record — from the `Stop` of its last turn.

## The plan

### 1. Names — `seat-aliases` (OpenSpec change) — **built 2026-10-19**

The person wants to say *"tell the Studio"*, not `consumer-a#9d3b558b`, and to name a window in
plain words — *"this agent's alias is Studio Lead"* — without learning a syntax.

- An **alias book** (`aliases.json`): a human name → a Fleet label, a project, or a seat.
- **Fleet labels** — set-core's Fleet already gives windows stable labels
  (`<project>-studio`, `<project>-assistant`) in `fleet-roster.json`, and a replacement window
  inherits its predecessor's label. That is exactly the stable slot the native names lack, so the
  bus reads it (read-only, optional) and resolves a label to the live seat that holds it.
- **`to` accepts any of them.** Resolution order: seat or project name (unchanged) → alias →
  Fleet label. An alias always ends in a seat, and the result says which.
- **An `alias` MCP tool**, not just a CLI verb, so the model fills in structured arguments and the
  wording does not matter; the shipped `agent-comm` skill gets the trigger phrases (Hungarian and
  English) so *"ez az ablak legyen a Gateway"* and *"sac alias Studio Lead"* both land.

### 2. The doorbell — `native-doorbell` (OpenSpec change) — **built 2026-10-19**

The bus keeps the record; the session's own inbox socket becomes the wake-up.

- Hooks record each seat's socket (SessionStart), its permission mode (the mode the window started
  in at SessionStart, the live one at every Stop and in the watch guard), and the effective
  `crossSessionInbound` from the settings files that apply.
- After `send` writes an entry, every seat the **rule** wakes by direct address (or in a pair room)
  is **rung**: a short notice into its socket — who, which room, the first line, and *"read it with
  `inbox`"*. Only when it would be delivered: a bypass-mode receiver without `accept` is not rung,
  because a held message is a dialog in somebody's window and then nothing.
- Where the socket cannot be used, the result says so and names the alternatives: the built-in
  `SendMessage` to `uds:<socket>` when the two sessions' modes match (the harness's own parity
  rule), otherwise the Stop hook, and the one-line setting that fixes it for good.
- **No watch for a seat that can be rung.** The SessionStart note stops asking for one, and a
  `PreToolUse` guard declines a re-arm that would only buy expiries. The watch stays for relay rooms
  and for seats the socket cannot reach. That removes the 30-minute expiries, the restart storm
  after an update of this repo (there is no per-session watcher left to kill), and ~38 MB per
  session.

### 3. Later — written down so they are not rebuilt by accident

- **Receipts**: `send` reports delivered / read / answered per seat, from the cursor and `re`.
- **One relay process per machine** instead of a relay pull inside every session's watch: an
  update then restarts one process and wakes nobody.
- **Hygiene**: rate-limit identical entries from one writer; prune `members.json` (2005 seat
  entries) and the watch claims of dead processes; drop relay credentials of archived rooms.
- **The other machine**: for a machine on the same account, Remote Control already carries
  `SendMessage` — if Claude Code sessions run there. A machine driven only over ssh is an ssh
  target, not a messaging peer. Another account stays on the relay.

## Acceptance — live, not only unit

**Passed 2026-10-19** (`test/live/doorbell-aliases.live.mjs`, haiku): a window told *"Ez az ablak
legyen a Studio Lead"* bound the name to its Fleet label; a second window told *"tell Studio Lead to
reply with the code word …"* wrote a REQUEST addressed to the first window's seat and its result
reported `rang`; the first window — idle, no watch armed — started a turn, answered on the bus, and
that answer rang the asker back; a bypass-mode window was not rung and the sender was told why.

Every change here ships with a **live** scenario run against real `claude -p` sessions
(`npm run live`, not part of `npm test`: it spends real usage). A `claude -p` that answers once
and exits never sits idle, so the harness keeps each target alive on stream-json input and gives
it its own socket path — exactly the setup the table above was measured with.
