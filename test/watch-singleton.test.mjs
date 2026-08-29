// One watch per seat, and never older than the code it runs.
//
// Both rules exist because of what was measured on 2026-08-27: 19 live `sac wait` processes held
// by 8 Claude Code sessions (one session had five), 2.31 GB of RSS in watchers alone, and 57
// duplicate wake-ups in the ledger — the same entry reported by two to four watchers of one seat.
// The tests spawn REAL processes, because both rules are about process lifetime and neither can
// be observed from inside one.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, readdirSync, utimesSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"

const ROOT = mkdtempSync(join(tmpdir(), "sac-watch-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = "0"           // "no window" — see the note in store.test.mjs
const store = await import("../src/store.mjs")
const SAC = new URL("../bin/sac.mjs", import.meta.url).pathname
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const settle = async (fn, ms = 4000) => {                 // poll until true, or give up
  for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50) }
  return false
}

test("claimWatch stops the older watch of the SAME window, and records the new one", async () => {
  // A process of our own making, parked in a sleep — it only has to exist and to look right.
  const old = spawn(process.execPath, [SAC, "wait", "no-such-room"],
    { stdio: "ignore", env: { ...process.env, SET_AGENT_COMM_DIR: ROOT } })
  await settle(() => alive(old.pid))
  store.claimWatch({ seat: "proj#aaaa", rooms: ["r"], pid: old.pid, owner: 4242 })

  const claim = store.claimWatch({ seat: "proj#aaaa", rooms: ["r"], pid: process.pid, owner: 4242 })
  assert.deepEqual(claim.superseded, [old.pid], "the older watch of this window was left running")
  assert.ok(await settle(() => !alive(old.pid)), "it was signalled but never exited")

  const stamp = JSON.parse(readFileSync(join(ROOT, "watches", "proj#aaaa.json"), "utf8"))
  assert.equal(stamp.pid, process.pid, "the claim did not record the NEW watch")
  assert.equal(stamp.owner, 4242)
})

test("a watch of ANOTHER window is never touched — two windows are two watches", async () => {
  const other = spawn(process.execPath, [SAC, "wait", "no-such-room"], { stdio: "ignore" })
  await settle(() => alive(other.pid))
  store.claimWatch({ seat: "proj#bbbb", rooms: ["r"], pid: other.pid, owner: 1111 })
  const claim = store.claimWatch({ seat: "proj#bbbb", rooms: ["r"], pid: process.pid, owner: 2222 })
  assert.deepEqual(claim.superseded, [], "it stopped a DIFFERENT window's watch")
  assert.ok(alive(other.pid), "the other window's watch was killed")
  other.kill("SIGKILL")
})

test("with no window (cron, a bare terminal) nothing is stopped", async () => {
  const hand = spawn(process.execPath, [SAC, "wait", "no-such-room"], { stdio: "ignore" })
  await settle(() => alive(hand.pid))
  store.claimWatch({ seat: "proj#cccc", rooms: ["r"], pid: hand.pid, owner: null })
  const claim = store.claimWatch({ seat: "proj#cccc", rooms: ["r"], pid: process.pid, owner: null })
  assert.deepEqual(claim.superseded, [], "'no window' was treated as an identity")
  assert.ok(alive(hand.pid))
  hand.kill("SIGKILL")
})

test("⚠ a REUSED pid is not signalled — the stamp is checked against the live argv", async () => {
  // The dangerous case: the watcher exited, the kernel handed its number to something else.
  // `alive()` cannot tell the difference; only the argv can, and getting it wrong means sending
  // SIGTERM to a stranger's process.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  await settle(() => alive(stranger.pid))
  store.claimWatch({ seat: "proj#dddd", rooms: ["r"], pid: stranger.pid, owner: 7777 })
  const claim = store.claimWatch({ seat: "proj#dddd", rooms: ["r"], pid: process.pid, owner: 7777 })
  assert.deepEqual(claim.superseded, [], "it signalled a process that is not a watch")
  assert.ok(alive(stranger.pid), "a process that merely inherited the pid was killed")
  stranger.kill("SIGKILL")
})

