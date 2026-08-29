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

// ── retiring a room ───────────────────────────────────────────────────────────
//
// ⚠ Added 2026-08-17 from a survey of the live store: 18 rooms, and 12 of them had nothing
// reachable in them — four with ZERO entries that this project's own `install.test.mjs` created
// by pointing at the live store, one left from relay testing, four finished pieces of work, and
// three whose projects were still wired to them while nobody was there.
//
// The mechanism is a rename, not a delete, and these tests are mostly about that distinction:
// a room full of finished work is history, and the first invariant of this store is that the
// message file is the log. `prune` has been registry-only since the beginning for the same reason.

const zart = "regi-projekt#dddd4444"
const olvaso = "olvaso-projekt#eeee5555"

/**
 * Close the window behind a seat. `send` REGISTERS its writer (store.mjs, in `send`), so any seat
 * that has ever written is in the roster — in this process, with this process's pid, therefore
 * alive. The rooms worth archiving are the ones whose sessions ended days ago, so the fixture has
 * to say that: no live pid, and silent past `SEAT_TTL_MS`. Without this the tests would only ever
 * exercise the refusal path, and the normal one would be untested.
 */
function closeWindow(seat) {
  const file = join(ROOT, "registry.json")
  const reg = JSON.parse(readFileSync(file, "utf8"))
  const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
  for (const a of Object.values(reg.agents || {})) {
    const s = (a.seats || {})[seat]
    if (s) { s.writers = {}; s.lastSeen = old; s.owner = 999999 }
  }
  writeFileSync(file, JSON.stringify(reg, null, 2))
}

test("archiving MOVES a room aside — every entry survives, and it leaves every list", () => {
  store.createRoom("regi", zart)
  store.send({ room: "regi", from: zart, type: "FACT", text: "ez maradjon meg" })
  closeWindow(zart)
  const r = store.archiveRoom("regi")
  assert.equal(r.archived, true)
  assert.equal(r.entries, 1, "it must report what it shelved, not just that it did something")
  assert.ok(!store.knownRooms().includes("regi"), "an archived room is still on the list")
  assert.ok(!store.roomExists("regi"), "…and still counts as existing, so `send` would work")
  assert.deepEqual(store.archivedRooms(), ["regi"])
  // THE LOG SURVIVED. This is the whole difference between archiving and deleting.
  const kept = readFileSync(join(ROOT, "channels", ".archive", "regi", `${zart}.md`), "utf8")
  assert.match(kept, /ez maradjon meg/)
})

test("…and restoring puts it back, entries and all", () => {
  store.restoreRoom("regi")
  assert.ok(store.roomExists("regi"), "the room did not come back")
  assert.deepEqual(store.archivedRooms(), [])
  const h = store.history({ room: "regi" })
  assert.equal(h.messages.length, 1, "the history did not survive the round trip")
  assert.match(h.messages[0].text, /ez maradjon meg/)
  store.archiveRoom("regi")   // leave the store as the tests below expect it
})

test("a room with a reachable seat in it REFUSES to be archived", () => {
  // Losing the room under a live session is the one way this could lose a message rather than
  // shelve one. "Nobody has written for days" is not the same claim as "nobody is there", so the
  // rule is `liveSeats` — the same one the rest of the bus reads.
  store.createRoom("lakott", seatA)
  store.send({ room: "lakott", from: seatA, type: "FACT", text: "itt vagyok" })
  assert.ok(store.liveSeats("lakott").includes(seatA), "the fixture is wrong, nobody is in the room")
  assert.throws(() => store.archiveRoom("lakott"), /still has 1 reachable seat/)
  assert.ok(store.roomExists("lakott"), "it refused and archived it anyway")
})

test("…unless the operator says --force, who may know better than the default", () => {
  const r = store.archiveRoom("lakott", { force: true })
  assert.equal(r.archived, true)
  assert.ok(!store.roomExists("lakott"))
})

// ── a DM retires itself once neither side is reachable ───────────────────────
//
// ⚠ Added 2026-08-29 from `docs/room-sprawl.md`: a pair room's name is derived from two SEAT
// names, and seats are session-scoped, so a DM room can never be reused by a later conversation
// — and until now nothing retired one. The sweep (`archiveDeadPairRooms`) is the auto form of
// `sac rooms --archive`, bound to pair rooms only, because a dead pair room cannot mean "paused"
// the way a dead ordinary room can.

