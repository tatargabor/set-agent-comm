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
import { basename } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"
import * as store from "../src/store.mjs"

const chunks = []
for await (const c of process.stdin) chunks.push(c)      // the stdin JSON has to be consumed
let payload = {}
try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* swallowed */ }

const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const agent = process.env.SET_AGENT_NAME || basename(cwd)
const room = process.env.SET_AGENT_ROOM

const out = { hookSpecificOutput: { hookEventName: "SessionStart" } }

if (room) {
  store.register({ agent, project: cwd, session: payload.session_id, room })

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
  const mine = store.busFile(room, agent)
  if (!existsSync(mine)) appendFileSync(mine, "")

  // We only watch what belongs to OTHERS — waking on our own writes would be a self-wake loop.
  const watch = store.busFiles(room).filter(p => basename(p) !== `${agent}.md` && existsSync(p))
  // ⚠ Whether directory watching is supported is UNVERIFIED. If Claude Code only accepts
  // files, this entry is at worst ineffective — the per-file watching lives independently
  // of it, so it cannot break anything.
  out.hookSpecificOutput.watchPaths = [dir, ...watch]

  const { unread } = store.inbox({ room, agent, advance: false })
  if (unread) {
    out.hookSpecificOutput.additionalContext =
      `[set-agent-comm] ${unread} unread message(s) in room "${room}". ` +
      `Read them with the \`inbox\` tool (or \`sac inbox ${room}\`) before touching the shared work.`
  }
}

process.stdout.write(JSON.stringify(out))
