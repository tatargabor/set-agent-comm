// THE LETTERBOX — a cheap model that decides whether an entry is worth a turn of the expensive one.
//
// WHY THIS EXISTS, measured 2026-08-06 in session `consumer-a#6cd8f60e`: a monitor notification does
// not "check" anything, it STARTS A TURN. The main agent — Opus, with the project's whole context
// behind it — wakes up, reads the room, works out that the message was for a sibling session, and
// says so. That is the full price of an interruption paid for the answer "not me". Nineteen of
// those in one session.
//
// `store.wakes` already drops the broadcast FACTs (91% of the measured traffic), and it does so for
// free — no model, no tokens. What it cannot judge is the case the rule is deliberately generous
// about: an entry addressed to a PROJECT (`consumer-a`) when that project has four sessions open, or
// a broadcast QUESTION in a room of four where exactly one seat can answer. The rule must wake
// everyone there, because it cannot read. This can.
//
// THREE PROPERTIES IT MUST HAVE, and each is a decision, not an accident:
//
//  1. IT FAILS OPEN. No `claude` binary, a timeout, unparseable output, a non-zero exit — all of
//     them wake the agent. A missed wake-up is the failure this whole project exists to prevent;
//     a needless one merely costs a turn. The asymmetry is not close.
//  2. IT NEVER SECOND-GUESSES A DIRECT ADDRESS. An entry naming this exact seat skips the model
//     entirely. Someone typed that seat name deliberately; a classifier is not entitled to overrule
//     it, and asking it to is how "I addressed you and you never answered" happens.
//  3. IT DOES NOT MARK ANYTHING READ. It only decides about waking. The entry stays unread until
//     the agent's own `inbox` call, so a wrong "no" delays a message — it never swallows one.

import { spawn } from "node:child_process"
import { getFocus, seatBase, addressForms } from "./store.mjs"

/** `claude-haiku-4-5` — cheapest current model, and plenty for a yes/no about one short message. */
const MODEL = process.env.SET_AGENT_TRIAGE_MODEL || "claude-haiku-4-5"
/**
 * Which binary answers. Overridable because `claude` is not always on the PATH of the shell a
 * Monitor runs in — the same lesson `process.execPath` was learned for — and because it is the
 * only way to test this layer without spending a real model call per assertion.
 */
const BIN = process.env.SET_AGENT_TRIAGE_BIN || "claude"
const TIMEOUT_MS = Number(process.env.SET_AGENT_TRIAGE_TIMEOUT_MS) || 25_000
export const enabled = () => process.env.SET_AGENT_TRIAGE !== "off"

/**
 * The prompt. It is deliberately about ONE message and ONE agent: a classifier given a whole room
 * to weigh starts writing summaries, and a summary is not what we asked for.
 *
 * The wake / do-not-wake lists are written from the measured traffic, not from imagination — every
 * "do not wake" line names something that actually cost a turn in the `consumer-a-atlas` room over the
 * first two days.
 */
const prompt = ({ seat, focus, entry, room, live }) => `You are the letterbox of a coding agent.
Decide ONE thing: must this message interrupt your agent NOW — starting a whole turn — or can it
wait until the agent looks at its inbox on its own?

YOUR AGENT
  seat:    ${seat}
  project: ${seatBase(seat)}
  working on: ${focus?.text || "(not declared — judge from the message alone, and lean towards waking)"}
${focus?.files?.length ? `  in files:   ${focus.files.join(", ")}\n` : ""}\
${live?.length > 1 ? `  note: this project has ${live.length} sessions open (${live.join(", ")}), so a message
  addressed to the project name may well be meant for one of the others, not for yours.\n` : ""}
THE MESSAGE (room "${room}")
  from: ${entry.from}
  type: ${entry.type}
  to:   ${entry.to?.length ? entry.to.join(", ") : "(broadcast — everyone in the room)"}
  ---
${entry.text.replace(/\s+$/, "").slice(0, 1500)}
  ---

WAKE if any of these hold:
  - it asks a question that YOUR agent, specifically, is the one to answer
  - it requests work in your agent's declared focus or its files
  - it warns that someone is about to touch the files your agent is working in
  - it answers something your agent asked, or blocks your agent from continuing

DO NOT WAKE for:
  - status reports, progress notes, "here is what I did", results that change nothing for your agent
  - acknowledgements, thanks, agreement, closing remarks ("received", "well done", "I'm done here")
  - work in someone else's area, or a question another named participant is better placed to answer
  - anything your agent would read, think about, and reply "that is not mine" to

Answer with JSON and nothing else: {"wake": true|false, "why": "<at most 8 words>"}`

/** Pull the verdict out of whatever the model wrapped it in (a code fence, a stray sentence). */
function parse(out) {
  const m = out.match(/\{[^{}]*"wake"[^{}]*\}/s)
  if (!m) return null
  try {
    const v = JSON.parse(m[0])
    return typeof v.wake === "boolean" ? { wake: v.wake, why: String(v.why || "").slice(0, 80) } : null
  } catch { return null }
}

