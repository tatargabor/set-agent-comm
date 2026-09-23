#!/usr/bin/env node
/**
 * SessionStart hook — check in to the registry + register the OTHERS' bus files with Claude
 * Code's native file watcher (`hookSpecificOutput.watchPaths`).
 *
 * Wire it into the project's .claude/settings.json:
 *   { "hooks": { "SessionStart": [ { "hooks": [ {
 *       "type": "command",
 *       "command": "SET_AGENT_ROOM=team node /path/to/set-agent-comm/hooks/session-start.mjs" } ] } ] } }
 *
 * WHY THIS IS THE POINT: on the original hand-kept channel the watching was done by a
 * hand-built apparatus (Monitor long-poll + a cron patrol + `pgrep`-based keep-alive), which
 * takes ~60 lines to describe in CLAUDE.md, with three separate measured lessons about how
 * `TaskList` and `pgrep` get it wrong — in BOTH directions (`TaskList` reports "no watcher"
 * for a running watcher → you blindly start a second one; `pgrep`'s hit count, meanwhile,
 * errs upward because of ephemeral child processes → you kill the live one). The framework
 * can do this natively.
 *
 * ⚠ We do NOT register a non-existent path: a silent no-op looks exactly like working
 * watching from the outside.
 */
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as store from "../src/store.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

const chunks = []
for await (const c of process.stdin) chunks.push(c)      // the stdin JSON has to be consumed
let payload = {}
try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* swallowed */ }

const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const agent = process.env.SET_AGENT_NAME || basename(cwd)
// The seat (which file THIS session writes) must be the same one the MCP server takes. The
// env var comes FIRST for exactly that reason: the MCP process only ever sees that one, while
// the hook also gets a `session_id` on stdin. Reading them in a different order would hand
// the two of them two different seats — and the session would then read its own file back.
const session = process.env.CLAUDE_CODE_SESSION_ID || payload.session_id || null
const writer = store.claimSeat({ agent, session })
/**
 * SILENT JOIN — see `store.headless`. A `claude -p` run gets checked in and nothing else: no
 * imperative it would spend turns obeying, and no watching it could not act on.
 *
 * ⚠ What it does NOT skip is the check-in itself. That is the 157 ms this hook was measured at,
 * and it is the entire point: a machine that is not in the registry cannot be written to, so
 * "join cheaply" and "do not join" are not the same answer. The line it is given names its seat,
 * because a run that decides to `send` has to sign it with a name that reaches back.
 */
const silent = store.headless()
// `SET_AGENT_ROOM` may name several rooms, comma-separated — ALL of them are set up here.
// Registering only the first one would leave the second room's messages unwatched, which
// from the outside is indistinguishable from "nobody wrote anything".
const rooms = store.parseRooms(process.env.SET_AGENT_ROOM)

const SAC = join(HERE, "..", "bin", "sac.mjs")
/**
 * THE ENVIRONMENT EVERY COMMAND THIS HOOK HANDS OUT HAS TO CARRY.
 *
 * The hook is given its settings on its own command line, and the shell the AGENT later runs a
 * command in inherits none of it. `SET_AGENT_NAME` was already passed for that reason;
 * `SET_AGENT_COMM_DIR` was not, and that is a silent defect.
 *
 * ⚠ Measured 2026-08-08, and it took a throwaway project to see it. A run under a non-default
 * store obeyed the "arm your inbox watch" line, and the watch it armed read the DEFAULT store —
 * it created an empty room directory there and sat watching it. Nothing failed. A watch pointed
 * at the wrong store is indistinguishable from a working one until a message does not arrive,
 * which is the exact failure mode this hook exists to remove.
 */
const ENV = (process.env.SET_AGENT_COMM_DIR ? `SET_AGENT_COMM_DIR=${process.env.SET_AGENT_COMM_DIR} ` : "") +
  `SET_AGENT_NAME=${agent} `

const out = { hookSpecificOutput: { hookEventName: "SessionStart" } }
const watchPaths = []
const notices = []
const backlog = []

/**
 * CATCH-UP for rooms that reach another machine: pull whatever arrived while no session was
 * watching. Before the unread count is taken, so the note at the top of the session tells the
 * truth about remote messages too.
 *
 * Time-boxed, and that is the whole point of the box: a slow or dead relay may not delay the
 * start of a session. Being cut off mid-pull is safe — `ingest` is idempotent and the cursor is
 * only saved at the end, so at worst the same entries are fetched again.
 */
