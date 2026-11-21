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
 *   the agent is idle     → `sac wait --once` in a background shell: that starts a new turn
 *                           (a Monitor until 2026-11-21 — see `waitCmd` in session-start.mjs)
 *
 * ⚠ It nudges ONCE per entry (see `shouldNudge`). Claude Code has no `stop_hook_active` field
 * to break a blocking loop, so a hook that blocked on every unread message would trap an agent
 * that does not read it. Blocking is a strong move: it may be used to say something NEW.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs"
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
 * THE DOORBELL'S LIVE MODE (native-doorbell). `permission_mode` reaches the hooks here and not at
 * SessionStart (measured 2026-10-19), and an idle session is precisely one whose last act was this
 * hook — so the record a sender reads is always as fresh as the session's last turn. Before the
 * headless exit below: a `claude -p` worker kept alive on stream-json is ringable too.
 */
store.setDoorbell(writer, {
  mode: typeof payload.permission_mode === "string" ? payload.permission_mode : undefined,
  socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || undefined,
})

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

/**
 * ⚠ A TURN THAT ENDS ON `ALL DONE:` OR `NEED INPUT:` IS NOT SENT BACK — 2026-11-21, asked for by
 * the AI+ family's hook analysis (309 sessions, 2026-11-06..13): this hook's mail nag was the
 * second-largest source of forced turns (107). Those two lines are the family's stated hand-overs
 * to the person: the work is finished, or it cannot go on without them. Sending such a turn back
 * makes the agent bury the hand-over under a mail errand the person never asked about.
 *
 * Read only when there IS something to block on (most turns end with no mail, and the transcript
 * fallback reads up to 512 KB), and BEFORE `shouldNudge`, so nothing is spent: the entry stays
 * unread, a running watch still announces it, and the next turn's Stop still nudges it once.
 */
const lastWords = () => {
  if (typeof payload.last_assistant_message === "string") return payload.last_assistant_message
  if (typeof payload.transcript_path !== "string") return ""
  // Older harnesses do not hand the final message over; the transcript's tail has it. Bounded:
  // a session's transcript runs to tens of MB, and this runs at the end of a turn.
  try {
    const fd = openSync(payload.transcript_path, "r")
    try {
      const size = fstatSync(fd).size, len = Math.min(size, 512 * 1024)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString("utf8").split("\n")
      const texts = []
      // Back to the last USER entry (a prompt or a tool result) and no further: only what the
      // agent said AFTER it is this turn's ending. Walking on past it would let the previous
      // turn's `ALL DONE:` exempt a turn that ended on a tool call.
      for (let i = lines.length - 1; i >= 0; i--) {
        let e
        try { e = JSON.parse(lines[i]) } catch { continue }
        if (e?.type === "user") break
        if (e?.type !== "assistant") continue
        const text = (Array.isArray(e.message?.content) ? e.message.content : [])
          .filter(c => c?.type === "text").map(c => c.text).join("\n")
        if (text) texts.unshift(text)
      }
      return texts.join("\n")
    } finally { closeSync(fd) }
  } catch { /* no transcript, or unreadable: decide as if there were no hand-over */ }
  return ""
}
const HANDOVER = /^\s*(ALL DONE|NEED INPUT):/m

/**
 * ⚠ ONLY A QUESTION OR REQUEST ADDRESSED TO THIS SEAT holds the turn — 2026-11-21, same analysis —
 * WHILE A WATCH OF THIS SEAT IS RUNNING. `wakes` stays the precondition (the one rule; this only
 * narrows it), but it also says yes to a QUESTION/REQUEST broadcast to the whole room and to an
 * addressed FACT or ANSWER, and neither owes THIS turn anything: the running watch announces them
 * once the seat is idle (a broadcast after the letterbox has weighed it), and a fact or an answer
 * is read when the agent next looks.
 *
 * ⚠ Without a running watch the narrowing would strand them: since the watch became a one-shot
 * background shell, it exists only while the agent keeps re-running it, and a seat that forgot to
 * would hear about a broadcast REQUEST from nobody (caught in review, 2026-11-21). So there the
 * old rule stands — every `wakes` entry blocks, once. The doorbell does not change this: it rings
 * only a direct address or a pair room, and a broadcast is left to the watch.
 *
 * Addressed means: one of `to` is this seat's name or its project's (`store.addressForms`), or,
 * with no `to`, a room where an unaddressed entry has exactly one other party — the other side of
 * a seat DM, or the other project of a project room (`store.addressedIn`). Never `owner`.
 */