/**
 * The `claude` CLI in headless mode, stripped of everything that would make it expensive:
 * no MCP servers (`--strict-mcp-config` with an empty config — otherwise it would load THIS
 * project's own agent-comm server and could send messages while judging one), no hooks, and plan
 * mode so it cannot reach for a tool. The CLI, rather than the API, on purpose: it uses the login
 * the user already has, so the letterbox needs no key and no second piece of configuration.
 */
function ask(text) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(BIN, [
        "-p", text,
        "--model", MODEL,
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--permission-mode", "plan",
        "--settings", '{"disableAllHooks":true}',
      ], { stdio: ["ignore", "pipe", "ignore"], cwd: "/" })
    } catch { return resolve(null) }     // no binary at all — fail open
    let out = ""
    const done = v => { clearTimeout(timer); child.kill("SIGKILL"); resolve(v) }
    const timer = setTimeout(() => done(null), TIMEOUT_MS)
    child.stdout.on("data", d => { out += d; if (out.length > 8000) done(parse(out)) })
    child.on("error", () => done(null))
    child.on("close", () => done(parse(out)))
  })
}

/**
 * @returns {{wake: boolean, why: string, via: "direct"|"model"|"unavailable"}}
 *   `via` is reported, never hidden: "the letterbox said no" and "there was no letterbox" are
 *   different facts, and a run where every decision came back `unavailable` is a broken triage
 *   pretending to be a quiet one.
 */
export async function triage({ entry, room, seat, live }) {
  const forms = addressForms(seat)
  // Named THIS seat — not the project, this seat — and NOBODY ELSE. Never second-guessed.
  // (Property 2 above.)
  //
  // ⚠ The `to.length === 1` half matters as much as the name match. An entry that lists five
  //   seats is a broadcast with extra steps, and without this it would be five guaranteed
  //   interruptions that the letterbox is not even allowed to look at — the exact shape the whole
  //   wake-up rule exists to stop, wearing the one costume that gets waved through.
  if (entry.to?.length === 1 && entry.to[0].includes("#") && forms.has(entry.to[0]))
    return { wake: true, why: "addressed to this seat by name", via: "direct" }
  if (!enabled()) return { wake: true, why: "triage off", via: "unavailable" }
  const v = await ask(prompt({ seat, focus: getFocus(seat), entry, room, live }))
  return v ? { ...v, via: "model" } : { wake: true, why: "letterbox unavailable", via: "unavailable" }
}

// ── the same model, pointed the other way ─────────────────────────────────────
// THE SAFETY NET. The letterbox above only ever sees what the RULE already let through, and in
// live use that is almost nothing: a single-seat address skips it, and a broadcast FACT never
// reaches it because `wakes` said no. So the expensive failure the rule can make — declining an
// entry that really did need this seat — had nobody watching it at all.
//
// Measured 2026-08-06, six live sessions: all five entries were broadcast FACTs, one of them
// renaming an id that two other projects had to follow. The rule woke nobody, correctly by its own
// terms, and the errand sat there. This is the layer that catches that.
//
// ⚠ IT FAILS CLOSED, and that is the opposite of the letterbox on purpose. The letterbox's mistake
// costs one turn; this one's mistake costs the whole win — a net that says yes when unsure would
// put every broadcast FACT back on everyone's desk and we would be exactly where we started. So no
// binary, a timeout, unparseable output, anything at all going wrong: stay quiet. The entry is
// unread, in the room, and the agent's own next `inbox` still hands it over.
const netPrompt = ({ seat, focus, entry, room }) => `You are the safety net of a coding agent.

This message was ALREADY judged not urgent by a rule and your agent was NOT woken. That is usually
right. You are here for the rare case where it is wrong and something would be lost.

YOUR AGENT
  seat:    ${seat}
  project: ${seatBase(seat)}
  working on: ${focus?.text || "(not declared)"}
${focus?.files?.length ? `  in files:   ${focus.files.join(", ")}\n` : ""}\
THE MESSAGE (room "${room}")
  from: ${entry.from}
  type: ${entry.type}
  to:   ${entry.to?.length ? entry.to.join(", ") : "(broadcast — everyone in the room)"}
  ---
${entry.text.replace(/\s+$/, "").slice(0, 1500)}
  ---

Say WAKE only if BOTH hold:
  - it plainly requires YOUR agent to do something, or it invalidates what your agent is doing now
  - and finding out later rather than now would cost real work — a rename it must follow, a file it
    is about to edit, a decision that changes what it is writing this minute

Say DO NOT WAKE for everything else, and when you are unsure. Status reports, results, decisions
that are merely good to know, work in someone else's area, anything your agent can read later at
its own pace: those are what this rule is FOR, not mistakes it made.

Answer with JSON and nothing else: {"wake": true|false, "why": "<at most 8 words>"}`

/**
 * @returns {{wake: boolean, why: string, via: "model"|"unavailable"}} — `wake: false` on anything
 *   going wrong, unlike `triage`.
 */
export async function rescue({ entry, room, seat }) {
  if (!enabled()) return { wake: false, why: "triage off", via: "unavailable" }
  const v = await ask(netPrompt({ seat, focus: getFocus(seat), entry, room }))
  return v ? { ...v, via: "model" } : { wake: false, why: "net unavailable", via: "unavailable" }
}