test("a second `sac wait` for one seat stops the first — end to end, real processes", async () => {
  const env = { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: "solo",
                SET_AGENT_ROOM: "solo-room", SET_AGENT_OWNER_PID: String(process.pid),
                SET_AGENT_TRIAGE: "off", SET_AGENT_SAFETY_NET: "off" }
  store.createRoom("solo-room", "test")
  const first = spawn(process.execPath, [SAC, "wait"], { stdio: ["ignore", "ignore", "pipe"], env })
  // Wait for the claim to be ON DISK rather than for a fixed delay: the seat name is resolved
  // inside the process, so this is also the assertion that a watch stamps itself at all.
  const claimed = () => { try { return readdirSync(join(ROOT, "watches")).filter(f => f.startsWith("solo")) } catch { return [] } }
  assert.ok(await settle(() => claimed().length > 0, 8000), "the first watch never claimed the seat")

  let saidSo = ""
  const second = spawn(process.execPath, [SAC, "wait"], { stdio: ["ignore", "ignore", "pipe"], env })
  second.stderr.on("data", d => { saidSo += d })
  const gone = await settle(() => !alive(first.pid), 8000)
  const stamp = (() => { try { return readFileSync(join(ROOT, "watches", claimed()[0]), "utf8") } catch { return "(none)" } })()
  second.kill("SIGKILL"); first.kill("SIGKILL")
  assert.ok(gone, `the first watch survived the second one arming — this is the duplicate that was measured.
    first=${first.pid} second=${second.pid} stderr=${JSON.stringify(saidSo)} stamp=${stamp}`)
  assert.match(saidSo, /stopped 1 older watch/, "it stopped the duplicate SILENTLY")
})

test("sourceStamp follows the newest source file, and only the sources", () => {
  const before = store.sourceStamp()
  assert.ok(before > 0, "it could not read the code it is running")
  const f = new URL("../src/store.mjs", import.meta.url).pathname
  const was = statSync(f)
  const future = new Date(Date.now() + 60_000)
  try {
    utimesSync(f, future, future)
    assert.ok(store.sourceStamp() > before, "a changed source did not move the stamp")
  } finally { utimesSync(f, was.atime, was.mtime) }
})

test("⚠ TWO watches armed in the same instant: exactly one survives", async () => {
  // The race the read-back exists for, and the one a sequential test cannot see: both processes
  // read "no previous claim", both stop nothing. Found by running this file inside the full
  // suite, where the two spawns landed on consecutive pids.
  const env = { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: "dead-heat",
                SET_AGENT_ROOM: "heat-room", SET_AGENT_OWNER_PID: String(process.pid),
                SET_AGENT_TRIAGE: "off" }
  store.createRoom("heat-room", "test")
  const both = [0, 1].map(() =>
    spawn(process.execPath, [SAC, "wait"], { stdio: ["ignore", "ignore", "pipe"], env }))
  await settle(() => both.filter(p => !alive(p.pid)).length > 0, 8000)
  await sleep(300)
  const left = both.filter(p => alive(p.pid))
  both.forEach(p => p.kill("SIGKILL"))
  assert.equal(left.length, 1, `${left.length} watches survived — one seat, one watch`)
})

test("a watch that outlives its age cap exits, so the Monitor starts a fresh one", async () => {
  // 0.0005 h = 1.8 s. The cap is in hours because that is the unit anyone would set it in; the
  // guard's own tick follows it down, which is what makes this observable in a test at all.
  const env = { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: "short-lived",
                SET_AGENT_ROOM: "cap-room", SET_AGENT_OWNER_PID: String(process.pid),
                SET_AGENT_TRIAGE: "off", SET_AGENT_WATCH_MAX_HOURS: "0.0005" }
  store.createRoom("cap-room", "test")
  const w = spawn(process.execPath, [SAC, "wait"], { stdio: ["ignore", "pipe", "pipe"], env })
  let out = "", err = ""
  w.stdout.on("data", d => { out += d }); w.stderr.on("data", d => { err += d })
  const code = await new Promise(r => w.on("exit", c => r(c)))
  assert.equal(code, 0, "it exited non-zero — that reads as a failed command to whoever ran it")
  assert.match(err, /running for over/, "it exited without saying why")
  assert.equal(out, "", "it spoke on STDOUT — every line there is a notification, i.e. a whole turn")
})

