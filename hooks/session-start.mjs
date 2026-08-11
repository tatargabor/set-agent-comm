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
spawnSync(process.execPath, [join(HERE, "..", "bin", "sac.mjs"), "sync", ...rooms],
  { timeout: 2500, stdio: "ignore" })

for (const room of rooms) {
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
const waitCmd = `${ENV}${process.execPath} ${SAC} wait ${rooms.join(",")}`
const monitor = rooms.length
  ? ` ARM YOUR INBOX WATCH ONCE, now: Monitor({ command: "${waitCmd}", ` +
    `description: "agent-comm inbox", persistent: true }). Nothing else wakes you while you ` +
    `are idle at the prompt, so without it a message addressed to you waits until someone ` +
    `happens to write to you here.`
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
