// The NOTIFICATION path, measured with real processes: the Stop hook and `sac wait`.
//
// Why its own test file: delivery (store.test.mjs) and being told about it are two different
// things, and on 2026-08-04 exactly the second one failed. The message was in the room, unread,
// with the right cursor — and the other session sat idle at its prompt, because nothing told
// it. These tests therefore run the hook and the CLI as separate processes, the way Claude Code
// runs them, rather than calling the functions behind them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), "sac-nudge-"))
const SAC = join(HERE, "..", "bin", "sac.mjs")
const STOP = join(HERE, "..", "hooks", "stop.mjs")
// The letterbox is stubbed (see fake-letterbox.mjs) and the quiet window shortened: what is under
// test here is what `sac wait` does with a verdict, not a real model's judgement.
const LETTERBOX = join(HERE, "fake-letterbox.mjs")
// Each simulated session gets its own WINDOW too (`SET_AGENT_OWNER_PID`) — that is what a second
// Claude Code window is, and without it the real `claude` ancestor above the test runner would
// (correctly) put every simulated session on one seat.
const WINDOW = { one: 900001, two: 900002, three: 900003 }
const env = (session, extra = {}) => ({
  ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_ROOM: "team",
  SET_AGENT_NAME: "web-app", CLAUDE_CODE_SESSION_ID: session,
  SET_AGENT_OWNER_PID: String(WINDOW[session] ?? 0),
  // The SAFETY NET is off by default here, and deliberately so: it is a third gate that can
  // overrule the first two, and with a stub that says yes to everything it would answer every
  // assertion about gates 1 and 2 with a wake-up. It gets its own block, at the bottom.
  SET_AGENT_TRIAGE_BIN: LETTERBOX, SET_AGENT_QUIET_MS: "100", SET_AGENT_SAFETY_NET: "off", ...extra,
})
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

const sac = (session, ...args) => spawnSync(process.execPath, [SAC, ...args], { env: env(session), encoding: "utf8" })
const stopHook = session => JSON.parse(spawnSync(process.execPath, [STOP], {
  env: env(session), encoding: "utf8", input: JSON.stringify({ cwd: "/x", session_id: session }),
}).stdout || "{}")

// Two sessions of one project — the seat name carries the session id, so they are
// `web-app#one` and `web-app#two`.
const SEAT = "web-app#two"
sac("one", "register", "team")
sac("two", "register", "team")

// ⚠ An undeclared `focus` is asked for ONCE per seat, ever, and only when there is no mail and
// somebody to tell. It costs one turn and it buys two things back: the letterbox gets something to
// weigh a message against (without it, everything wakes this seat), and the others stop asking —
// measured, 46 entries in two days went on "who is working on what".
test("a seat that never said what it is working on is asked — once", () => {
  const first = stopHook("two")
  assert.equal(first.decision, "block", "nobody ever asks, so nobody ever declares one")
  assert.match(first.reason, /focus/, "the reason does not name what to do about it")
  assert.deepEqual(stopHook("two"), {},
    "it asked again — a reminder that returns every turn is the second interruption engine")
})

test("the Stop hook lets a turn end when there is nothing unread", () => {
  assert.deepEqual(stopHook("two"), {})
})

test("the Stop hook BLOCKS the end of the turn when a message arrived", () => {
  sac("one", "send", "team", "REQUEST", "Do not regenerate the atlas yet.")
  const out = stopHook("two")
  assert.equal(out.decision, "block", "the agent was allowed to finish with unread mail")
  assert.match(out.reason, /team/, "the reason does not name the room to read")
  assert.match(out.reason, /regenerate/, "the reason does not show what arrived")
})

test("it nudges ONCE per entry — Claude Code has no stop_hook_active to break the loop", () => {
  assert.deepEqual(stopHook("two"), {},
    "it blocked for the same message a second time — an agent that does not read it would be trapped")
})

test("a nudge is NOT a delivery: the message stays unread", () => {
  // The worst possible outcome would be a hook that marks it read on the agent's behalf: it
  // would be nudged about something it can then never see.
  assert.match(sac("two", "peek", "team").stdout, /regenerate/,
    "the nudge swallowed the message")
})

// ⚠ A BROADCAST FACT MAY NOT HOLD A TURN OPEN. Measured over the bus's first two days: 190 of 190
// entries were broadcasts, so "addressed to us" was satisfied by every one of them and the hook
// blocked on all of them — one session was sent back to work 33 times. See `store.wakes`.
test("a broadcast FACT is delivered without holding the turn open", () => {
  sac("one", "send", "team", "FACT", "Rebuilt the atlas; nothing for you to do.")
  assert.deepEqual(stopHook("two"), {},
    "a plain fact blocked the end of a turn — this is the ack storm the rule exists to stop")
  assert.match(sac("two", "peek", "team").stdout, /Rebuilt the atlas/,
    "not blocking on it turned into not delivering it")
})