const narrow = store.watchLive(writer)
const forms = store.addressForms(writer)
const addressedToMe = (m, room) => {
  const pair = store.pairArg(room)
  const e = store.addressedIn(m, pair)
  return e.to?.length ? e.to.some(n => !store.isOwner(n) && forms.has(n)) : pair === true
}
const ASKS = new Set(["QUESTION", "REQUEST"])

const found = []
// The seat's OWN rooms, not the environment's — see `store.wakingRooms`. A room joined mid
// session used to be invisible here, and one parted was still able to interrupt.
for (const room of store.wakingRooms(writer)) {
  // `advance: false` — the hook does not read the message on the agent's behalf. Marking it
  // read here would be the worst outcome: the agent would never see what it was nudged about.
  // ⚠ `respectQuiet: false` — a declared quiet silences the WATCHER, not this. `sac wait` starts
  // a turn while the agent is working, which is the interruption somebody asked to stop; this
  // hook only ever runs where the turn was ending anyway, so it interrupts nothing and is the
  // last net before the session goes away. Applying quiet here let a silent seat stop with an
  // unread REQUEST addressed to it — and if that session never came back, "not now" became
  // "never". Caught by a sibling session reading the code, hours after it was written.
  const { unread, unreadWaking, messages } =
    store.inbox({ room, agent: writer, advance: false, respectQuiet: false })
  // ⚠ Blocking is spent on what is ENTITLED TO INTERRUPT (see `store.wakes`) — an entry
  // addressed to us, or a question or request to the room. Until 2026-08-06 this said "addressed
  // to us", which a broadcast satisfies, and since every entry in the first two days of live
  // traffic was a broadcast, it meant: every entry blocked the end of every turn. One session
  // was blocked 33 times. A broadcast FACT is delivered, stays unread, and holds nobody up.
  const waking = messages.filter(m => m.wakes && (!narrow || (ASKS.has(m.type) && addressedToMe(m, room))))
  const last = waking.at(-1)
  if (!unreadWaking || !last) continue
  found.push({ room, unread, waking, last })
}

if (found.length && HANDOVER.test(lastWords())) {
  process.stdout.write("{}")
  process.exit(0)
}

const pending = []
for (const { room, unread, waking, last } of found) {
  if (!store.shouldNudge({ room, agent: writer, ts: last.ts })) continue
  // ⚠ A HELD TURN IS THE EXPENSIVE HALF, and this is where it actually happens — the decision
  // was recorded when the entry was written, but a decision only becomes a cost when it reaches
  // a session. A decision with no matching delivery is a seat nobody could wake, which is the
  // number the README calls the weakest link in the chain. Recording never throws: see
  // `recordWake`, which drops the line rather than risk failing a turn.
  store.recordWake({ room, seat: writer, entry: last.ts, how: "blocked" })
  const who = [...new Set(waking.map(m => m.from))].join(", ")
  const preview = last.text.replace(/\s+/g, " ").slice(0, 200)
  const others = unread - waking.length
  pending.push(`${waking.length} in "${room}" from ${who} — last one (${last.type}): "${preview}"` +
    (others ? ` (+${others} that can wait)` : ""))
}

// ── focus: asked for at SessionStart, never by holding a turn ─────────────────
// ⚠ Until 2026-11-21 a seat with no declared `focus` was blocked here, once per seat. The same
// analysis counted it: 25 forced turns in 25 sessions — one per session, every one of them a turn
// spent on a declaration the SessionStart note already asks for. The note stays; the block went.
// (Why `focus` matters is unchanged: the letterbox weighs mail against it, and the others read it
// instead of asking — 46 entries in two days once went on "who is working on what".)

// `decision: "block"` sends the agent back to work with the reason in hand. The room is named,
// so it does not have to guess which `inbox` to call.
process.stdout.write(JSON.stringify(pending.length
  ? {
      decision: "block",
      reason: `[set-agent-comm] Something that needs you arrived while you were working: ` +
        `${pending.join(" · ")}. Read it with the \`inbox\` tool before you stop. ` +
        // ⚠ "Say something even if it is not yours" USED to stand here, and it was the engine of
        // the measured ack storm: with every entry counting as addressed to everyone, it obliged
        // every seat to answer every message, and the answers were themselves broadcasts that
        // obliged another round. What blocks now is narrow enough to be answered on its merits.
        `Answer it if it is a question or a request; if it is a fact you have nothing to add to, ` +
        `reading it is the whole job — do not send an acknowledgement.` +
        (narrow ? "" : ` (Your inbox watch is not running, so nothing will announce mail while you ` +
          `sit idle — start it again with the command from the session-start note.)`),
    }
  : {}))
