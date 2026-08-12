// DECLARED STATE — the three facts that had nowhere to live, and the ledger that had no file.
//
// Everything else on this bus is derived: a room from somebody writing into it, membership from
// `SET_AGENT_ROOM`, presence from a heartbeat. Eight days of live traffic (2026-08-10) found the
// edge of that, three times over:
//
//   · a mistyped room name is not an error but a new silent room you are alone in — the live
//     store still carries one called `--help`;
//   · a session that wants to LEAVE the conversation looks exactly like a dead one;
//   · a fourth session of a project cannot live in a different room from its three siblings.
//
// And the ledger: this project's whole claim is that being read is cheap and being woken is
// expensive, and until now neither had a number.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-declared-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"

const store = await import("../src/store.mjs")

const seatA = "alfa#aaaa1111"
const seatB = "beta#bbbb2222"

// ── rooms exist on purpose ────────────────────────────────────────────────────

test("a room that was never created does not exist", () => {
  assert.equal(store.roomExists("nincs-ilyen"), false)
})

test("REGRESSION: a channel directory from before this change still counts as a room", () => {
  // The whole migration: every room in every existing store keeps existing, with no migration
  // step and no shared file rewritten by whichever process happened to run first.
  mkdirSync(join(ROOT, "channels", "legacy-room"), { recursive: true })
  assert.equal(store.roomExists("legacy-room"), true)
  assert.ok(store.knownRooms().includes("legacy-room"))
})

test("creating a room is explicit, idempotent, and records who did it", () => {
  const first = store.createRoom("team", seatA)
  assert.equal(first.created, true)
  assert.equal(first.by, seatA)
  const again = store.createRoom("team", seatB)
  assert.equal(again.created, false)
  assert.equal(again.by, seatA, "the original creator is kept")
  assert.equal(store.roomExists("team"), true)
})

// ── membership is per seat ────────────────────────────────────────────────────

test("a seat with no record is not the same as a seat in no rooms", () => {
  // `null` takes the configured default; `[]` is a person's decision to leave. Collapsing them
  // would silently undo `part` on the next hook run.
  assert.equal(store.members("never-seen#0000"), null)
  store.setMembers("never-seen#0000", [])
  assert.deepEqual(store.members("never-seen#0000"), [])
})

test("REGRESSION: the configured default seeds a seat ONCE, and never overrides it again", () => {
  assert.deepEqual(store.seedMembers(seatA, ["team", "design"]), ["design", "team"])
  store.partRoom(seatA, "design")
  assert.deepEqual(store.seedMembers(seatA, ["team", "design"]), ["team"],
    "a later seed must not restore what the seat left — that would undo `part` on every hook run")
})

test("one session's membership does not follow its siblings", () => {
  store.seedMembers(seatB, ["team"])
  store.joinRoom(seatB, "design")
  assert.deepEqual(store.members(seatB), ["design", "team"])
  assert.deepEqual(store.members(seatA), ["team"], "the sibling seat is untouched")
})

test("leaving a room never touches what was written", () => {
  store.register({ agent: "alfa", session: "aaaa1111", room: "team", writer: seatA })
  store.send({ room: "team", from: seatA, type: "FACT", text: "ez marad" })
  const file = join(ROOT, "channels", "team", `${seatA}.md`)
  const before = readFileSync(file, "utf8")
  store.partRoom(seatA, "team")
  assert.equal(readFileSync(file, "utf8"), before, "the seat's entries stay exactly where they are")
  assert.match(store.history({ room: "team" }).messages.map(m => m.text).join(), /ez marad/)
  store.joinRoom(seatA, "team")
})

test("REGRESSION: joining and leaving are visible to EVERYBODY, not just to the seat", () => {
  // ⚠ Measured 2026-08-12, while answering the `consumer-a` report that per-seat membership is
  // invisible from the outside. It was invisible in the code too: membership lives in two files
  // and the others only read one of them. `members.json` is the seat's own book; the ROSTER —
  // `liveSeats`, `roomSeats`, and therefore `send`'s wake report and `sac rooms` — is the
  // registry. `join` wrote the first and not the second, `part` likewise, so:
  //
  //   · after `join`, `liveSeats(room)` was EMPTY and the next writer was told the room held
  //     nobody. That is also why a project's worksheet had settled on `sac register` to join
  //     with: of the two commands, the wrong one was the one that showed up.
  //   · after `part`, the seat was still on the roster, and the next SessionStart hook run put
  //     the room back onto it — a leaving that "stuck" in one file and was undone in the other.
  store.register({ agent: "alfa", session: "aaaa1111", room: "team", writer: seatA })
  store.joinRoom(seatA, "korte")
  assert.ok(store.liveSeats("korte").includes(seatA), "a join nobody else can see is not a join")
  assert.ok(store.roomSeats("korte").includes(seatA))

  store.partRoom(seatA, "korte")
  assert.ok(!store.liveSeats("korte").includes(seatA), "a leaving nobody else can see is not one")

  // …and the environment may not put it back: the hook re-registers every configured room on
  // every start, which is exactly the run that used to undo it.
  store.register({ agent: "alfa", session: "aaaa1111", room: "korte", writer: seatA })
  assert.ok(!store.liveSeats("korte").includes(seatA),
    "a hook run re-entered a room the seat had left — on the list everybody else reads")
  assert.deepEqual(store.members(seatA).filter(r => r === "korte"), [],
    "…and the seat's own book disagreed with the roster")
})

