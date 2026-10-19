// THE OWNER — the human of this machine as an addressee, and the view of what waits on them.
//
// Asked for by set-core 2026-10-19 (change fleet-waiting-on-you): a consumer's operations watch wrote
// `→ <owner>` inside the TEXT of broadcast REQUESTs — dozens of open items nothing could count —
// and those broadcasts woke every live seat for questions only the person could answer (one bot
// seat caused 66% of all wake decisions in 21 days, docs/native-messaging.md).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-owner-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"
process.env.SET_AGENT_FLEET_ROSTER = join(ROOT, "none.json")

const store = await import("../src/store.mjs")
const S = n => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`
const seat = (agent, n, room = "ops") => {
  const w = store.claimSeat({ agent, session: S(n), owner: 8000 + n })
  store.register({ agent, session: S(n), room, owner: 8000 + n })
  return w
}
store.createRoom("ops", "x#00000000")
const bot = seat("watch", 1), a = seat("alfa", 2), b = seat("beta", 3)

test("a question to the owner wakes no session, and says where it went", () => {
  const out = store.send({ room: "ops", from: bot, type: "QUESTION", text: "Approve the v1.29 release?", to: ["owner"] })
  assert.deepEqual(out.to, ["owner"])
  assert.deepEqual(out.wakes, [], "a session was woken for a question only the person can answer")
  assert.match(out.notice.join(" "), /Addressed to the owner/)
  for (const s of [a, b]) {
    const m = store.inbox({ room: "ops", agent: s, advance: false }).messages.at(-1)
    assert.equal(m.forMe, false)
    assert.equal(m.wakes, false)
  }
})

test("owner and a seat together: the seat is woken as for any direct address", () => {
  const out = store.send({ room: "ops", from: bot, type: "REQUEST", text: "prepare the notes", to: ["owner", a] })
  assert.deepEqual(out.wakes, [a])
})

test("`owner` is never a seat — not even a project of that name", () => {
  assert.equal(store.isForMe({ to: ["owner"] }, "owner#12345678"), false)
})

test("the open list: unanswered owner entries, oldest first, in the named shape", () => {
  const v = store.ownerOpen()
  assert.equal(v.schema, "sac.owner/1")
  assert.deepEqual(Object.keys(v).sort(), ["generatedAt", "open", "schema"])
  assert.equal(v.open.length, 2)
  assert.deepEqual(Object.keys(v.open[0]).sort(), ["ageMinutes", "from", "id", "room", "text", "to", "ts", "type"])
  assert.match(v.open[0].text, /Approve the v1.29/)
  assert.equal(v.open[0].id, `${v.open[0].ts}|${bot}`)
})

test("an agent answering with re: takes it off the list", () => {
  const q = store.ownerOpen().open[1]
  store.send({ room: "ops", from: a, type: "ANSWER", text: "the person said: notes are fine", re: q.ts })
  assert.ok(!store.ownerOpen().open.some(o => o.ts === q.ts))
})

test("the owner's own close is the same rule, written as `owner` — and the owner is not a seat", () => {
  const q = store.ownerOpen().open[0]
  const out = store.ownerClose({ room: "ops", ts: q.ts, note: "approved" })
  assert.equal(out.from, "owner")
  assert.equal(out.re, q.ts)
  assert.equal(store.ownerOpen().open.length, 0)
  const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  assert.ok(!reg.agents.owner, "closing put the person on the roster as a session")
  assert.throws(() => store.ownerClose({ room: "ops", ts: "1999-01-01T00:00:00.000+00:00" }), /no entry/)
})

test("an archived room's open items are not listed", () => {
  store.createRoom("old", bot)
  store.send({ room: "old", from: bot, type: "QUESTION", text: "stale question", to: ["owner"] })
  assert.equal(store.ownerOpen().open.length, 1)
  store.archiveRoom("old", { force: true })
  assert.equal(store.ownerOpen().open.length, 0)
})

test("naming only the owner does not pick a room for you", () => {
  assert.throws(() => store.resolveRoom({ to: ["owner"], configured: ["ops", "other"] }), /room` is required/)
  // With one room the caller's default room applies before this rule is asked; with a room given,
  // the owner goes there like any addressee.
  assert.equal(store.resolveRoom({ room: "ops", to: ["owner"], configured: ["ops", "other"] }).room, "ops")
  assert.deepEqual(store.resolveAddressees(["owner"]).to, ["owner"])
})
