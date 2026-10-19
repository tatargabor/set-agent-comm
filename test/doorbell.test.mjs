// THE DOORBELL — waking a seat through its session's own inbox socket instead of a watch.
//
// Measured since 2026-09-22 (docs/native-messaging.md): the inbox watch woke its session 328
// times, 229 of them 30-minute expiries, ~51M tokens of re-read context against 99 messages. And
// measured live 2026-10-19: a line posted into a session's socket wakes an idle default/auto
// session in ~2 s, while a bypass-mode receiver HOLDS it — a dialog, then nothing. These tests use
// a real Unix socket as the target, so what is asserted is the line that would arrive.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"
import net from "node:net"

const ROOT = mkdtempSync(join(tmpdir(), "sac-doorbell-"))
const HOME = mkdtempSync(join(tmpdir(), "sac-doorbell-home-"))
const PROJ = mkdtempSync(join(tmpdir(), "sac-doorbell-proj-"))
const SOCKS = mkdtempSync(join(tmpdir(), "sac-socks-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"
process.env.CLAUDE_CONFIG_DIR = HOME
process.env.SET_AGENT_FLEET_ROSTER = join(ROOT, "no-roster.json")

const store = await import("../src/store.mjs")
const doorbell = await import("../src/doorbell.mjs")
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks")
const SAC = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sac.mjs")

// A stand-in for a Claude Code session's inbox: records every complete line it is sent.
const servers = []
function inbox(name) {
  const path = join(SOCKS, `${name}.sock`)
  const lines = []
  const srv = net.createServer(c => {
    let buf = ""
    c.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
  })
  servers.push(srv)
  return new Promise(r => srv.listen(path, () => r({ path, lines })))
}
after(() => { for (const s of servers) s.close() })

const S = n => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`
const seat = (agent, n, owner) => {
  const w = store.claimSeat({ agent, session: S(n), owner })
  store.register({ agent, session: S(n), room: "team", owner })
  return w
}
store.createRoom("team", "x#00000000")
const alice = seat("alfa", 1, 7001)
const bob = seat("beta", 2, 7002)
const carol = seat("gamma", 3, 7003)

test("the inbound policy reads the settings files, and only an explicit `accept` counts as one", () => {
  assert.equal(store.inboundPolicy(PROJ), null)
  mkdirSync(join(PROJ, ".claude"), { recursive: true })
  writeFileSync(join(HOME, "settings.json"), JSON.stringify({ crossSessionInbound: "accept" }))
  assert.equal(store.inboundPolicy(PROJ), "accept")
  writeFileSync(join(PROJ, ".claude", "settings.json"), JSON.stringify({ crossSessionInbound: "hold" }))
  assert.equal(store.inboundPolicy(PROJ), "hold", "a repo `hold` is not overridden by a personal `accept`")
  writeFileSync(join(PROJ, ".claude", "settings.local.json"), JSON.stringify({ crossSessionInbound: "refuse" }))
  assert.equal(store.inboundPolicy(PROJ), "refuse")
  writeFileSync(join(PROJ, ".claude", "settings.json"), JSON.stringify({ crossSessionInbound: "yes please" }))
  rmSync(join(PROJ, ".claude", "settings.local.json"))
  rmSync(join(HOME, "settings.json"))
  assert.equal(store.inboundPolicy(PROJ), "hold", "an unrecognised value holds, as the harness does")
  rmSync(join(PROJ, ".claude", "settings.json"))
})

test("deliverability is decided from the record, in the safe direction", async () => {
  const { path } = await inbox("matrix")
  const cases = [
    [{ mode: "default" }, true], [{ mode: "auto" }, true], [{ mode: "acceptEdits" }, true], [{ mode: "dontAsk" }, true],
    [{ mode: "bypassPermissions" }, false, "bypass-mode"], [{ mode: "plan" }, false, "mode-plan"], [{}, false, "mode-unknown"],
    [{ mode: "bypassPermissions", inbound: "accept" }, true], [{ mode: "auto", inbound: "hold" }, false, "inbound-hold"],
    [{ mode: "auto", inbound: "refuse" }, false, "inbound-refuse"],
  ]
  for (const [rec, ok, why] of cases) {
    rmSync(join(ROOT, "doorbells", `${carol}.json`), { force: true })
    store.setDoorbell(carol, { socket: path, ...rec })
    const r = store.ringable(carol)
    assert.equal(r.ok, ok, JSON.stringify(rec))
    if (why) assert.equal(r.why, why, JSON.stringify(rec))
  }
  store.setDoorbell(carol, { socket: join(SOCKS, "gone.sock"), mode: "auto" })
  assert.equal(store.ringable(carol).why, "stale", "a socket file that is not there is a closed window")
})

test("only a direct address (or a pair room) is rung — a broadcast is the letterbox's", () => {
  const direct = store.ringPlan({ entry: { from: alice, to: [bob] }, room: "team", woke: [bob, carol] })
  assert.deepEqual(direct.map(p => p.seat), [bob])
  const broadcast = store.ringPlan({ entry: { from: alice, to: [] }, room: "team", woke: [bob, carol] })
  assert.deepEqual(broadcast, [])
  const byProject = store.ringPlan({ entry: { from: alice, to: ["beta"] }, room: "team", woke: [bob] })
  assert.deepEqual(byProject, [], "a project name is several windows' business, not one doorbell")
})

test("send rings an idle default-mode seat: one line, labelled, pointing back at the bus", async () => {
  const target = await inbox("bob")
  store.setDoorbell(bob, { socket: target.path, mode: "auto" })
  const out = store.send({ room: "team", from: alice, type: "REQUEST", text: "please re-run the build\nand report", to: [bob] })
  const rung = await doorbell.ringReport({ room: "team", out, text: "please re-run the build\nand report" })
  assert.deepEqual(rung.rang, [bob])
  await new Promise(r => setTimeout(r, 50))
  assert.equal(target.lines.length, 1)
  const line = target.lines[0]
  assert.equal(line.type, "user")
  assert.equal(line.message.role, "user")
  assert.match(line.message.content, /REQUEST for you from alfa#11111111 in room "team"/)
  assert.match(line.message.content, /read it with the `inbox` tool/)
  assert.equal(line.from_name, alice)
  assert.equal(line.from, undefined, "no native reply address: the answer belongs on the bus")
  assert.equal(store.wasRung({ room: "team", seat: bob, ts: out.ts }), true)
})

test("a bypass-mode seat is NOT rung, and the sender is told why and what works instead", async () => {
  const target = await inbox("bob-bypass")
  store.setDoorbell(bob, { socket: target.path, mode: "bypassPermissions" })
  const out = store.send({ room: "team", from: alice, type: "QUESTION", text: "which branch?", to: [bob] })
  const rung = await doorbell.ringReport({ room: "team", out, text: "which branch?" })
  assert.equal(rung.rang, undefined)
  assert.equal(rung.notRung[0].why, "bypass-mode")
  assert.match(rung.notRung[0].fallback, /crossSessionInbound/)
  // …and when the SENDER runs in bypass too, the harness's own parity rule delivers SendMessage.
  store.setDoorbell(alice, { socket: join(SOCKS, "alice.sock"), mode: "bypassPermissions" })
  const out2 = store.send({ room: "team", from: alice, type: "QUESTION", text: "which branch, again?", to: [bob] })
  const rung2 = await doorbell.ringReport({ room: "team", out: out2, text: "which branch, again?" })
  assert.match(rung2.notRung[0].fallback, new RegExp(`SendMessage to "uds:${target.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(target.lines.length, 0, "nothing was posted into a socket that would hold it")
})