// ── quiet: the fourth, declared state ─────────────────────────────────────────

test("quiet suppresses waking and NOT delivery", () => {
  store.register({ agent: "beta", session: "bbbb2222", room: "team", writer: seatB })
  store.setQuiet(seatA, { quiet: true })

  const entry = { type: "QUESTION", from: seatB, to: [seatA], text: "kérdés" }
  assert.equal(store.wakes(entry, seatA), false, "a quiet seat is not woken")
  assert.equal(store.isForMe(entry, seatA), true, "…but the entry is still for it")

  store.send({ room: "team", from: seatB, type: "QUESTION", text: "kérdés a csendeshez", to: [seatA] })
  const r = store.inbox({ room: "team", agent: seatA, advance: false })
  const mine = r.messages.filter(m => m.text.includes("csendeshez"))
  assert.equal(mine.length, 1, "delivery is untouched — a quiet seat receives everything")
  assert.equal(mine[0].forMe, true)
  assert.equal(mine[0].wakes, false)
})

test("`seatState` stays THREE-state — quiet is not a fourth value of it", () => {
  // Every consumer of `seatState` treats true/null/false distinctly and correctly. A fourth
  // value would silently reclassify a quiet seat inside every one of them.
  for (const v of [store.seatState?.(seatA)]) {
    assert.ok(v === true || v === false || v === null || v === undefined,
      `seatState must stay three-state, got ${JSON.stringify(v)}`)
  }
  assert.equal(store.seatPresence(seatA).quiet, true, "quiet lives in its own function")
})

test("a quiet expiry in the past is simply absent — no process has to end it", () => {
  const past = store.now(new Date(Date.now() - 60_000))
  store.setQuiet(seatA, { quiet: true, until: past })
  const p = store.seatPresence(seatA)
  assert.equal(p.quiet, false)
  assert.equal(p.expired, true)
  assert.equal(store.wakes({ type: "QUESTION", from: seatB, to: [seatA] }, seatA), true,
    "an expired quiet wakes normally again")
})

test("`send` tells the writer that an addressee is quiet, and until when", () => {
  const until = store.now(new Date(Date.now() + 3600_000))
  store.setQuiet(seatA, { quiet: true, until })
  const out = store.send({ room: "team", from: seatB, type: "QUESTION", text: "megint", to: [seatA] })
  assert.ok(out.notice?.some(n => n.includes("Quiet") && n.includes(seatA)),
    `expected a quiet notice, got ${JSON.stringify(out.notice)}`)
  assert.ok(out.notice.some(n => n.includes(until)), "…with the expiry, so it can be redirected")
  assert.ok(!out.wakes.includes(seatA))
  store.setQuiet(seatA, { quiet: false })
})

test("clearing quiet restores waking", () => {
  assert.equal(store.seatPresence(seatA).quiet, false)
  assert.equal(store.wakes({ type: "QUESTION", from: seatB, to: [seatA] }, seatA), true)
})

// ── the ledger ────────────────────────────────────────────────────────────────

test("the rule's decision is recorded once per live seat, at the moment of writing", () => {
  const before = store.readLedger().length
  store.send({ room: "team", from: seatB, type: "FACT", text: "senkit nem ébreszt" })
  const recs = store.readLedger().slice(before)
  const decisions = recs.filter(r => r.k === "decision")
  assert.ok(decisions.length >= 1, "a decision must be recorded for the other live seat")
  assert.ok(decisions.every(d => d.by === "rule" || d.by === "quiet"))
  assert.ok(decisions.some(d => d.woke === false), "a broadcast FACT wakes nobody, and that is the record")
})

test("a letterbox FAILURE is recorded as a failure, never as a yes", () => {
  // The letterbox fails open, so an unreachable classifier and an approving one produce the same
  // wake-up. Collapsing them in the ledger would hide the one number that says whether the
  // letterbox is earning its cost.
  store.recordDecision({ room: "team", seat: seatA, entry: "x1", by: "letterbox", woke: true })
  store.recordDecision({ room: "team", seat: seatA, entry: "x2", by: "letterbox-failed", woke: true })
  const s = store.stats({ rooms: ["team"] })
  const team = s.rooms.find(r => r.room === "team")
  assert.equal(team.decisions.letterbox, 1)
  assert.equal(team.decisions["letterbox-failed"], 1)
})

