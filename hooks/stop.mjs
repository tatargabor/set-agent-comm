#!/usr/bin/env node
/**
 * Stop hook — the agent may not END ITS TURN while a message addressed to it lies unread.
 *
 * Wire it into the project's .claude/settings.json, next to the SessionStart hook:
 *   { "hooks": { "Stop": [ { "hooks": [ {
 *       "type": "command",
 *       "command": "SET_AGENT_ROOM=team node /path/to/set-agent-comm/hooks/stop.mjs" } ] } ] } }
 *
 * WHY THIS EXISTS — measured 2026-08-04 between two `consumer-a` sessions. Delivery worked: the
 * message was in the room, unread, with the right cursor. Nobody read it, because nothing told
 * the other session it was there. The push we believed in (`watchPaths` → `FileChanged`) does
 * fire while a session is idle, but it CANNOT start a turn — it only leaves context behind for
 * the next one. So there are two different gaps, and they need two different answers:
 *
 *   the agent is working  → THIS hook: it cannot finish the turn with unread mail
 *   the agent is idle     → `sac wait` inside a Monitor: that is what starts a new turn
 *
 * ⚠ It nudges ONCE per entry (see `shouldNudge`). Claude Code has no `stop_hook_active` field
 * to break a blocking loop, so a hook that blocked on every unread message would trap an agent
 * that does not read it. Blocking is a strong move: it may be used to say something NEW.
 */
import { basename } from "node:path"
import * as store from "../src/store.mjs"

const chunks = []
for await (const c of process.stdin) chunks.push(c)
let payload = {}
try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* swallowed */ }

const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const agent = process.env.SET_AGENT_NAME || basename(cwd)
const session = process.env.CLAUDE_CODE_SESSION_ID || payload.session_id || null
// LOOKUP, never a claim: a hook that merely looks may not create a session in the registry.
const writer = store.seatOf({ agent, session })

const pending = []
for (const room of store.parseRooms(process.env.SET_AGENT_ROOM)) {
  // `advance: false` — the hook does not read the message on the agent's behalf. Marking it
  // read here would be the worst outcome: the agent would never see what it was nudged about.
  const { unread, messages } = store.inbox({ room, agent: writer, advance: false })
  const last = messages.at(-1)
  if (!unread || !last) continue
  if (!store.shouldNudge({ room, agent: writer, ts: last.ts })) continue
  const who = [...new Set(messages.map(m => m.from))].join(", ")
  const preview = last.text.replace(/\s+/g, " ").slice(0, 200)
  pending.push(`${unread} in "${room}" from ${who} — last one (${last.type}): "${preview}"`)
}

// `decision: "block"` sends the agent back to work with the reason in hand. The room is named,
// so it does not have to guess which `inbox` to call.
process.stdout.write(JSON.stringify(pending.length
  ? {
      decision: "block",
      reason: `[set-agent-comm] Unread messages arrived while you were working: ` +
        `${pending.join(" · ")}. Read them with the \`inbox\` tool and answer before you stop. ` +
        `If it does not concern you, say so in the room — silence looks the same as not noticing.`,
    }
  : {}))
