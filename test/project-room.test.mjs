// THE ROOM BETWEEN TWO PROJECTS — `store.projectRoom`, 2026-11-07.
//
// Asked for by the owner for a family of projects ("every block has to talk to the platform and to
// the umbrella, and those two to each other"), after three failures were measured on the live bus:
// the family talked in a 60-seat mixed room, a seat outside the sender's rooms could not be
// addressed at all, and the DM opened by hand to get round that carried two SESSION ids in its
// name — so the next session of either side was locked out of it. And the owner's line on waking,
// which these tests hold the room to: „feleslegesen ne keltsen senki fel másikat ha nem direkt van”.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-project-room-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"
delete process.env.SET_AGENT_ROOM

const store = await import("../src/store.mjs")

// A fake owner pid per window: a dead pid with a fresh `lastSeen` reads as `null` ("we do not
// know"), which every roster counts as reachable — the house rule for unknown liveness.
let nextOwner = 990001
const seat = (agent, session, room = "lobby") =>
  store.register({ agent, session, room, project: `/work/${agent}`, owner: nextOwner++ }).writer

const block = seat("block-a", "aaaa0001-0000-4000-8000-000000000001")
const platform = seat("platform", "pppp0001-0000-4000-8000-000000000001")
const stranger = seat("stranger", "ssss0001-0000-4000-8000-000000000001", "elsewhere")

test("the room is named after the two PROJECTS, sorted, and kept apart from a seat DM", () => {
  assert.equal(store.projectRoom("platform#pppp0001", "block-a"), "dm-block-a--platform")
  assert.equal(store.projectRoom("block-a", "platform"), store.projectRoom("platform", "block-a"))
  assert.throws(() => store.projectRoom("block-a#x", "block-a#y"), /two different projects/)
})

test("addressing a project you share no room with OPENS the relation's room — never a refusal", () => {
  const r = store.resolveRoom({ to: ["stranger"], configured: store.wakingRooms(block), from: block })
  assert.equal(r.room, "dm-block-a--stranger")
  assert.equal(r.inferred, true, "a room chosen for the sender has to be reported")
  assert.deepEqual(store.projectPairOf(r.room), ["block-a", "stranger"])
})

test("…and a SEAT name routes there too, keeping its address inside the room", () => {
  const r = store.resolveRoom({ to: [stranger], configured: store.wakingRooms(block), from: block })
  assert.equal(r.room, "dm-block-a--stranger")
  const sent = store.send({ room: r.room, from: block, type: "REQUEST", text: "are you there?", to: [stranger] })
  assert.deepEqual(sent.wakes, [stranger])
})

test("the relation's room wins over a shared mixed room — that is how traffic leaves the big one", () => {
  // block-a and platform both sit in `lobby`, a room with other people in it.
  store.openProjectRoom(block, platform)
  const r = store.resolveRoom({ to: ["platform"], configured: store.wakingRooms(block), from: block })
  assert.equal(r.room, "dm-block-a--platform")
})

test("a session that starts AFTER the room was opened is in it, with nobody running anything", () => {
  const later = seat("platform", "pppp0002-0000-4000-8000-000000000002", "somewhere-else")
  assert.ok(store.wakingRooms(later).includes("dm-block-a--platform"), "its watch would not see the room")
  assert.ok(store.liveSeats("dm-block-a--platform").includes(later), "the roster does not count it")
  assert.doesNotThrow(() => store.assertMayRead("dm-block-a--platform", later))
})

test("a third project may not read it — private to the two, like any DM", () => {
  assert.throws(() => store.assertMayRead("dm-block-a--platform", stranger), /channel between two/)
})

test("WAKING: with one live session on the other side, an unaddressed entry wakes exactly that one", () => {
  const room = store.openProjectRoom("solo-a", "solo-b").room
  const a = seat("solo-a", "a0000001-0000-4000-8000-000000000001")
  const aSibling = seat("solo-a", "a0000002-0000-4000-8000-000000000002")
  const b = seat("solo-b", "b0000001-0000-4000-8000-000000000001")
  const sent = store.send({ room, from: a, type: "FACT", text: "the schema moved to v2" })
  assert.deepEqual(sent.wakes, [b], "the other project's only session is the relation's addressee")
  assert.ok(!sent.wakes.includes(aSibling), "the writer's own sibling was woken by an entry not for it")
})

test("WAKING: with several sessions on the other side, a FACT wakes none of them; a REQUEST wakes them all", () => {
  const room = store.openProjectRoom("many-a", "many-b").room
  const a = seat("many-a", "c0000001-0000-4000-8000-000000000001")
  const b1 = seat("many-b", "d0000001-0000-4000-8000-000000000001")
  const b2 = seat("many-b", "d0000002-0000-4000-8000-000000000002")
  assert.deepEqual(store.send({ room, from: a, type: "FACT", text: "merged lane X" }).wakes, [],
    "a FACT woke a project's every session — the measured 2026-10-28 storm, in a room of its own")
  assert.deepEqual(store.send({ room, from: a, type: "REQUEST", text: "who owns the export?" }).wakes.sort(),
    [b1, b2].sort())
  assert.deepEqual(store.send({ room, from: a, type: "FACT", text: "yours", to: [b2] }).wakes, [b2],
    "naming the seat no longer reaches exactly that session")
})

test("the inbox agrees with `send`: the other side's entry is forMe, the writer's sibling reads it as not", () => {
  const room = store.openProjectRoom("inbox-a", "inbox-b").room
  const a = seat("inbox-a", "e0000001-0000-4000-8000-000000000001")
  const aSibling = seat("inbox-a", "e0000002-0000-4000-8000-000000000002")
  const b = seat("inbox-b", "f0000001-0000-4000-8000-000000000001")
  store.send({ room, from: a, type: "FACT", text: "for the other project" })
  const theirs = store.inbox({ room, agent: b, advance: false })
  assert.equal(theirs.unreadWaking, 1)
  assert.equal(theirs.messages[0].forMe, true)
  const sibling = store.inbox({ room, agent: aSibling, advance: false })
  assert.equal(sibling.messages[0].forMe, false, "the writer's sibling was told it was addressed")
  assert.equal(sibling.unreadWaking, 0)
})

test("a project room is never swept as dead — a project has no 'both seats gone'", () => {
  const room = store.openProjectRoom("sleepy-a", "sleepy-b").room
  assert.ok(!store.archiveDeadPairRooms({ dry: true }).includes(room))
})

test("a seat that PARTS the relation's room stays out of it", () => {
  const room = store.openProjectRoom("part-a", "part-b").room
  const b = seat("part-b", "g0000001-0000-4000-8000-000000000001")
  store.partRoom(b, room)
  assert.ok(!store.wakingRooms(b).includes(room), "the part was undone by the derivation")
  assert.ok(!store.liveSeats(room).includes(b))
})

test("a name no project on this machine has gets no room minted for it", () => {
  assert.throws(() => store.resolveRoom({ to: ["ghost"], configured: store.wakingRooms(block), from: block }),
    /is in no room you are in/)
  assert.equal(store.roomExists("dm-block-a--ghost"), false)
})