test("a socket nobody listens on is reported stale, and the send still succeeds", async () => {
  const dead = join(SOCKS, "dead.sock")
  const srv = net.createServer(); await new Promise(r => srv.listen(dead, r))
  // Close the listener without unlinking the file — what a crashed session leaves behind.
  srv.close()
  writeFileSync(dead, "")
  store.setDoorbell(bob, { socket: dead, mode: "auto" })
  const out = store.send({ room: "team", from: alice, type: "REQUEST", text: "ping", to: [bob] })
  const rung = await doorbell.ringReport({ room: "team", out, text: "ping" })
  assert.equal(rung.notRung[0].why, "stale")
})

test("SET_AGENT_DOORBELL=off rings nobody", async () => {
  const target = await inbox("bob-off")
  store.setDoorbell(bob, { socket: target.path, mode: "auto" })
  process.env.SET_AGENT_DOORBELL = "off"
  const out = store.send({ room: "team", from: alice, type: "REQUEST", text: "quiet please", to: [bob] })
  assert.deepEqual(await doorbell.ringReport({ room: "team", out, text: "quiet please" }), {})
  delete process.env.SET_AGENT_DOORBELL
})

// ── the hooks, run as the real processes Claude Code runs ─────────────────────

const hookEnv = (n, extra = {}) => ({ ...process.env, CLAUDE_CODE_SESSION_ID: S(n), SET_AGENT_OWNER_PID: String(7000 + n),
                                      SET_AGENT_HEADLESS: "0", ...extra })
const runHook = (script, payload, env) =>
  spawnSync(process.execPath, [join(HOOKS, script)], { input: JSON.stringify(payload), env, encoding: "utf8" })