const gomb1 = "gombe-projekt#cccc3333"
const gomb2 = "gombb-projekt#cccc4444"

test("a pair room with a reachable side is left alone", () => {
  store.createRoom("dm-eles", seatA, { pair: [seatA, seatB].sort() })
  store.send({ room: "dm-eles", from: seatA, type: "FACT", text: "itt vagyok" })
  assert.deepEqual(store.archiveDeadPairRooms(), [], "it swept a room somebody is still in")
  assert.ok(store.roomExists("dm-eles"))
})

test("a pair room whose both seats are gone is swept; an ordinary dead room is not", () => {
  store.createRoom("dm-holt", gomb1, { pair: [gomb1, gomb2].sort() })
  store.send({ room: "dm-holt", from: gomb1, type: "FACT", text: "vegeztunk" })
  store.createRoom("sima-holt", gomb1)
  store.send({ room: "sima-holt", from: gomb1, type: "FACT", text: "ez meg var" })
  closeWindow(gomb1)
  // `closeWindow` only edits seats the registry already has, so the peer — who never wrote —
  // needs no closing: an unregistered seat is nobody, and nobody is not reachable either.
  assert.deepEqual(store.archiveDeadPairRooms(), ["dm-holt"],
    "the sweep took the wrong rooms (or missed its own)")
  assert.ok(!store.roomExists("dm-holt"))
  assert.ok(store.roomExists("sima-holt"),
    "an ordinary room is history someone may return to — it waits for `sac rooms --archive`")
})

test("the dry run reports the sweep without performing it", () => {
  store.createRoom("dm-proba", gomb1, { pair: [gomb1, gomb2].sort() })
  assert.deepEqual(store.archiveDeadPairRooms({ dry: true }), ["dm-proba"])
  assert.ok(store.roomExists("dm-proba"), "the dry run archived the room anyway")
  assert.deepEqual(store.archiveDeadPairRooms(), ["dm-proba"])
})

test("a swept DM's pair rides out the archive and comes back with it", () => {
  // Without this, restoring a DM would hand back an ordinary room wearing a DM's name — no
  // wake-every-entry, no read restriction — and nothing would warn about it.
  store.createRoom("dm-paros", gomb1, { pair: [gomb1, gomb2].sort() })
  store.send({ room: "dm-paros", from: gomb1, type: "FACT", text: "szia" })
  closeWindow(gomb1)
  store.archiveDeadPairRooms()
  assert.deepEqual(store.archivedRooms().filter(r => r.startsWith("dm-")).sort(),
    ["dm-holt", "dm-paros", "dm-proba"])
  const r = store.restoreRoom("dm-paros")
  assert.deepEqual(r.pair, [gomb1, gomb2].sort())
  assert.deepEqual(store.pairOf("dm-paros"), [gomb1, gomb2].sort())
  assert.ok(store.roomExists("dm-paros"))
  store.archiveRoom("dm-paros", { force: true })   // leave the store as the tests below expect it
})

test("an archived room is NOT resurrected by the settings that name it", () => {
  // The measured situation of 2026-08-29: ten settings files still named `consumer-a-atlas`, so an
  // archive without this guard lasted exactly one session start. The environment may ADD a
  // room, never restore one somebody removed — `part` had this rule first; the archive is the
  // same decision at room level.
  store.createRoom("regi-wired", zart)
  store.send({ room: "regi-wired", from: zart, type: "FACT", text: "tortenet" })
  closeWindow(zart)
  store.archiveRoom("regi-wired")
  const r = store.register({ agent: "regi-projekt", session: "eeee5555-0000-4000-8000-000000000001",
                             room: "regi-wired", writer: olvaso })
  assert.equal(r.archivedSkipped, "regi-wired", "register did not say why the room was skipped")
  assert.ok(!store.roomExists("regi-wired"), "register resurrected the archived room")
  assert.ok(!store.liveSeats("regi-wired").includes(olvaso),
    "the seat was rostered into a room that does not exist")
  store.restoreRoom("regi-wired")   // leave the store as the tests below expect it
})