test("a decision with no delivery is visible — that is the seat nobody could wake", () => {
  store.recordDecision({ room: "gap", seat: seatA, entry: "g1", by: "rule", woke: true })
  const team = store.stats({ rooms: ["gap"] }).rooms.find(r => r.room === "gap")
  assert.equal(team.woke, 1)
  assert.equal(team.announced + team.blocked, 0, "decided, never delivered — the weakest link, as a number")
})

test("recording NEVER throws, even when the store cannot be written", () => {
  // Same rule as the heartbeat: this sits on the PostToolUse path and inside the long poll.
  assert.doesNotThrow(() => store.recordDecision({ room: "x", seat: "a/b\\c#1", entry: "t", by: "rule", woke: false }))
  assert.doesNotThrow(() => store.recordWake({ room: null, seat: undefined, entry: null, how: "announced" }))
})

test("a corrupt ledger line is skipped and the rest still counts", () => {
  const f = readdirSync(join(ROOT, "stats"))[0]
  const path = join(ROOT, "stats", f)
  writeFileSync(path, readFileSync(path, "utf8") + "{ ez nem json\n")
  assert.doesNotThrow(() => store.readLedger())
  assert.ok(store.readLedger().length > 0, "the readable lines survive a corrupt one")
})

test("`stats` reports the window it covers, and reads nothing it should not", () => {
  const cursorsBefore = existsSync(join(ROOT, "cursors.json")) ? readFileSync(join(ROOT, "cursors.json"), "utf8") : null
  const s = store.stats()
  assert.ok(s.window?.from && s.window?.to, "the window is stated, because the ledger is bounded")
  const after = existsSync(join(ROOT, "cursors.json")) ? readFileSync(join(ROOT, "cursors.json"), "utf8") : null
  assert.equal(after, cursorsBefore, "`stats` may not move a cursor")
})

test("`stats` on an empty ledger is not a measured zero", () => {
  const empty = mkdtempSync(join(tmpdir(), "sac-empty-"))
  // A separate store, read through the same code path: no records, and nothing invented.
  const s = store.stats({ rooms: ["definitely-not-a-room"] })
  assert.equal(s.rooms.find(r => r.room === "definitely-not-a-room")?.entries || 0, 0)
  assert.ok(existsSync(empty))
})

test("REGRESSION: the hook registers room by room, and every one of them lands", () => {
  // The SessionStart hook loops over the configured rooms and calls `register` once per room.
  // A seed that only fired on the FIRST call left a seat in one room and silently out of the
  // rest — caught by hand on 2026-08-11 while testing `sac rooms`, not by any of the above.
  const s = "loop#1234"
  store.register({ agent: "loop", session: "1234", room: "team", writer: s })
  store.register({ agent: "loop", session: "1234", room: "design", writer: s })
  assert.deepEqual(store.members(s), ["design", "team"])
})

test("REGRESSION: leaving survives the next hook run — the environment may add, never restore", () => {
  const s = "loop#1234"
  store.partRoom(s, "design")
  store.register({ agent: "loop", session: "1234", room: "design", writer: s })
  assert.deepEqual(store.members(s), ["team"], "a hook run undid a decision somebody made")
  // …and an explicit join is how you come back, because that is a decision too.
  assert.deepEqual(store.joinRoom(s, "design"), ["design", "team"])
  store.register({ agent: "loop", session: "1234", room: "design", writer: s })
  assert.deepEqual(store.members(s), ["design", "team"], "re-joining must stick just as hard")
})

test("REGRESSION: quiet silences the WATCHER, not the Stop hook — the two paths cost differently", () => {
  // Caught 2026-08-11 by a sibling session reading the code hours after it was written. `sac wait`
  // starts a turn while the agent is WORKING — that is the interruption quiet is for. The Stop
  // hook runs only where the turn was ending anyway: it interrupts nothing, and it is the last
  // net before a session goes away. Applying quiet to both let a silent seat stop with an unread
  // REQUEST addressed to it, and if that session never returned, "not now" became "never".
  store.setQuiet(seatA, { quiet: true })
  store.send({ room: "team", from: seatB, type: "REQUEST", text: "ezt meg kell csinálni", to: [seatA] })

  const watcher = store.inbox({ room: "team", agent: seatA, advance: false })
  assert.equal(watcher.messages.at(-1).wakes, false, "the watcher must stay silent for a quiet seat")

  const stopHook = store.inbox({ room: "team", agent: seatA, advance: false, respectQuiet: false })
  assert.equal(stopHook.messages.at(-1).wakes, true,
    "the Stop hook must still see what this seat owes an answer to — it cannot interrupt anything")
  assert.ok(stopHook.unreadWaking >= 1, "…and count it, or the hook never blocks")
  store.setQuiet(seatA, { quiet: false })
})