// ── holding back a seat that is mid-turn ──────────────────────────────────────
// Measured 2026-08-27: 44 of 380 deliveries were the same entry announced by the Monitor and then
// blocked on by the Stop hook 119 s later — always in that order. The Monitor's turn was the
// expensive one and the Stop hook would have delivered anyway.
const wait = (name, session, extra = {}) => {
  const env = { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: name,
                SET_AGENT_ROOM: `${name}-room`, SET_AGENT_OWNER_PID: String(process.pid),
                CLAUDE_CODE_SESSION_ID: session, SET_AGENT_TRIAGE: "off",
                SET_AGENT_SAFETY_NET: "off", ...extra }
  const p = spawn(process.execPath, [SAC, "wait", "--once"], { stdio: ["ignore", "pipe", "pipe"], env })
  let out = ""
  p.stdout.on("data", d => { out += d })
  return { p, said: () => out }
}
// A seat is busy because the REAL PostToolUse hook ran and left a stamp — spawned the way Claude
// Code spawns it, so the test drives the mechanism rather than a stand-in for it. (An earlier
// version called `store.register` instead; that writes `lastSeen`, which every `sac` command
// writes too, and the hold would then have fired on a signal that means nothing.)
const HEARTBEAT = new URL("../hooks/heartbeat.mjs", import.meta.url).pathname
const beat = (name, session, room) => {
  const r = spawnSync(process.execPath, [HEARTBEAT], {
    env: { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: name, SET_AGENT_ROOM: room,
           CLAUDE_CODE_SESSION_ID: session, CLAUDE_PROJECT_DIR: "/tmp",
           SET_AGENT_OWNER_PID: String(process.pid) }, encoding: "utf8" })
  assert.equal(r.status, 0, "the heartbeat hook failed — it may never fail a turn")
}

test("a seat that is mid-turn is NOT announced to — the Stop hook will deliver it warm", async () => {
  store.createRoom("busy-proj-room", "test")
  const session = "b0000000-0000-4000-8000-000000000001"
  const me = store.claimSeat({ agent: "busy-proj", session, owner: process.pid })
  beat("busy-proj", session, "busy-proj-room")
  store.send({ room: "busy-proj-room", from: "someone#aaaa", type: "QUESTION",
               text: "anyone got a minute", to: ["busy-proj"] })
  const w = wait("busy-proj", session)
  await sleep(2500)
  const said = w.said(); w.p.kill("SIGKILL")
  assert.equal(said, "", `it woke a seat that was mid-turn: ${said}`)
  const held = readFileSync(join(ROOT, "stats", `${me}.jsonl`), "utf8")
  assert.match(held, /"by":"held-busy"/, "the hold was not recorded — it cannot be measured later")
})

test("…but a DIRECT address is never held back", async () => {
  store.createRoom("direct-proj-room", "test")
  const session = "d0000000-0000-4000-8000-000000000001"
  const me = store.claimSeat({ agent: "direct-proj", session, owner: process.pid })
  beat("direct-proj", session, "direct-proj-room")
  store.send({ room: "direct-proj-room", from: "someone#aaaa", type: "QUESTION",
               text: "you specifically", to: [me] })
  const w = wait("direct-proj", session)
  const code = await new Promise(r => { w.p.on("exit", c => r(c)); setTimeout(() => r("timeout"), 6000) })
  w.p.kill("SIGKILL")
  assert.match(w.said(), /you specifically/, `a deliberate address was delayed (exit: ${code})`)
})

test("…and once the seat goes quiet the entry is announced normally — a DELAY, not a drop", async () => {
  store.createRoom("quiet-proj-room", "test")
  const session = "c0000000-0000-4000-8000-000000000001"
  store.claimSeat({ agent: "quiet-proj", session, owner: process.pid })
  beat("quiet-proj", session, "quiet-proj-room")
  store.send({ room: "quiet-proj-room", from: "someone#aaaa", type: "QUESTION",
               text: "waited for you", to: ["quiet-proj"] })
  // The same watcher, with the busy window shrunk to nothing: the seat is no longer mid-turn.
  // This is the assertion that `shouldNudge` was NOT spent during the hold — if it had been, this
  // entry would stay silent for ever and the delay would be the drop.
  const w = wait("quiet-proj", session, { SET_AGENT_BUSY_MS: "1" })
  const code = await new Promise(r => { w.p.on("exit", c => r(c)); setTimeout(() => r("timeout"), 6000) })
  w.p.kill("SIGKILL")
  assert.match(w.said(), /waited for you/, `the held entry never arrived (exit: ${code})`)
})