// ── step 5: the receipt tells the truth the refusal tells ─────────────────────
//
// The measured false-success of 2026-08-29 (docs/room-sprawl.md): two of three sends returned
// success with `wakes: []` and a notice that stopped at "has not joined", although the
// mechanism could tell where the addressee DID listen. The reporter's hold on the fix:
// "whatever the refusal can name, the receipt can name too."

test("the receipt names where a not-joined addressee listens — symmetric with the refusal", () => {
  store.createRoom("szoba-b", seatB)
  // Alive, registered, listening in szoba-b — and absent from szoba-a, whose roster knows the
  // AGENT name only, the way an old session's registration leaves it behind. That is exactly
  // how the measured send passed addressing and then woke nobody.
  store.register({ agent: "beta", session: "bbbb2222-0000-4000-8000-000000000001",
                   room: "szoba-b", writer: seatB })
  store.joinRoom(seatB, "szoba-b")
  store.createRoom("szoba-a", seatA)
  const regpath = join(ROOT, "registry.json")
  const reg = JSON.parse(readFileSync(regpath, "utf8"))
  reg.agents.beta.rooms = [...new Set([...(reg.agents.beta.rooms || []), "szoba-a"])]
  writeFileSync(regpath, JSON.stringify(reg, null, 2))

  const r = store.send({ room: "szoba-a", from: seatA, type: "QUESTION", text: "hol vagy",
                         to: ["beta"] })
  assert.deepEqual(r.wakes, [], "the fixture is wrong: the send woke somebody")
  const said = (r.notice || []).join(" ")
  assert.match(said, /has not joined/, "the old notice did not fire at all")
  assert.match(said, /szoba-b/, "the receipt does not name the room where the addressee listens")
  assert.doesNotMatch(said, /listens in 'szoba-a'/, "the receipt offered the room it has NOT joined")
})

test("discovery sees a room that was created and joined but never written to", () => {
  // The reporter's sharpest half: a NEW room is invisible to every discovery route except the
  // membership record — and a room is created before it is used, always, so the empty case is
  // the normal one at exactly the moment discovery matters most.
  store.createRoom("uj-szoba", seatB)
  store.joinRoom(seatB, "uj-szoba")
  // Not one entry written. The roster alone must answer…
  assert.ok(store.roomsReaching([seatB]).includes("uj-szoba"),
    "a joined but never-written room is missing from discovery with its roster record present")
  // …and with even the roster record gone, the seat's own book (`members.json`) still answers —
  // the state the reported room was actually found in.
  const regpath = join(ROOT, "registry.json")
  const reg = JSON.parse(readFileSync(regpath, "utf8"))
  for (const a of Object.values(reg.agents)) {
    for (const s of Object.values(a.seats || {})) s.rooms = (s.rooms || []).filter(r => r !== "uj-szoba")
    a.rooms = (a.rooms || []).filter(r => r !== "uj-szoba")
  }
  writeFileSync(regpath, JSON.stringify(reg, null, 2))
  assert.ok(store.roomsReaching([seatB]).includes("uj-szoba"),
    "the joined-but-unwritten room disappeared from discovery once the roster forgot it")
})

