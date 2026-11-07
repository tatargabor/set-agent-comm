// NOTHING MAY WAKE A SESSION NEEDLESSLY — the owner's line („feleslegesen ne keltsen senki fel
// másikat ha nem direkt van”), and three sources of needless wakes measured on 2026-11-08, the night
// nine projects moved their bus wiring into a plugin that configures no room:
//
//   1. a LIVE seat stayed in every room its old configuration had put it in, and went on being woken
//      from them (`store.dropUnconfigured`);
//   2. `send --to <project>` took a mixed room that reached the addressee — or refused, with two —
//      instead of the room between the two projects (`store.resolveRoom`);
//   3. the inbox watch was re-armed by reflex on every expiry, a whole re-read of context each
//      time (`hooks/watch-guard.mjs`, `store.awaitingReply`).
//
// And one that made a protection silent: the heartbeat skipped every seat with no configured room,
// so `seatBusy` never saw a plugin-wired seat working.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = mkdtempSync(join(tmpdir(), "sac-needless-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"
delete process.env.SET_AGENT_ROOM

const store = await import("../src/store.mjs")
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks")

let nextOwner = 991001
const seat = (agent, session, room) =>
  store.register({ agent, session, room, project: `/work/${agent}`, owner: nextOwner++, fromConfig: !!room }).writer

test("a room the CONFIGURATION put a seat in, the configuration takes it out of — a join it does not", () => {
  const s = seat("block", "a1000001-0000-4000-8000-000000000001", "big-room")
  store.createRoom("own-room", s)
  store.joinRoom(s, "own-room")
  assert.deepEqual(store.dropUnconfigured(s, []), ["big-room"])
  assert.ok(!store.wakingRooms(s, []).includes("big-room"), "still woken from a room its project left")
  assert.ok(!store.liveSeats("big-room").includes(s), "the roster still lists it — senders would count it")
  assert.ok(store.wakingRooms(s, []).includes("own-room"), "a room joined by hand was taken away")
  // Not a `part`: naming the room in the configuration again brings the seat straight back.
  store.register({ agent: "block", session: "a1000001-0000-4000-8000-000000000001", room: "big-room", writer: s, fromConfig: true })
  assert.ok(store.wakingRooms(s, []).includes("big-room"))
})

test("a room that was JOINED and then also configured stays a join — the configuration cannot demote it", () => {
  const s = seat("block2", "a2000001-0000-4000-8000-000000000001")
  store.createRoom("shared", s)
  store.joinRoom(s, "shared")
  store.register({ agent: "block2", session: "a2000001-0000-4000-8000-000000000001", room: "shared", writer: s, fromConfig: true })
  assert.deepEqual(store.dropUnconfigured(s, []), [])
  assert.ok(store.wakingRooms(s, []).includes("shared"))
})

test("a seat recorded before `seeded` existed loses nothing — a guess there would be a lost join", () => {
  const s = seat("legacy", "a3000001-0000-4000-8000-000000000001")
  store.setMembers(s, ["old-room"])   // the two-list record every older store has
  assert.deepEqual(store.dropUnconfigured(s, []), [])
  assert.ok(store.wakingRooms(s, []).includes("old-room"))
})

test("`--to <project>` goes to the room between the projects even where mixed rooms reach it", () => {
  const me = seat("umbrella", "b1000001-0000-4000-8000-000000000001", "mixed-1")
  store.register({ agent: "umbrella", session: "b1000001-0000-4000-8000-000000000001", room: "mixed-2", writer: me, fromConfig: true })
  const bank = seat("bank", "b2000001-0000-4000-8000-000000000001", "mixed-1")
  store.register({ agent: "bank", session: "b2000001-0000-4000-8000-000000000001", room: "mixed-2", writer: bank, fromConfig: true })
  // Measured: two mixed rooms reaching the addressee made this a refusal ("room is required").
  const r = store.resolveRoom({ to: ["bank"], configured: store.wakingRooms(me, []), from: me })
  assert.equal(r.room, "dm-bank--umbrella")
  assert.equal(r.inferred, true, "a room chosen for the sender has to be reported")
  // …and a room given explicitly is still used as given.
  assert.equal(store.resolveRoom({ room: "mixed-1", to: ["bank"], configured: [], from: me }).room, "mixed-1")
})

test("the heartbeat beats for a seat with NO configured room — the form a plugin ships", () => {
  const session = "c1000001-0000-4000-8000-000000000001"
  const env = { ...process.env, SET_AGENT_NAME: "plugged", CLAUDE_CODE_SESSION_ID: session,
                SET_AGENT_OWNER_PID: String(process.pid), CLAUDE_PROJECT_DIR: "/work/plugged" }
  delete env.SET_AGENT_ROOM
  const r = spawnSync(process.execPath, [join(HOOKS, "heartbeat.mjs")], { input: "{}", env, encoding: "utf8" })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "", "a heartbeat printed — that lands in the transcript on every tool call")
  const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  const s = reg.agents.plugged?.seats?.["plugged#c1000001"]
  assert.ok(s?.lastSeen, "no beat was recorded, so `seatBusy` can never see this seat working")
})

// ── the watch guard: a re-arm only for something this seat is waiting on ──────
const guard = (agent, session) => {
  const env = { ...process.env, SET_AGENT_NAME: agent, CLAUDE_CODE_SESSION_ID: session,
                SET_AGENT_OWNER_PID: String(process.pid), SET_AGENT_HEADLESS: "0" }
  const payload = { tool_name: "Monitor", cwd: `/work/${agent}`, permission_mode: "bypassPermissions",
                    tool_input: { command: `SET_AGENT_NAME=${agent} sac wait` } }
  const r = spawnSync(process.execPath, [join(HOOKS, "watch-guard.mjs")], { input: JSON.stringify(payload), env, encoding: "utf8" })
  assert.equal(r.status, 0)
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null
}

test("the guard: the first watch goes through, a reflex re-arm does not, a re-arm for an open REQUEST does", () => {
  const session = "d1000001-0000-4000-8000-000000000001"
  const me = store.register({ agent: "waiter", session, room: "talk", project: "/work/waiter", fromConfig: true }).writer
  const peer = seat("peer", "d2000001-0000-4000-8000-000000000001", "talk")
  assert.equal(guard("waiter", session), null, "the first watch of a session was declined")

  store.claimWatch({ seat: me, rooms: ["talk"], pid: 2 ** 22 + 7 })   // that watch, since expired
  const denied = guard("waiter", session)
  assert.equal(denied?.permissionDecision, "deny", "an expiry was re-armed with nothing to wait for")
  assert.match(denied.permissionDecisionReason, /Not re-arming/)

  const asked = store.send({ room: "talk", from: me, type: "REQUEST", text: "can you check the export?", to: [peer] })
  assert.equal(guard("waiter", session), null, "a seat waiting on an answer was left without its watch")
  assert.deepEqual(store.awaitingReply(me, { rooms: ["talk"] }).map(o => o.ts), [asked.ts])

  store.send({ room: "talk", from: peer, type: "ANSWER", text: "done", to: [me], re: asked.ts })
  assert.equal(guard("waiter", session)?.permissionDecision, "deny", "answered, and the watch still re-armed")
})