// Computed before the sync below: an archived room is not pulled for either — ingest would
// re-create its channel directory, and a channel directory counts as a room.
const archivedHere = new Set(store.archivedRooms())

spawnSync(process.execPath,
  [join(HERE, "..", "bin", "sac.mjs"), "sync", ...rooms.filter(r => !archivedHere.has(r))],
  { timeout: 2500, stdio: "ignore" })

// A session start is the one hygiene moment this hook already owns, so the DM rooms whose both
// seats are provably gone are retired here (store.archiveDeadPairRooms — 2026-08-29, see
// docs/room-sprawl.md). This seat cannot be among the gone: it registered itself above, so any
// pair room it is still in counts as reachable and survives. Silent, like everything else in
// this hook — an archive able to fail a session start would be worse than the sprawl it fixes.
try { store.archiveDeadPairRooms() } catch { }

for (const room of rooms) {
  // ⚠ AN ARCHIVED ROOM IS NOT RE-OPENED, NOT EVEN BY THE CONFIG THAT NAMES IT — the same rule
  // `register` enforces in the roster (2026-08-29), enforced here too because the hook would
  // otherwise resurrect the room on its own: the `ensureDir` below creates a channel
  // directory, and a channel directory counts as a room. Said out loud once, so a seat that
  // finds itself with one room fewer knows it was the archive and not a failure.
  if (archivedHere.has(room)) {
    notices.push(`"${room}" is archived — not re-opened. Bring it back with ` +
      `\`${ENV}${SAC} rooms --restore ${room}\` if it is wanted again.`)
    continue
  }
  store.register({ agent, project: cwd, session, room, writer })

  // COLD START (measured on the day it went live). Two gaps, both of which would have
  // silently swallowed the FIRST message — precisely the one that opens the conversation:
  //
  //  1. an empty room has no files at all → there is nothing to put into `watchPaths`;
  //  2. the others would only learn about a NEW participant's file at their NEXT session
  //     start, because the list is assembled once, at startup.
  //
  // Hence: (a) we show up in the room with an empty file of our own — that is the "I am
  // here, this is where I write" announcement — and (b) we watch the DIRECTORY itself, so
  // that a new file appearing is an event too.
  const dir = store.channelDir(room)
  store.ensureDir(dir)
  const mine = store.busFile(room, writer)
  if (!existsSync(mine)) appendFileSync(mine, "")
  // A seat name is good for ONE session, so every start leaves a file behind. The empty ones
  // of dead sessions go now — a file with even one entry in it is history and stays.
  store.pruneEmptySeats({ room, agent, keep: writer })

  // A headless run stops here: checked in, therefore addressable, and that is all it asked for.
  // Watching is skipped for the same reason the imperatives are — `FileChanged` cannot start a
  // turn, so for a process that does one task and exits it is a watch nobody acts on, and this
  // hook's own rule is that a silent no-op must not be mistaken for working watching.
  if (silent) continue

  // We only watch what belongs to OTHERS — waking on our own writes would be a self-wake loop.
  // "Others" now includes a SIBLING SESSION of this same project: its file is not ours.
  const watch = store.busFiles(room).filter(p => basename(p) !== `${writer}.md` && existsSync(p))
  // ⚠ Whether directory watching is supported is UNVERIFIED. If Claude Code only accepts
  // files, this entry is at worst ineffective — the per-file watching lives independently
  // of it, so it cannot break anything.
  watchPaths.push(dir, ...watch)

  // ⚠ ONLY WHAT NEEDS AN ANSWER IS ANNOUNCED HERE (see `store.wakes`). A fresh seat routinely
  // inherits a large backlog — measured 2026-08-06: a session born at 09:56 was told "48 unread
  // FOR YOU" — and a number that large at the top of a session is not information, it is a wall.
  // The backlog is mentioned in one clause, without a call to action: it is history, and
  // `history` is what it is for.
  const { unread, unreadWaking } = store.inbox({ room, agent: writer, advance: false })
  if (unreadWaking) notices.push(`${unreadWaking} in "${room}" needing an answer (\`sac inbox ${room}\`)`)
  else if (unread) backlog.push(`${unread} in "${room}"`)
}

