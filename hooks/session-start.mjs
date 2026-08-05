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
import { existsSync, mkdirSync, appendFileSync } from "node:fs"
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
// `SET_AGENT_ROOM` may name several rooms, comma-separated — ALL of them are set up here.
// Registering only the first one would leave the second room's messages unwatched, which
// from the outside is indistinguishable from "nobody wrote anything".
const rooms = store.parseRooms(process.env.SET_AGENT_ROOM)

const out = { hookSpecificOutput: { hookEventName: "SessionStart" } }
const watchPaths = []
const notices = []

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
  mkdirSync(dir, { recursive: true })
  const mine = store.busFile(room, writer)
  if (!existsSync(mine)) appendFileSync(mine, "")
  // A seat name is good for ONE session, so every start leaves a file behind. The empty ones
  // of dead sessions go now — a file with even one entry in it is history and stays.
  store.pruneEmptySeats({ room, agent, keep: writer })

  // We only watch what belongs to OTHERS — waking on our own writes would be a self-wake loop.
  // "Others" now includes a SIBLING SESSION of this same project: its file is not ours.
  const watch = store.busFiles(room).filter(p => basename(p) !== `${writer}.md` && existsSync(p))
  // ⚠ Whether directory watching is supported is UNVERIFIED. If Claude Code only accepts
  // files, this entry is at worst ineffective — the per-file watching lives independently
  // of it, so it cannot break anything.
  watchPaths.push(dir, ...watch)

  const { unread } = store.inbox({ room, agent: writer, advance: false })
  if (unread) notices.push(`${unread} in "${room}" (\`sac inbox ${room}\`)`)
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
const SAC = join(HERE, "..", "bin", "sac.mjs")
const waitCmd = `SET_AGENT_NAME=${agent} node ${SAC} wait ${rooms.join(",")}`
const monitor = rooms.length
  ? ` ARM YOUR INBOX WATCH ONCE, now: Monitor({ command: "${waitCmd}", ` +
    `description: "agent-comm inbox", persistent: true }). Nothing else wakes you while you ` +
    `are idle at the prompt, so without it a message addressed to you waits until someone ` +
    `happens to write to you here.`
  : ""

if (notices.length || siblings || monitor) {
  out.hookSpecificOutput.additionalContext =
    `[set-agent-comm]` +
    (notices.length
      ? ` Unread messages: ${notices.join(", ")}. Read them with the \`inbox\` tool before ` +
        `touching the shared work.`
      : "") +
    siblings +
    (rooms.length > 1 ? ` You are in several rooms, so \`send\` requires an explicit \`room\`.` : "") +
    monitor
}

process.stdout.write(JSON.stringify(out))
