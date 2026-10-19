// NAMES — an alias or a Fleet label resolves to ONE seat before anything is written.
//
// Measured 2026-10-09 → 10-19 (docs/native-messaging.md): addresses died with their windows (5
// "No agent named …" failures on the built-in tool), a 2-hex name collided, and one umbrella
// project's products answered whichever of its four to five windows they had last heard from.
// The person running them wants to say "tell the Studio", in plain words.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-aliases-"))
const ROSTER = join(ROOT, "fleet-roster.json")
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"
process.env.SET_AGENT_FLEET_ROSTER = ROSTER

const store = await import("../src/store.mjs")

const S1 = "11111111-aaaa-4000-8000-000000000001"
const S2 = "22222222-bbbb-4000-8000-000000000002"
const S3 = "33333333-cccc-4000-8000-000000000003"
const roster = sessions => writeFileSync(ROSTER, JSON.stringify({ version: 1, projects: { web: Object.fromEntries(
  sessions.map(([sid, label, seen]) => [sid, { session_id: sid, label, project: "web", cwd: "/x/web", kind: "interactive",
                                              first_seen: 1, last_seen: seen }])) } }))
// Distinct owners so the in-process sessions do not collapse onto one window (CLAUDE.md, tests).
const seatFor = (session, owner) => store.claimSeat({ agent: "web", session, owner })
const kill = seat => {
  // A closed window: no live writer, no live owner, last seen long ago.
  const p = join(ROOT, "registry.json")
  const reg = JSON.parse(readFileSync(p, "utf8"))
  Object.assign(reg.agents.web.seats[seat], { writers: {}, owner: 2 ** 22 + 7, lastSeen: "2000-01-01T00:00:00.000+00:00" })
  writeFileSync(p, JSON.stringify(reg))
}

test("names compare loosely: case, accents, spaces and punctuation are ignored", () => {
  assert.equal(store.aliasKey("ÁTJÁRÓ!"), store.aliasKey("atjaro"))
  assert.equal(store.aliasKey("Studio Lead"), store.aliasKey("studio-lead"))
  assert.equal(store.aliasKey("  "), "")
})

test("no roster on the machine: no labels, no error, seats still resolve to themselves", () => {
  rmSync(ROSTER, { force: true })
  assert.deepEqual(store.fleetLabels(), {})
  assert.deepEqual(store.resolveAddressees(["somebody#12345678"]).to, ["somebody#12345678"])
})

test("a Fleet label is an address on its own, and the result says what it became", () => {
  roster([[S1, "web-studio", 100]])
  const seat = seatFor(S1, 9001)
  store.register({ agent: "web", session: S1, room: "team", owner: 9001 })
  const r = store.resolveAddressees(["web-studio"])
  assert.deepEqual(r.to, [seat])
  assert.equal(r.resolved[0].via, "label")
  assert.equal(r.resolved[0].asked, "web-studio")
})

test("THIS window, named in plain words, is bound to its Fleet label", () => {
  const seat = seatFor(S1, 9001)
  const label = store.labelOf(seat)
  assert.equal(label, "web-studio")
  const out = store.setAlias({ name: "Studio Lead", kind: "label", target: label, by: seat })
  assert.equal(out.seat, seat)
  const r = store.resolveAddressees(["studio lead"])
  assert.deepEqual(r.to, [seat])
  assert.equal(r.resolved[0].via, "alias→label")
})

test("REGRESSION: a replacement window inherits the alias through its label — no re-binding", () => {
  // Measured: `…-studio` held by one session, then by its replacement. A seat-bound name would
  // have died with the first window; that is the 5 × "No agent named …" from the built-in tool.
  const old = seatFor(S1, 9001)
  kill(old)
  roster([[S1, "web-old", 100], [S2, "web-studio", 200]])
  const fresh = seatFor(S2, 9002)
  store.register({ agent: "web", session: S2, room: "team", owner: 9002 })
  assert.notEqual(fresh, old)
  assert.deepEqual(store.resolveAddressees(["Studio Lead"]).to, [fresh])
})

test("an alias may not shadow a real address", () => {
  assert.throws(() => store.setAlias({ name: "WEB", kind: "label", target: "web-studio" }), /shadow the existing address 'web'/)
})

test("an alias to a target nothing holds is refused at binding, not at sending", () => {
  assert.throws(() => store.setAlias({ name: "Ghost", kind: "label", target: "no-such-label" }), /no window holds/)
})

test("several live windows behind one alias are refused, never fanned out", () => {
  // Two live windows of the same project, alias bound to the PROJECT.
  seatFor(S3, 9003)
  store.register({ agent: "web", session: S3, room: "team", owner: 9003 })
  store.setAlias({ name: "Web Team", kind: "project", target: "web" })
  assert.throws(() => store.resolveAddressees(["web team"]), err => {
    assert.match(err.message, /matches 2 live windows/)
    assert.match(err.message, /web-studio/, "the candidates are named with their labels")
    return true
  })
})

test("the book lists each name with what it reaches now, and `agents` carries labels and names", () => {
  const book = store.aliases()
  const lead = book.find(a => a.name === "Studio Lead")
  assert.equal(lead.state === "live" || lead.state === "unknown", true)
  const team = book.find(a => a.name === "Web Team")
  assert.equal(team.state, "ambiguous")
  const seats = store.agents().find(a => a.agent === "web").seats
  const holder = seats.find(s => s.writer === lead.seat)
  assert.equal(holder.label, "web-studio")
  assert.deepEqual(holder.aliases, ["Studio Lead"])
  const report = store.agentsReport().agents.find(a => a.agent === "web").seats.find(s => s.seat === lead.seat)
  assert.equal(report.label, "web-studio")
  assert.deepEqual(report.aliases, ["Studio Lead"])
})

test("an entry addressed by alias is written to the resolved seat, and reaches it", () => {
  store.createRoom("team", "web#x")
  const { to } = store.resolveAddressees(["Studio Lead"])
  const out = store.send({ room: "team", from: store.seatOf({ agent: "web", session: S3, owner: 9003 }), type: "REQUEST", text: "check the build", to })
  assert.deepEqual(out.to, to)
  const target = to[0]
  const inbox = store.inbox({ room: "team", agent: target, advance: false })
  assert.equal(inbox.messages.at(-1).wakes, true)
})

test("removing a name says what it was; removing an unknown one lists the book", () => {
  assert.equal(store.removeAlias("web team").removed, "Web Team")
  assert.throws(() => store.removeAlias("nobody"), /the book has: Studio Lead/)
})