// ── the headless run's one line ───────────────────────────────────────────────
// It is told its name and nothing else — no count it cannot act on, and nothing to go and do.
// Two things it IS told, and both earn their characters: that the silence is deliberate (a run
// that knows the bus would otherwise wonder whether the hook had failed, and wondering costs the
// turn we just saved), and the one command it might want, spelled out in full.
//
// ⚠ Spelled out for the same reason the Monitor command below is: `sac` is not on the PATH of a
// non-interactive shell, and this project's rule is that an agent guessing at a command is an
// agent that silently does nothing. `send` needs no room argument in one room, and cannot be
// given a default in several — so the room is only named when there is exactly one.
if (silent) {
  const cmd = `${ENV}${process.execPath} ${SAC} send` +
    (rooms.length === 1 ? ` ${rooms[0]}` : " <room>") + " FACT '…'"
  if (rooms.length)
    out.hookSpecificOutput.additionalContext =
      `[set-agent-comm] Checked in as \`${writer}\` in ${rooms.map(r => `"${r}"`).join(", ")}, ` +
      `so other sessions can address you. This is a headless run, so the bus stays quiet: no inbox ` +
      `watch, no \`focus\` — do not arm either, nothing here is waiting for you. If you have ` +
      `something worth reporting: ${cmd}`
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

if (watchPaths.length) out.hookSpecificOutput.watchPaths = watchPaths

// The seat name is ANNOUNCED, even with nothing unread: the agent writes under a different
// name than the one the project is known by, and without being told it would sign its messages
// `consumer-a` in the text. If another session of the project is live, that is named too — that
// is the one it can now talk to.
const others = store.agents().find(a => a.agent === agent)?.seats
  ?.filter(s => s.live && s.writer !== writer).map(s => s.writer) || []
const siblings = writer !== agent
  ? ` On the bus your name is \`${writer}\` (not \`${agent}\`) — the suffix is your session id, ` +
    `so it says WHICH session you are.` +
    (others.length
      ? ` This project has ${others.length} other live session(s): ${others.join(", ")} — ` +
        `you receive each other's messages.`
      : "")
  : ""
/**
 * ARM THE MONITOR. This sentence is the weakest link of the whole chain, and it was missing
 * until 2026-08-05: `sac wait` in a Monitor is the ONLY thing that starts a turn in an idle
 * session (`watchPaths` → `FileChanged` runs while idle but cannot wake it), and nothing asked
 * the agent to arm it. A mechanism nobody switches on is indistinguishable from one that does
 * not exist — and that is exactly how a delivered message went unanswered for half an hour.
 *
 * The command is spelled out in full, with an absolute path: `sac` may not be on the PATH, and
 * an agent guessing at a command is an agent that silently does not watch.
 */
// `process.execPath`, not `node`: the Monitor runs this in a shell whose PATH we do not
// control — measured on macOS, where node sits under the home directory. And `ENV`, not just
// the agent name: see the note on it — a watch armed against the wrong store looks like a
// working one from every angle except the one that matters.
// ⚠ THE ROOMS GO IN THE ENVIRONMENT, NOT IN THE ARGUMENT LIST — 2026-08-19. Named as arguments
// they are an instruction to watch exactly those, resolved once when the Monitor is armed; a room
// the session joined afterwards (`sac join <room> --create`, which is what the skill tells it to
// do when a room is its own) was then watched by nothing at all, while `send` cheerfully reported
// that it had woken this seat. As an environment variable the same list is a SEED: `sac wait`
// re-reads `store.wakingRooms` on every check, so a join is picked up and a `part` drops out,
// and a seat whose own book is somehow empty still watches what the project configured.
// ⚠ AND IT IS A SIMPLE COMMAND — never wrapped in a `while` loop, however tempting. Tried and
// REVERTED the same day, 2026-09-12: `sac wait` exits on its own (source-stamp restart, age cap)
// and `persistent: true` was measured not to re-arm it, so a self-re-arming wrapper looks like the
// obvious fix. It is the opposite. `bash -c '<simple command>'` EXECS, so the watch's
// `PARENT = process.ppid` is the process the Monitor spawned it from; inside a loop bash FORKS,
// node's parent becomes the loop's own bash, and that bash is merely REPARENTED when the session
// dies. The "die with the session" guard then never fires and the age cap RESPAWNS the watcher
// instead of ending it — the measured 2026-08-06 orphan failure (five `sac wait` processes from
// dead sessions, notifications into a dead context, remote entries ingested off a cursor nobody
// advances) made permanent, and `claimWatch` cannot clear it because it only supersedes a watch of
// the same owner. `|| break` does not save it either: `break` returns 0, so the loop reports a
// clean finish even when the watch died on a bad room.
//
// The silent-self-exit gap is real, and it is closed where it belongs instead — `sac wait` now
// says on STDOUT that it stopped and asks for a fresh watch. See the note above `restart` in
// `bin/sac.mjs`: that line is actionable, which is exactly what the earlier stderr-only text was
// not.
const waitCmd = `${ENV}SET_AGENT_ROOM=${rooms.join(",")} ${process.execPath} ${SAC} wait`
// ⚠ `timeout_ms` IS NOT OPTIONAL, AND THE NUMBER IS THE POINT. The Monitor tool caps a watch
// at 30 minutes and DEFAULTS to five, so a line that omits it asks a literal-minded agent to
// wake ~288 times a day instead of ~48. Every expiry wakes an idle session, and `bin/sac.mjs`
// already states the price above `wait`: "a Monitor notification to an idle session pays for
// the whole context again".
//
// Measured 2026-09-23 from one project's `.claude/logs/context-guard.jsonl`, 196 wake-ups since
// 2026-09-16: **38,150,258 tokens of re-read context, ZERO messages** — 47 expiries and 8.9M
// tokens on an average full day. The cost scales with the session's context (mean 194,644 here),
// so it is worst exactly in the long sessions this bus exists to coordinate.
//
// ⚠ The 30-minute cap is the HARNESS's, not this project's, and the same log dates it: the gap
// between wake-ups was a 103-minute median on 09-12 and has been 30.1 minutes every day since
// 09-16 — with no commit here between 09-13 and 09-18. `sac wait` still has its own 12h age cap
// (08-29) and `persistent: true` was measured not to re-arm (09-12); neither is the cause. What
// this file CAN control is the number it asks for and what it says about the expiry.
//
// The second sentence matters as much as the number. Arming is a one-off; EXPIRY repeats for
// the life of the session, and the reflex on an expiry notice is to re-arm. That reflex is
// what produced the 27. The cheap delivery is named here so the agent can weigh it instead of
// reaching for the expensive one: the Stop hook reports unread mail at the end of every turn,
// into a context that is already loaded — the same asymmetry `sac.mjs` measured on 2026-08-27
// ("The second delivery is the cheap one").
const monitor = rooms.length
  ? ` ARM YOUR INBOX WATCH ONCE, now: Monitor({ command: "${waitCmd}", ` +
    `description: "agent-comm inbox", timeout_ms: 1800000, persistent: true }). Nothing else ` +
    `wakes you while you are idle at the prompt, so without it a message addressed to you ` +
    `waits until someone happens to write to you here. Keep that timeout_ms: the tool's own ` +
    `default is 5 minutes, and every expiry wakes you and re-reads your WHOLE context ` +
    `(measured over 3 full days: 47 expiries a day, 8.9M tokens a day, zero messages). When it EXPIRES, re-arm ` +
    `only if this session will sit idle and someone is actually waiting on you — the Stop hook ` +
    `already reports unread mail at the end of each turn, in a context that is already loaded.`
  : ""

if (notices.length || backlog.length || siblings || monitor) {
  out.hookSpecificOutput.additionalContext =
    `[set-agent-comm]` +
    (notices.length
      ? ` Waiting for you: ${notices.join(", ")}. Read it with the \`inbox\` tool before ` +
        `touching the shared work.`
      : "") +
    (backlog.length ? ` Unread but not urgent: ${backlog.join(", ")}.` : "") +
    siblings +
    (rooms.length > 1 ? ` You are in several rooms, so \`send\` requires an explicit \`room\`.` : "") +
    monitor +
    // The habit is cheap to start and expensive to retrofit: an undeclared focus is what makes
    // both the letterbox and every other session guess at what this window is doing.
    (rooms.length ? ` When you start a piece of work, say so once with the \`focus\` tool ` +
      `(one sentence + the paths) — the others read it instead of asking, and the inbox watch ` +
      `uses it to decide what is worth interrupting you for.` : "")
}

process.stdout.write(JSON.stringify(out))
