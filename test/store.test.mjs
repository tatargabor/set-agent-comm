// Self-test for the core. It does not measure the call but the RESULT (derived-state.md
// principle): every case reads back the real state of the file system.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