/** Run `sac wait`, collect its output for `ms`, kill it. `--once` exits by itself on the first event. */
const waitFor = (session, args, ms, extra = {}) => new Promise(resolve => {
  const p = spawn(process.execPath, [SAC, "wait", ...args], { env: env(session, extra) })
  let text = ""
  p.stdout.on("data", d => { text += d })
  p.on("exit", code => resolve({ code, text }))
  setTimeout(() => { p.kill(); resolve({ code: null, text }) }, ms)
})

test("`sac wait` reports what is ALREADY waiting, then exits with --once", async () => {
  // This is what a Claude Code Monitor runs — the only thing that starts a new turn in an idle
  // session. Measured: `watchPaths`/`FileChanged` fire while idle but cannot wake the session.
  const out = await waitFor("two", ["--once", "team"], 8000)
  assert.equal(out.code, 0, "`sac wait --once` did not exit on the event")
  assert.match(out.text, /REQUEST from web-app#one in "team"/)
  assert.match(out.text, /regenerate the atlas/i,
    "the event carries only a count — the agent has to spend a tool call to learn what it is about")
  assert.match(out.text, /inbox/, "the event does not say what to do about it")
})

test("`sac wait` emits an event for a message that arrives WHILE it is running", async () => {
  const p = spawn(process.execPath, [SAC, "wait", "team"], { env: env("two") })
  try {
    let text = ""
    p.stdout.on("data", d => { text += d })
    await new Promise(r => setTimeout(r, 700))
    sac("one", "send", "team", "QUESTION", "Is the invoice draft ready?")
    await new Promise(r => setTimeout(r, 2500))
    assert.match(text, /invoice draft/,
      "a message written while the monitor was running produced no event")
  } finally { p.kill() }
})

// ⚠ THE REGRESSION THIS WHOLE LEDGER EXISTS FOR. Measured 2026-08-06 in `consumer-a#6cd8f60e`: the
// "already reported" set lived in a variable inside `sac wait`, so each restart of the process
// re-announced the entire backlog — the same three notifications, byte for byte, 32 seconds
// apart, nineteen wake-ups in one session on a day when nobody wrote anything.
test("a restarted watch does not re-announce what it already announced", async () => {
  const out = await waitFor("two", ["--once", "team"], 2500)
  assert.equal(out.text, "",
    `a fresh watch process re-reported an entry it had already reported: ${out.text}`)
})

test("a broadcast FACT arriving while the watch runs starts no turn", async () => {
  const p = spawn(process.execPath, [SAC, "wait", "team"], { env: env("two") })
  try {
    let text = ""
    p.stdout.on("data", d => { text += d })
    await new Promise(r => setTimeout(r, 700))
    sac("one", "send", "team", "FACT", "Deployed the relay to staging.")
    await new Promise(r => setTimeout(r, 2000))
    assert.equal(text, "", `a broadcast fact woke a session: ${text}`)
  } finally { p.kill() }
  assert.match(sac("two", "peek", "team").stdout, /staging/, "…and it was not delivered either")
})

test("the cursor did not move through any of it — `wait` only looks", () => {
  const cursors = JSON.parse(readFileSync(join(ROOT, "cursors.json"), "utf8"))
  assert.equal(cursors[`team::${SEAT}`]?.["web-app#one"], undefined,
    "watching advanced the read cursor, so the message would be lost")
})

// ── addressing: who is WOKEN ──────────────────────────────────────────────────
// A room of two needs no addressee; a room of four does. Measured 2026-08-05 in the consumer-a rooms:
// a message aimed at one sibling session started a turn in every seat, and each spent it
// establishing that it was not being spoken to. Delivery is unchanged — only waking is.
// Its own room, so the cursor of "team" above stays untouched.
const aimEnv = session => ({ ...env(session), SET_AGENT_ROOM: "aim" })
const aim = (session, ...args) =>
  spawnSync(process.execPath, [SAC, ...args], { env: aimEnv(session), encoding: "utf8" })
const aimStop = session => JSON.parse(spawnSync(process.execPath, [STOP], {
  env: aimEnv(session), encoding: "utf8", input: JSON.stringify({ cwd: "/x", session_id: session }),
}).stdout || "{}")

for (const s of ["one", "two", "three"]) aim(s, "register", "aim")

test("an entry addressed to ANOTHER seat does not wake this one", async () => {
  aim("one", "send", "aim", "REQUEST", "Regenerate the atlas, please.", "--to", "web-app#three")
  const out = await new Promise(resolve => {
    const p = spawn(process.execPath, [SAC, "wait", "--once", "aim"], { env: aimEnv("two") })
    let text = ""
    p.stdout.on("data", d => { text += d })
    // It is SUPPOSED to keep waiting: the only honest way to assert "no event" is to give it
    // time and find the output empty.
    setTimeout(() => { p.kill(); resolve(text) }, 1500)
  })
  assert.equal(out, "", `a message addressed to web-app#three woke web-app#two: ${out}`)
})

test("…nor does it hold that seat's turn open", () => {
  assert.deepEqual(aimStop("two"), {},
    "the Stop hook blocked for a message addressed to another seat")
})

test("it is READABLE all the same — the room did not stop being a room", () => {
  assert.match(aim("two", "peek", "aim").stdout, /Regenerate the atlas/)
  assert.match(aim("two", "peek", "aim").stdout, /not for you/,
    "nothing said the entry was addressed to someone else")
})

test("an entry addressed TO US blocks, and says how many are not ours", () => {
  aim("one", "send", "aim", "QUESTION", "Is the draft ready?", "--to", SEAT)
  const out = aimStop("two")
  assert.equal(out.decision, "block", "a message addressed to this very seat let the turn end")
  assert.match(out.reason, /draft/)
  assert.match(out.reason, /\+1 that can wait/,
    "the entries waiting for others went unmentioned — that is how one gets forgotten")
})

// ── the letterbox: the second gate ────────────────────────────────────────────
// `wakes` is a rule and cannot read. A REQUEST addressed to the PROJECT passes it for every
// session of that project — measured: `consumer-a` had four open at once — and at most one of them
// is meant. A cheap model reads the message against the seat's declared `focus` and answers one
// question: is this one yours? It fails towards waking, always.

// Its own room, so no earlier test's backlog decides these.
const post = (session, ...args) =>
  spawnSync(process.execPath, [SAC, ...args], { env: env(session, { SET_AGENT_ROOM: "post" }), encoding: "utf8" })
for (const s of ["one", "two"]) post(s, "register", "post")

test("the letterbox can decline to interrupt — and the entry is still delivered", async () => {
  // Addressed to the PROJECT, which every session of it satisfies: the rule must let this through,
  // and only a reader can tell whether this particular window is the one meant.
  post("one", "send", "post", "REQUEST", "Someone please re-run the billing eval.", "--to", "web-app")
  const out = await waitFor("two", ["--once", "post"], 3000,
    { SET_AGENT_ROOM: "post", SET_AGENT_TRIAGE_SAYS: "no" })
  assert.equal(out.text, "", `the letterbox said no and the agent was woken anyway: ${out.text}`)
  assert.match(post("two", "peek", "post").stdout, /billing eval/,
    "declining to WAKE turned into declining to DELIVER — those are not the same thing")
})

test("an unreachable letterbox wakes the agent — the failure direction is not a toss-up", async () => {
  post("one", "send", "post", "REQUEST", "Rotate the relay secret.", "--to", "web-app")
  const out = await waitFor("two", ["--once", "post"], 4000,
    { SET_AGENT_ROOM: "post", SET_AGENT_TRIAGE_BIN: join(HERE, "no-such-letterbox") })
  assert.match(out.text, /Rotate the relay secret/,
    "a missing letterbox silently swallowed a request — a lost message beats a needless turn nowhere")
})

test("a message naming THIS SEAT is never second-guessed by the letterbox", async () => {
  post("one", "send", "post", "REQUEST", "You specifically: bump the version.", "--to", SEAT)
  const out = await waitFor("two", ["--once", "post"], 3000,
    { SET_AGENT_ROOM: "post", SET_AGENT_TRIAGE_SAYS: "no" })
  assert.match(out.text, /bump the version/,
    "someone typed this seat's name and a classifier overruled them")
})

test("…but naming this seat AND two others is a broadcast, and the letterbox may say no", () => {
  // The bypass is what makes addressing trustworthy; a list of names is what makes it worthless.
  // Without the "and nobody else" half, the cheapest way to guarantee everyone's attention would
  // be to name everyone — one costume that walks straight past both gates.
  post("one", "send", "post", "REQUEST", "All of you: bump the version.",
    "--to", `${SEAT},web-app#aaaaaaaa,web-app#bbbbbbbb`)
  return waitFor("two", ["--once", "post"], 3000, { SET_AGENT_ROOM: "post", SET_AGENT_TRIAGE_SAYS: "no" })
    .then(out => assert.equal(out.text, "",
      `an entry naming three seats waved past the letterbox: ${out.text}`))
})

// ── the safety net: the same model, pointed the other way ─────────────────────
// Gates 1 and 2 both guard against a needless turn. Nothing guarded the expensive mistake — the
// rule declining an entry that really was this seat's. Measured 2026-08-06: six live sessions,
// five broadcast FACTs, one of them a rename two other projects had to follow, nobody woken.
// Its own room again, so no earlier backlog decides it.
const netpost = (session, ...args) =>
  spawnSync(process.execPath, [SAC, ...args], { env: env(session, { SET_AGENT_ROOM: "net" }), encoding: "utf8" })
for (const s of ["one", "two"]) netpost(s, "register", "net")
const NET_ON = { SET_AGENT_ROOM: "net", SET_AGENT_SAFETY_NET: "on" }

test("a broadcast FACT the rule declined can still be rescued", async () => {
  netpost("one", "send", "net", "FACT", "Renamed A-1 to A-1X — anything using the old id breaks.")
  const out = await waitFor("two", ["--once", "net"], 3000, { ...NET_ON, SET_AGENT_TRIAGE_SAYS: "yes" })
  assert.match(out.text, /A-1X/, "the errand hidden in a FACT stayed hidden — the measured failure")
  assert.match(out.text, /NOT.*addressed to you/,
    "an agent woken by the third gate is not told which layer overruled which — that is unexplainable noise")
})

test("…and the net stays quiet when the model says no", async () => {
  netpost("one", "send", "net", "FACT", "Reformatted the changelog.")
  const out = await waitFor("two", ["--once", "net"], 2500, { ...NET_ON, SET_AGENT_TRIAGE_SAYS: "no" })
  assert.equal(out.text, "", `the net woke the agent for a status note: ${out.text}`)
})

test("an unreachable net stays quiet — it fails CLOSED, unlike the letterbox", async () => {
  // The asymmetry is the whole design. The letterbox's mistake costs one turn; this one's mistake
  // costs the entire win — a net that guesses yes puts every broadcast back on everyone's desk.
  netpost("one", "send", "net", "FACT", "Bumped a dependency.")
  const out = await waitFor("two", ["--once", "net"], 2500,
    { ...NET_ON, SET_AGENT_TRIAGE_BIN: join(HERE, "no-such-letterbox") })
  assert.equal(out.text, "", `a broken net woke the agent anyway: ${out.text}`)
})

test("the net judges an entry ONCE — it may not re-offer the same one every poll", async () => {
  netpost("one", "send", "net", "FACT", "Renamed B-2 to B-2X — the old id breaks.")
  const first = await waitFor("two", ["--once", "net"], 3000, { ...NET_ON, SET_AGENT_TRIAGE_SAYS: "yes" })
  assert.match(first.text, /B-2X/)
  const again = await waitFor("two", ["--once", "net"], 2500, { ...NET_ON, SET_AGENT_TRIAGE_SAYS: "yes" })
  assert.equal(again.text, "", `the same entry was offered a second time: ${again.text}`)
})

// ── focus: the scope declaration ──────────────────────────────────────────────
test("`focus` is per seat, reads back, and shows up in `agents`", () => {
  sac("two", "focus", "rewriting the relay token check", "--files", "src/relay.mjs,test/security.test.mjs")
  const mine = JSON.parse(sac("two", "focus").stdout)
  assert.equal(mine.text, "rewriting the relay token check")
  assert.deepEqual(mine.files, ["src/relay.mjs", "test/security.test.mjs"])
  assert.equal(mine.stale, false)
  // The point of it being public: the others look it up instead of asking. Measured: 46 entries
  // in two days went on scope negotiation this answers for free.
  const listing = sac("one", "agents").stdout
  assert.match(listing, /rewriting the relay token check/,
    "`agents` does not show what the other session is doing, so the only way to find out is to ask it")
  assert.match(listing, /src\/relay\.mjs/, "…nor which files it is in, which is the part that collides")
  assert.equal(JSON.parse(sac("one", "focus").stdout).focus, null,
    "one seat's focus leaked into another's — they are per session, not per project")
})

test("a misspelt addressee fails the send LOUDLY, at the writer", () => {
  const r = aim("one", "send", "aim", "FACT", "x", "--to", "web-app#thre")
  assert.notEqual(r.status, 0, "the send went through — that entry would have woken nobody")
  assert.match(r.stderr, /nobody in "aim" is called/)
  assert.match(r.stderr, /web-app#three/, "the error does not name who could have been meant")
})