test("the watch guard declines a watch for a ringable seat with no relay room", async () => {
  const target = await inbox("guard")
  store.setDoorbell(bob, { socket: target.path, mode: "auto" })
  const payload = { tool_name: "Monitor", cwd: "/x/beta", permission_mode: "auto",
                    tool_input: { command: `SET_AGENT_NAME=beta SET_AGENT_ROOM=team ${process.execPath} ${SAC} wait` } }
  const r = runHook("watch-guard.mjs", payload, hookEnv(2, { SET_AGENT_NAME: "beta" }))
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /No inbox watch needed/)
})

test("the guard lets the watch through for a bypass seat, and for anything that is not ours", () => {
  const cmd = `SET_AGENT_ROOM=team ${process.execPath} ${SAC} wait`
  const bypass = runHook("watch-guard.mjs", { tool_name: "Monitor", cwd: "/x/beta", permission_mode: "bypassPermissions",
                                              tool_input: { command: cmd } }, hookEnv(2, { SET_AGENT_NAME: "beta" }))
  assert.equal(bypass.stdout, "", "a bypass seat cannot be rung, so it keeps its watch")
  const other = runHook("watch-guard.mjs", { tool_name: "Monitor", cwd: "/x/beta", permission_mode: "auto",
                                             tool_input: { command: "tail -f build.log" } }, hookEnv(2, { SET_AGENT_NAME: "beta" }))
  assert.equal(other.stdout, "")
  const garbage = spawnSync(process.execPath, [join(HOOKS, "watch-guard.mjs")], { input: "not json", encoding: "utf8" })
  assert.equal(garbage.status, 0)
  assert.equal(garbage.stdout, "")
})

test("the Stop hook records the live mode — before its headless exit", () => {
  rmSync(join(ROOT, "doorbells", `${bob}.json`), { force: true })
  const r = runHook("stop.mjs", { cwd: "/x/beta", permission_mode: "acceptEdits" },
                    hookEnv(2, { SET_AGENT_NAME: "beta", SET_AGENT_HEADLESS: "1", CLAUDE_CODE_MESSAGING_SOCKET: join(SOCKS, "guard.sock") }))
  assert.equal(r.status, 0)
  const d = store.doorbellOf(bob)
  assert.equal(d.mode, "acceptEdits")
  assert.equal(d.socket, join(SOCKS, "guard.sock"))
})

test("SessionStart: a ringable seat is NOT asked to arm a watch; a bypass one still is", async () => {
  const target = await inbox("start")
  const env = mode => hookEnv(4, { SET_AGENT_NAME: "delta", SET_AGENT_ROOM: "team", CLAUDE_CODE_MESSAGING_SOCKET: target.path,
                                   SET_AGENT_DEVICE: "test" })
  writeFileSync(join(HOME, "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto" } }))
  const ok = JSON.parse(runHook("session-start.mjs", { cwd: "/x/delta" }, env()).stdout)
  const note = ok.hookSpecificOutput.additionalContext
  assert.match(note, /do NOT need an inbox watch/)
  assert.doesNotMatch(note, /ARM YOUR INBOX WATCH ONCE/)
  writeFileSync(join(HOME, "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }))
  const bp = JSON.parse(runHook("session-start.mjs", { cwd: "/x/delta" }, env()).stdout)
  assert.match(bp.hookSpecificOutput.additionalContext, /ARM YOUR INBOX WATCH ONCE/)
  rmSync(join(HOME, "settings.json"))
})

test("REGRESSION: `sac wait` does not announce an entry the sender already rang", async () => {
  // Two entries for bob: the first was rung, the second was not. The watch must speak about the
  // second one only — announcing the first would be a second turn for one message.
  const target = await inbox("wait")
  store.setDoorbell(bob, { socket: target.path, mode: "auto" })
  // Everything older is read first, so only the two entries below are candidates.
  store.inbox({ room: "team", agent: bob, advance: true, limit: 1000 })
  const rungOne = store.send({ room: "team", from: alice, type: "REQUEST", text: "the rung one", to: [bob] })
  const rung = await doorbell.ringReport({ room: "team", out: rungOne, text: "the rung one" })
  assert.deepEqual(rung.rang, [bob])
  const env = hookEnv(2, { SET_AGENT_NAME: "beta", SET_AGENT_ROOM: "team", SET_AGENT_SAFETY_NET: "off", SET_AGENT_QUIET_MS: "200" })
  const p = spawn(process.execPath, [SAC, "wait", "--once"], { env })
  let said = ""
  p.stdout.on("data", d => { said += d })
  await new Promise(r => setTimeout(r, 1500))
  assert.equal(said, "", "the rung entry was announced again")
  store.send({ room: "team", from: alice, type: "REQUEST", text: "the unrung one", to: [bob] })
  const code = await new Promise(r => { p.on("exit", r); setTimeout(() => { p.kill(); r("timeout") }, 15000) })
  assert.notEqual(code, "timeout", "the watch never spoke about the entry nobody rang")
  assert.match(said, /the unrung one/)
  assert.doesNotMatch(said, /the rung one/)
})
