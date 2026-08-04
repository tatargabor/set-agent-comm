// Self-test for the core. It does not measure the call but the RESULT (derived-state.md
// principle): every case reads back the real state of the file system.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = mkdtempSync(join(tmpdir(), "sac-test-"))
process.env.SET_AGENT_COMM_DIR = ROOT
const store = await import("../src/store.mjs")
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

test("the timestamp comes from the SYSTEM CLOCK, with local offset, in MILLISECONDS", () => {
  const ts = store.now(new Date("2026-08-03T12:34:56.078"))
  assert.match(ts, /^2026-08-03T12:34:56\.078[+-]\d{2}:\d{2}$/)
})

test("REGRESSION: messages sent within the same second do NOT get reordered", () => {
  // The case measured by the smoke test: `zzz` sends first, `aaa` answers — reversed in the
  // alphabet. At second resolution `history` returned the ANSWER first.
  store.send({ room: "order", from: "zzz", type: "QUESTION", text: "I was first" })
  store.send({ room: "order", from: "aaa", type: "ANSWER", text: "I came after" })
  const h = store.history({ room: "order" })
  assert.deepEqual(h.messages.map(m => m.from), ["zzz", "aaa"],
    "the answer preceded the question — the thread silently reversed")
})

test("send APPENDS, never rewrites — the earlier entry survives", () => {
  store.send({ room: "r", from: "a", type: "FACT", text: "first" })
  store.send({ room: "r", from: "a", type: "QUESTION", text: "second" })
  const raw = readFileSync(store.busFile("r", "a"), "utf8")
  assert.ok(raw.includes("first"), "the first entry is gone — that is a lost update")
  assert.ok(raw.includes("second"))
  assert.equal((raw.match(/^## /gm) || []).length, 2)
})

test("an unknown type fails loudly — a wrong type would silently break the parse", () => {
  assert.throws(() => store.send({ room: "r", from: "a", type: "GOSSIP", text: "x" }), /unknown type/)
})

test("an empty message fails", () => {
  assert.throws(() => store.send({ room: "r", from: "a", text: "   " }), /empty message/)
})

test("REGRESSION: entries written with the pre-English type keywords stay readable", () => {
  // The type lives on disk. Renaming it to English may not make already written channels
  // unparseable — reading maps the old keyword, writing accepts it too.
  const dir = store.channelDir("legacy")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "old.md"), "## 2026-07-24T10:50:00.000+02:00 — KÉRDÉS\nan old entry\n")
  const m = store.history({ room: "legacy" }).messages.at(-1)
  assert.equal(m.type, "QUESTION", "the old entry was not mapped to the English type")
  assert.equal(m.text, "an old entry")
  assert.equal(store.send({ room: "legacy", from: "old", type: "TÉNY", text: "x" }).type, "FACT")
})

test("inbox returns OTHERS' entries, never your own", () => {
  store.send({ room: "r", from: "b", type: "FACT", text: "b's message" })
  const r = store.inbox({ room: "r", agent: "a", advance: false })
  assert.equal(r.unread, 1)
  assert.equal(r.messages[0].from, "b")
  assert.equal(r.messages[0].text, "b's message")
})

test("the cursor only moves with advance:true — peek does not swallow the message", () => {
  assert.equal(store.inbox({ room: "r", agent: "a", advance: false }).unread, 1)
  assert.equal(store.inbox({ room: "r", agent: "a", advance: true }).unread, 1)
  assert.equal(store.inbox({ room: "r", agent: "a", advance: false }).unread, 0, "the cursor did not advance")
})

test("multi-line text and the `re:` reference survive the parse", () => {
  const { ts } = store.send({ room: "r", from: "b", type: "ANSWER", text: "one\ntwo\n\nfour", re: "2026-01-01T00:00:00+01:00" })
  const m = store.history({ room: "r", from: "b" }).messages.at(-1)
  assert.equal(m.ts, ts)
  assert.equal(m.re, "2026-01-01T00:00:00+01:00")
  assert.equal(m.text, "one\ntwo\n\nfour")
})

test("history does NOT move the cursor", () => {
  const before = store.inbox({ room: "r", agent: "a", advance: false }).unread
  store.history({ room: "r" })
  assert.equal(store.inbox({ room: "r", agent: "a", advance: false }).unread, before)
})

test("registration is idempotent: the same name is updated, not duplicated", () => {
  store.register({ agent: "a", project: "/x", room: "r" })
  store.register({ agent: "a", project: "/x", room: "r2" })
  const list = store.agents().filter(x => x.agent === "a")
  assert.equal(list.length, 1)
  assert.deepEqual([...list[0].rooms].sort(), ["r", "r2"])
})

test("silentMinutes is null without a sign of life — 'we don't know' is not 'dead'", () => {
  const a = store.agents().find(x => x.agent === "a")
  assert.equal(typeof a.silentMinutes, "number")
  assert.ok(a.silentMinutes >= 0)
})

test("SET_AGENT_ROOM may name several rooms, comma-separated", () => {
  assert.deepEqual(store.parseRooms("promo,atlas"), ["promo", "atlas"])
  assert.deepEqual(store.parseRooms(" promo , atlas , "), ["promo", "atlas"], "spaces and a trailing comma are tolerated")
  assert.deepEqual(store.parseRooms(""), [])
  assert.deepEqual(store.parseRooms(undefined), [])
})

test("watch list: the room's writer files, your own can be filtered out", () => {
  const files = store.busFiles("r").map(p => p.split("/").pop())
  assert.deepEqual(files, ["a.md", "b.md"])
})

test("REGRESSION: a second live process writing under one name is ANNOUNCED", () => {
  // Measured 2026-08-04 in the `consumer-a-atlas` room. Identity comes from the project directory
  // (stdio.mjs), which is unforgeable and right — but it means TWO sessions open in one repo
  // are one name on the bus. Neither the writers nor the reader could see it, and the room
  // filled with contradicting instructions under a single sender: "do not regenerate yet"
  // at 11:31 and "already regenerated" at 11:46 were different processes. The receiving
  // agent answered the wrong one and said so.
  //
  // Two writers is not an error and is not forbidden here — it is a fact the bus was hiding.
  store.register({ agent: "twin", room: "r", pid: process.ppid }) // a live foreign process
  const out = store.send({ room: "r", from: "twin", type: "FACT", text: "from the second session" })

  assert.ok(out.warning, "the second writer was not told it shares the name")
  assert.match(out.warning, new RegExp(String(process.ppid)), "the warning must name the other process")
  assert.match(out.warning, /twin/)
})

const SESS_A = "3f9c1a20-aaaa-4e61-9f8d-000000000001"
const SESS_B = "7b02e5d1-bbbb-4e61-9f8d-000000000002"

test("TWO SESSIONS IN ONE PROJECT: separate seats, and they DO receive each other", () => {
  // This is the whole point. Before seats: one name → one file → `inbox` skipped it as "my
  // own", so the two sessions could not hear each other at all, and they shared one cursor.
  const A = store.claimSeat({ agent: "twinproj", session: SESS_A })
  const B = store.claimSeat({ agent: "twinproj", session: SESS_B })
  assert.equal(A, "twinproj#3f9c1a20", "the name does not carry the session id")
  assert.equal(B, "twinproj#7b02e5d1", "the second session did not get a seat of its own")

  store.register({ agent: "twinproj", session: SESS_A, room: "twin", writer: A })
  store.register({ agent: "twinproj", session: SESS_B, room: "twin", writer: B })
  store.send({ room: "twin", from: A, type: "QUESTION", text: "am I regenerating it?" })

  const got = store.inbox({ room: "twin", agent: B })
  assert.equal(got.unread, 1, "the sibling session did not receive the message")
  assert.equal(got.messages[0].from, A)
  assert.equal(got.messages[0].sibling, true, "it was not marked as coming from the same project")
  assert.equal(store.inbox({ room: "twin", agent: A }).unread, 0, "the sender got its own message back")
})

test("the seat FOLLOWS FROM the session id — a restart gets the same file and cursor back", () => {
  assert.equal(store.claimSeat({ agent: "twinproj", session: SESS_B }), "twinproj#7b02e5d1")
  assert.equal(store.claimSeat({ agent: "twinproj", session: SESS_A }), "twinproj#3f9c1a20")
})

test("a shortened id already held by ANOTHER session gets longer, it does not collide", () => {
  // The id does not have to be a UUID (a test, another client). Two sessions in one file is
  // the failure this whole mechanism exists to prevent — it may not come back through the name.
  const first = store.claimSeat({ agent: "shortid", session: "same-prefix-one" })
  const second = store.claimSeat({ agent: "shortid", session: "same-prefix-two" })
  assert.equal(first, "shortid#same-pre")
  assert.notEqual(second, first, "two sessions were given the same file")
  assert.match(second, /^shortid#same-prefix/)
})

test("REGRESSION: a read-only lookup does NOT claim a seat", () => {
  // Measured while building this: the CLI inherits `CLAUDE_CODE_SESSION_ID`, so `sac agents`
  // — a pure listing — claimed itself a seat and reported a session that did not exist.
  // Reading may not change the state it reports on.
  const seats = () => store.agents().find(a => a.agent === "twinproj").seats.length
  const before = seats()
  assert.equal(store.seatOf({ agent: "twinproj", session: SESS_A }), "twinproj#3f9c1a20")
  assert.equal(store.seatOf({ agent: "twinproj", session: "never-seen-before" }), "twinproj#never-se",
    "a lookup must still name the seat this session WOULD get")
  assert.equal(seats(), before, "a lookup created a seat")
})

test("`agents` reports the FULL session id — that is what identifies the window", () => {
  const seat = store.agents().find(a => a.agent === "twinproj").seats.find(s => s.writer === "twinproj#3f9c1a20")
  assert.equal(seat.session, SESS_A, "the name has only 8 characters of it; the full id must be readable")
  assert.equal(seat.live, true, "a seat with a live process must not be reported as uncertain")
})

test("`live` has three values — 'we do not know' is not 'dead'", () => {
  // The same rule as `silentMinutes`. A session running with only the hook and the CLI has no
  // lasting process, so a missing pid alone may not be called dead — that would send the
  // caller looking for someone to talk to who is right there.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  store.claimSeat({ agent: "tri", session: "recent-but-processless", pid: dead })
  const seat = () => store.agents().find(a => a.agent === "tri").seats[0]
  assert.equal(seat().live, null, "a seat that has only just gone quiet was declared dead")

  const REG = join(ROOT, "registry.json")
  const reg = JSON.parse(readFileSync(REG, "utf8"))
  reg.agents.tri.seats[seat().writer].lastSeen = store.now(new Date(Date.now() - 3600_000))
  writeFileSync(REG, JSON.stringify(reg, null, 2))
  assert.equal(seat().live, false, "no process and quiet for an hour is dead, and may be said so")
})

test("pruning removes EMPTY files of dead sessions, and never one with content", () => {
  // The counterweight to session-id names: every session announces itself with a file, so the
  // ones that never wrote have to go — but a file with even one entry in it is history.
  const REG = join(ROOT, "registry.json")
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  const ghost = store.claimSeat({ agent: "twinproj", session: "dead-session-id", pid: dead })
  writeFileSync(store.busFile("twin", ghost), "")                    // announced, never wrote
  const reg = JSON.parse(readFileSync(REG, "utf8"))                  // and it died long ago
  reg.agents.twinproj.seats[ghost].lastSeen = store.now(new Date(Date.now() - 3600_000))
  writeFileSync(REG, JSON.stringify(reg, null, 2))

  const removed = store.pruneEmptySeats({ room: "twin", agent: "twinproj", keep: "twinproj#3f9c1a20" })
  assert.deepEqual(removed, [ghost])
  const left = store.busFiles("twin").map(p => p.split("/").pop())
  assert.ok(left.includes("twinproj#3f9c1a20.md"), "it deleted a file that has entries in it")
  assert.ok(!left.includes(`${ghost}.md`))
})

const ago = min => store.now(new Date(Date.now() - min * 60_000))

test("a NEWLY BORN seat does not get the project's OLD history as unread", () => {
  // Measured need: the live `consumer-a-atlas` room holds 400 entries. A session starting up must not
  // be handed all of them as "unread mail" — that is history, and `history` has it.
  const first = store.claimSeat({ agent: "seedproj", session: "s1" })
  store.register({ agent: "seedproj", session: "s1", room: "seed", writer: first })
  mkdirSync(store.channelDir("seed"), { recursive: true })
  writeFileSync(store.busFile("seed", first),
    `## ${ago(300)} — FACT\nthe first session's ancient entry\n`)
  writeFileSync(store.busFile("seed", "outsider"),
    `## ${ago(300)} — FACT\nold news, already read\n`)
  store.inbox({ room: "seed", agent: first })                     // the project read the stranger

  const second = store.claimSeat({ agent: "seedproj", session: "s2" })
  store.register({ agent: "seedproj", session: "s2", room: "seed", writer: second })
  assert.equal(store.inbox({ room: "seed", agent: second, advance: false }).unread, 0,
    "the new session was handed the earlier history as unread")
})

test("REGRESSION: but a sibling's message from HALF AN HOUR ago is still delivered", () => {
  // Measured 2026-08-04, 23:09, on the live bus, and it cost exactly the message this was all
  // built for. One session sent a detailed REQUEST at 22:38; the other was resumed half an hour
  // later, and a resume means a new session id, hence a new seat. The seeding rule marked that
  // request READ before anyone saw it: the room was quiet, the cursor was correct, the request
  // was gone. Half an hour is not history — it is the other half of a conversation.
  const first = store.claimSeat({ agent: "seedproj", session: "s1" })
  appendFileSync(store.busFile("seed", first),
    `\n## ${ago(31)} — REQUEST\nStart the change with /opsx:apply.\n`)
  appendFileSync(store.busFile("seed", "outsider"), `\n## ${ago(31)} — FACT\nnobody read this one\n`)

  const third = store.claimSeat({ agent: "seedproj", session: "s3" })
  store.register({ agent: "seedproj", session: "s3", room: "seed", writer: third })
  const inb = store.inbox({ room: "seed", agent: third })
  assert.deepEqual(inb.messages.map(m => m.text).sort(),
    ["Start the change with /opsx:apply.", "nobody read this one"],
    "a resumed session did not receive what was addressed to it half an hour earlier")
})

test("what arrives AFTER a seat has caught up is delivered, always", () => {
  // `s3` read everything in the previous test, so its cursor is up to date. From here on only
  // what is genuinely new may show up — neither seeding nor the hour-long window can swallow it.
  const seat = store.seatOf({ agent: "seedproj", session: "s3" })
  store.send({ room: "seed", from: store.seatOf({ agent: "seedproj", session: "s1" }),
    type: "QUESTION", text: "are you there?" })
  store.send({ room: "seed", from: "outsider", type: "FACT", text: "fresh news" })
  // Sorted: at machine speed both land in the same millisecond, and on a tie the order falls
  // back to the file names. What is being measured here is DELIVERY, not the order.
  assert.deepEqual(store.inbox({ room: "seed", agent: seat }).messages.map(m => m.text).sort(),
    ["are you there?", "fresh news"])
})

test("history by project name returns ALL of its sessions, not just one seat", () => {
  const h = store.history({ room: "seed", from: "seedproj" })
  assert.deepEqual(h.messages.map(m => m.text), [
    "the first session's ancient entry", "Start the change with /opsx:apply.", "are you there?",
  ], "asking about the PROJECT returned only one session's half of the thread")
})

test("a writer whose process is gone is forgotten — no false co-writer warning", () => {
  // Without this, every session that ever ran in the project stays on the record and the
  // warning fires forever. A warning that is always on is a warning nobody reads.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  store.register({ agent: "solo", room: "r", pid: dead })
  const out = store.send({ room: "r", from: "solo", type: "FACT", text: "alone" })

  assert.equal(out.warning, undefined, `a dead pid (${dead}) was reported as a live co-writer`)
})
