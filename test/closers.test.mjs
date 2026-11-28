// CLOSERS AND ALREADY-ANSWERED ENTRIES WAKE NOBODY — set-core's trace of the ledger, 2026-11-22..28
// (764 deliveries), asked for on 2026-11-28:
//
//   · in pair and relation rooms every entry wakes, and 64 FACT wake-ups there re-read 12.2M
//     context tokens; one "nothing to do" ANSWER woke a 470k-token asker twice. Only the SENDER
//     knows an entry is a closer, so the sender declares it (`send({ quiet: true })`);
//   · 72 entries were delivered twice to one seat, and in 6 the seat had answered (`re:`) between
//     the two deliveries without calling `inbox` — the Stop hook then held a turn on an entry it
//     had already answered.
//
// Everything is read back from the store — the file on disk, the inbox a real reader gets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-closers-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"
delete process.env.SET_AGENT_ROOM

const store = await import("../src/store.mjs")

let nextOwner = 993001
const seat = (agent, session, room = "lobby") =>
  store.register({ agent, session, room, project: `/work/${agent}`, owner: nextOwner++ }).writer

/** A seat DM the way `sac dm` makes one: the derived name, `pair` declared, both seats in it. */
const openDm = (a, b) => {
  const room = store.dmRoom(a, b)
  store.createRoom(room, a, { pair: [a, b].sort() })
  for (const s of [a, b]) store.joinRoom(s, room)
  return { room }
}

const asker = seat("asker", "a1110001-0000-4000-8000-000000000001")
const desk = seat("desk", "d1110001-0000-4000-8000-000000000001")
const room = store.openProjectRoom(asker, desk).room

test("a QUIET answer in a relation room is delivered, read — and wakes nobody", () => {
  const q = store.send({ room, from: asker, type: "REQUEST", text: "anything for me?" })
  assert.deepEqual(q.wakes, [desk], "precondition: the relation room wakes the other side")
  const a = store.send({ room, from: desk, type: "ANSWER", text: "nothing to do", re: q.ts, quiet: true })
  assert.deepEqual(a.wakes, [], "a declared closer interrupted the asker")
  assert.equal(a.quiet, true, "the receipt does not say the entry went out quiet")
  assert.match(a.notice.join(" "), /Quiet: interrupts nobody/)
  const r = store.inbox({ room, agent: asker, advance: false })
  const got = r.messages.find(m => m.ts === a.ts)
  assert.ok(got, "the closer was not DELIVERED — quiet may cost the turn, never the message")
  assert.equal(got.wakes, false)
  assert.equal(got.quiet, true)
  assert.equal(got.text, "nothing to do", "the marker leaked into the text the reader sees")
  assert.equal(got.re, q.ts, "the closer lost its thread")
})

test("…and in a seat DM, where every entry otherwise wakes", () => {
  const a = seat("dm-a", "a2220001-0000-4000-8000-000000000001")
  const b = seat("dm-b", "b2220001-0000-4000-8000-000000000001")
  const dm = openDm(a, b).room
  assert.deepEqual(store.send({ room: dm, from: a, type: "FACT", text: "loud" }).wakes, [b])
  assert.deepEqual(store.send({ room: dm, from: a, type: "FACT", text: "thanks", quiet: true }).wakes, [])
})

test("a QUESTION or REQUEST cannot be quiet — it owes the reader a turn", () => {
  for (const type of ["QUESTION", "REQUEST"])
    assert.throws(() => store.send({ room, from: asker, type, text: "x", quiet: true }), /cannot be quiet/)
})

test("ON DISK the header is unchanged — a reader built before `quiet` still parses the entry", () => {
  // The compatibility claim behind putting the flag in the BODY: an older reader's header pattern
  // ends in `\s*$`, so a grown header would fold the entry into the previous one and lose it.
  const a = store.send({ room, from: desk, type: "FACT", text: "closing the thread", quiet: true })
  const raw = readFileSync(store.busFile(room, desk), "utf8")
  const at = raw.indexOf(`## ${a.ts}`)
  const [head, first] = raw.slice(at).split("\n")
  assert.equal(head, `## ${a.ts} — FACT`, "the header grew a token an older reader cannot parse")
  assert.equal(first, store.QUIET_MARK)
})

test("a quiet mark on an ASKING entry (another machine, a hand edit) is stripped and ignored", () => {
  // `ingest` is the wire's door: a REQUEST arriving with `quiet` still wakes.
  const ts = store.now()
  store.ingest({ room: "lobby", writer: "far@mac#11112222", ts, type: "REQUEST", text: "do it", quiet: true, to: [desk] })
  const got = store.inbox({ room: "lobby", agent: desk, advance: false }).messages.find(m => m.ts === ts)
  assert.equal(got.wakes, true, "a sender could silence a request by flagging it")
  assert.ok(!got.quiet)
  assert.equal(got.text, "do it")
})

test("a quiet FACT from another machine stays quiet here", () => {
  const ts = store.now()
  store.ingest({ room: "lobby", writer: "far@mac#11112222", ts, type: "FACT", text: "fyi", quiet: true, to: [desk] })
  const got = store.inbox({ room: "lobby", agent: desk, advance: false }).messages.find(m => m.ts === ts)
  assert.equal(got.quiet, true)
  assert.equal(got.wakes, false)
})

test("an entry this seat has ALREADY ANSWERED is no longer owed a turn — but is still delivered", () => {
  const a = seat("ans-a", "a3330001-0000-4000-8000-000000000001")
  const b = seat("ans-b", "b3330001-0000-4000-8000-000000000001")
  const dm = openDm(a, b).room
  const q = store.send({ room: dm, from: a, type: "REQUEST", text: "please check X" })
  const before = store.inbox({ room: dm, agent: b, advance: false })
  assert.equal(before.messages.find(m => m.ts === q.ts).wakes, true)
  // b answers straight from the watch's preview, never calling `inbox` — the cursor stays put.
  store.send({ room: dm, from: b, type: "ANSWER", text: "checked, fine", re: q.ts })
  const after = store.inbox({ room: dm, agent: b, advance: false })
  const still = after.messages.find(m => m.ts === q.ts)
  assert.ok(still, "the entry vanished — answering may not mark it read")
  assert.equal(still.wakes, false, "the Stop hook would hold a turn on an entry already answered")
  assert.equal(after.unreadWaking, 0)
  // A NEW entry in the same room still wakes: the rule is per entry, not per room.
  const q2 = store.send({ room: dm, from: a, type: "REQUEST", text: "and Y?" })
  assert.equal(store.inbox({ room: dm, agent: b, advance: false }).messages.find(m => m.ts === q2.ts).wakes, true)
})
