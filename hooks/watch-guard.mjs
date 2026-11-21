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
 * inbox socket and the watch adds nothing. Everywhere else the watch is still wanted, but NOT as a
 * Monitor (2026-11-21): the reason hands over the background-shell form, `sac wait --once`, which
 * has no deadline. Relay rooms included — that form pulls them just the same.
 *
 * IT NEVER BLOCKS ANYTHING ELSE AND NEVER THROWS. Any doubt — an unparsable payload, a Monitor
 * that is not ours — ends in silence, which lets the call through. It is wired on `Monitor` only,
 * so the background form it recommends is never declined by it.
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
    /**
     * ⚠ (2026-11-08, SUPERSEDED 2026-11-21) A re-arm used to go through only while this seat had a
     * QUESTION or REQUEST open (`store.awaitingReply`). Measured the evening it was superseded: one
     * seat re-armed four times in a row, every one allowed, because it had five "open" REQUESTs —
     * two of them answered hours earlier by an ANSWER without `re:`, one saying itself "nothing
     * waits on it". The owner, the same evening: "it wakes up again every 30 minutes and the tokens
     * run out; it used to be unlimited". The rule was a filter on the symptom. The cause is the
     * Monitor: it no longer has `persistent`, so every one dies at 30 minutes and its expiry is a turn.
     *
     * So a Monitor of `sac wait` is declined outright, and the reason hands over the form that has
     * no deadline: a background shell running `sac wait --once`, which wakes the session only when
     * an entry worth a turn arrives (see `waitCmd` in hooks/session-start.mjs). Relay rooms are no
     * exception any more — the background watch pulls them exactly as the Monitor did.
     */
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
      process.exit(0)
    }
    // `--once` wherever it already stands is kept; otherwise it goes right after `wait`, anchored
    // the same way as the test above so it cannot land inside another word.
    const once = /\s--once(\s|$)/.test(command)
      ? command : command.replace(/(^|[\s/])(sac(\.mjs)?\s+wait)(?=\s|$)/, "$1$2 --once")
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `[set-agent-comm] Not as a Monitor: a Monitor dies after at most 30 minutes, and every expiry ` +
        `wakes you to re-read your whole context for nothing. Start the inbox watch as a BACKGROUND ` +
        `SHELL instead — it has no deadline and wakes you only when mail worth a turn arrives: ` +
        `Bash({ command: ${JSON.stringify(once)}, run_in_background: true, description: "agent-comm inbox" }). ` +
        `When it exits, read the mail with \`inbox\`, answer, and run the same command again.`,
    } }))
  }
} catch { /* a guard that can fail a tool call is worse than the expiries it saves */ }
process.exit(0)
