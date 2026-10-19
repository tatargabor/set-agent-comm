#!/usr/bin/env node
/**
 * PreToolUse hook on `Monitor` — declines an inbox watch that would only buy expiries.
 *
 * WHY THIS EXISTS — measured since 2026-09-22 (docs/native-messaging.md): the inbox watch woke its
 * session 328 times, 229 of them expiries (184 with no event at all), each a re-read of the whole
 * context — ~51M tokens in four weeks against 99 real messages. The harness caps a Monitor at 30
 * minutes, and the reflex on an expiry notice is to re-arm; a sentence asking the agent not to was
 * already in the SessionStart note and in the watch's own stop line, and the expiries kept coming.
 * A rule that has to be remembered under load is a rule that will be forgotten, so it became a
 * mechanism.
 *
 * Where the doorbell works (`store.ringable`), the sender wakes this session through its own
 * inbox socket and the watch adds nothing. Relay rooms still need it — their entries arrive only
 * through a pull, and the watch is what pulls — so a seat in one is never declined.
 *
 * IT NEVER BLOCKS ANYTHING ELSE AND NEVER THROWS. Any doubt — an unparsable payload, a Monitor
 * that is not ours, a seat with no doorbell — ends in silence, which lets the call through.
 */
import { basename } from "node:path"

const chunks = []
for await (const c of process.stdin) chunks.push(c)

try {
  const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}")
  const command = String(payload?.tool_input?.command || "")
  // Ours: `sac wait` / `bin/sac.mjs wait`, however the path is spelled.
  if (payload.tool_name === "Monitor" && /(^|[\s/])sac(\.mjs)?\s+wait(\s|$)/.test(command)) {
    const store = await import("../src/store.mjs")
    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const agent = process.env.SET_AGENT_NAME || basename(cwd)
    const session = process.env.CLAUDE_CODE_SESSION_ID || payload.session_id || null
    const seat = store.seatOf({ agent, session })
    // The live mode rides on this payload too — record it, it is the freshest there is.
    if (typeof payload.permission_mode === "string") store.setDoorbell(seat, { mode: payload.permission_mode })
    const bell = store.ringable(seat)
    // The rooms this watch would cover: an explicit list after `wait`, else the seat's own book.
    const named = command.split(/\s+wait\s+/)[1]?.split(/\s+/).filter(a => a && !a.startsWith("-")) || []
    const envRooms = store.parseRooms(command.match(/SET_AGENT_ROOM=(\S+)/)?.[1])
    const rooms = named.length ? named : store.wakingRooms(seat, envRooms)
    const bridge = await import("../src/bridge.mjs")
    const relayed = rooms.filter(r => bridge.roomConfig(r))
    if (bell.ok && !relayed.length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `[set-agent-comm] No inbox watch needed: this session is woken through its own inbox ` +
          `socket — a sender rings it directly (${bell.why}). A watch here would only wake you every ` +
          `30 minutes to re-read your whole context. Carry on; the Stop hook still reports unread ` +
          `mail at the end of each turn.`,
      } }))
    }
  }
} catch { /* a guard that can fail a tool call is worse than the expiries it saves */ }
process.exit(0)
