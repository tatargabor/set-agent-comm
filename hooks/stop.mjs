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

/**
 * A HEADLESS RUN IS NEVER BLOCKED (see `store.headless`). Blocking is how this hook says "go
 * back and deal with this", and a `claude -p` doing one task from a queue has no business being
 * sent back: it cannot triage somebody else's message, and the turn it spends discovering that
 * is the whole cost the silent join exists to remove. Measured on the copilot's cadence, this is
 * up to 24 blocked turns an hour for messages the run was never the right reader of.
 *
 * ⚠ It returns BEFORE `shouldNudge`, which is what makes this safe: the nudge is spent on disk,
 * and a headless run that consumed it would silently rob the interactive session of the one
 * nudge that message will ever get. Skipping is not enough — skipping *early* is the point.
 */
if (store.headless()) {
  process.stdout.write("{}")
  process.exit(0)
}

const pending = []
for (const room of store.parseRooms(process.env.SET_AGENT_ROOM)) {
  // `advance: false` — the hook does not read the message on the agent's behalf. Marking it
  // read here would be the worst outcome: the agent would never see what it was nudged about.
  const { unread, unreadWaking, messages } = store.inbox({ room, agent: writer, advance: false })
  // ⚠ Blocking is spent on what is ENTITLED TO INTERRUPT (see `store.wakes`) — an entry
  // addressed to us, or a question or request to the room. Until 2026-08-06 this said "addressed
  // to us", which a broadcast satisfies, and since every entry in the first two days of live
  // traffic was a broadcast, it meant: every entry blocked the end of every turn. One session
  // was blocked 33 times. A broadcast FACT is delivered, stays unread, and holds nobody up.
  const waking = messages.filter(m => m.wakes)
  const last = waking.at(-1)
  if (!unreadWaking || !last) continue
  if (!store.shouldNudge({ room, agent: writer, ts: last.ts })) continue
  const who = [...new Set(waking.map(m => m.from))].join(", ")
  const preview = last.text.replace(/\s+/g, " ").slice(0, 200)
  const others = unread - unreadWaking
  pending.push(`${unreadWaking} in "${room}" from ${who} — last one (${last.type}): "${preview}"` +
    (others ? ` (+${others} that can wait)` : ""))
}

// ── the one thing worth asking for when there is no mail ─────────────────────
// An undeclared `focus` costs twice over: the letterbox has nothing to weigh an incoming message
// against, so it wakes this seat for everything; and the others have to ASK what it is working on
// — measured, 46 entries in two days went on exactly that. So a seat that has never declared one
// is asked ONCE, ever, and only when it has no mail to deal with and there is somebody to tell.
//
// ⚠ Once per seat, on disk. A reminder that returns every turn is a reminder that gets ignored,
// and it would be the second interruption engine this project has had to remove.
if (!pending.length && !store.getFocus(writer)) {
  const rooms = store.parseRooms(process.env.SET_AGENT_ROOM)
  const others = rooms.some(r => store.liveSeats(r).some(s => s !== writer))
  if (others && store.firstTime(`focus::${writer}`))
    pending.push("__focus__")
}
const focusOnly = pending.length === 1 && pending[0] === "__focus__"

// `decision: "block"` sends the agent back to work with the reason in hand. The room is named,
// so it does not have to guess which `inbox` to call.
process.stdout.write(JSON.stringify(focusOnly
  ? {
      decision: "block",
      reason: `[set-agent-comm] You have not said what you are working on. Declare it once with ` +
        `\`focus\` (one sentence + the paths) — the other sessions read it instead of asking you, ` +
        `and the inbox watcher uses it to decide whether a message is yours. Then carry on; ` +
        `you will not be asked again.`,
    }
  : pending.length
  ? {
      decision: "block",
      reason: `[set-agent-comm] Something that needs you arrived while you were working: ` +
        `${pending.join(" · ")}. Read it with the \`inbox\` tool before you stop. ` +
        // ⚠ "Say something even if it is not yours" USED to stand here, and it was the engine of
        // the measured ack storm: with every entry counting as addressed to everyone, it obliged
        // every seat to answer every message, and the answers were themselves broadcasts that
        // obliged another round. What blocks now is narrow enough to be answered on its merits.
        `Answer it if it is a question or a request; if it is a fact you have nothing to add to, ` +
        `reading it is the whole job — do not send an acknowledgement.`,
    }
  : {}))