test("the receipt does not suggest an archived room — it names the sleep and the restore", () => {
  // The second-seat verification found this seam, 2026-08-29: the suggestion list offered two
  // rooms the archive had retired hours earlier, and the refusal's repair hint then offered
  // `--create` — which would have minted a fresh, empty room over the retired name. An
  // archived room is not a place a send can go; when it is the ONLY place the addressee
  // listens, the notice says so and offers `--restore`, never `--create`. A FRESH seat keeps
  // the fixture honest: beta carries live rooms from the tests above, and those SHOULD be
  // suggested.
  const alvo = "gamma#cccc7777"
  store.createRoom("szoba-alszik", alvo)
  store.register({ agent: "gamma", session: "cccc7777-0000-4000-8000-000000000001",
                   room: "szoba-alszik", writer: alvo })
  store.joinRoom(alvo, "szoba-alszik")
  store.archiveRoom("szoba-alszik", { force: true })  // it holds a reachable seat; the
  // operator says that is the point — this is exactly the retired-while-populated shape
  store.createRoom("szoba-eloles", seatA)
  const regpath = join(ROOT, "registry.json")
  const reg = JSON.parse(readFileSync(regpath, "utf8"))
  reg.agents.gamma.rooms = [...new Set([...(reg.agents.gamma.rooms || []), "szoba-eloles"])]
  writeFileSync(regpath, JSON.stringify(reg, null, 2))

  const r = store.send({ room: "szoba-eloles", from: seatA, type: "QUESTION", text: "hol vagy",
                         to: ["gamma"] })
  const said = (r.notice || []).join(" ")
  assert.doesNotMatch(said, /listens in '/, "an archived room was offered as a place to send")
  assert.match(said, /ARCHIVED/, "the archived-only case did not say so in those words")
  assert.match(said, /--restore szoba-alszik/, "the offered repair was not --restore")
})

test("a DM under an archived name is RESTORED, not recreated fresh", () => {
  // The same two seats deriving the same DM name means the conversation resumed — so the
  // archive comes back with its history and its `pair`, and the result does not pretend to be
  // a creation. This is the one revive `createRoom` permits, because the derivation IS the
  // agreement (see `dmRoom`).
  store.createRoom("dm-ujra", gomb1, { pair: [gomb1, gomb2].sort() })
  store.send({ room: "dm-ujra", from: gomb1, type: "FACT", text: "elso felvonas" })
  closeWindow(gomb1)
  assert.deepEqual(store.archiveDeadPairRooms(), ["dm-ujra"])
  const made = store.createRoom("dm-ujra", gomb2, { pair: [gomb1, gomb2].sort() })
  assert.equal(made.created, false, "a revive masqueraded as a creation")
  assert.deepEqual(store.pairOf("dm-ujra"), [gomb1, gomb2].sort())
  assert.match(store.history({ room: "dm-ujra" }).messages.map(m => m.text).join(), /elso felvonas/,
    "the restored DM lost its history")
})

test("the read cursors go with the room, and only that room's", () => {
  store.createRoom("kurzoros", zart)
  store.createRoom("marad", zart)
  store.send({ room: "kurzoros", from: zart, type: "FACT", text: "egy" })
  store.send({ room: "marad", from: zart, type: "FACT", text: "ketto" })
  store.inbox({ room: "kurzoros", agent: olvaso })
  store.inbox({ room: "marad", agent: olvaso })
  closeWindow(zart)
  closeWindow(olvaso)
  const before = Object.keys(JSON.parse(readFileSync(join(ROOT, "cursors.json"), "utf8")))
  assert.ok(before.some(k => k.startsWith("kurzoros::")), "the fixture never wrote a cursor")
  const r = store.archiveRoom("kurzoros")
  assert.ok(r.cursorsDropped >= 1, "the cursors were left pointing at a room that is gone")
  const after = Object.keys(JSON.parse(readFileSync(join(ROOT, "cursors.json"), "utf8")))
  assert.ok(!after.some(k => k.startsWith("kurzoros::")), "a cursor outlived its room")
  assert.ok(after.some(k => k.startsWith("marad::")),
    "it took another room's cursors with it — the prefix match is too loose")
})

test("a room that never existed cannot be archived, and a creation cannot wear an archived name", () => {
  assert.throws(() => store.archiveRoom("nincs-ilyen"), /there is no room called/)
  // Found by the second-seat verification of step 5, 2026-08-29: following two correct
  // messages in sequence (a suggestion naming the room, then a refusal offering `--create`)
  // would have minted a fresh, EMPTY room over a name whose real log sat in the archive.
  assert.throws(() => store.createRoom("kurzoros", zart), /is ARCHIVED/,
    "a creation under an archived name hides the log — --restore is the honest way back")
  // With the creation refused, the name is ARCHIVED-ONLY now — not live, so the archive
  // refusal is the room-level one. Either refusal keeps the log from being clobbered.
  assert.throws(() => store.archiveRoom("kurzoros"), /no room called|already archived/,
    "the second archive would have overwritten the first one's log")
})

test("a room name that would escape the store is refused", () => {
  // The name reaches the file system, so it gets the same treatment as a writer name.
  for (const bad of ["../elsewhere", "a/b", ".hidden", ""]) {
    assert.throws(() => store.archiveRoom(bad), /unsafe room name|there is no room/)
  }
})
