// Önteszt a magra. Nem a hívást méri, hanem az EREDMÉNYT (derived-state.md elve):
// minden eset a fájlrendszer valódi állapotát olvassa vissza.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-test-"))
process.env.SET_AGENT_COMM_DIR = ROOT
const store = await import("../src/store.mjs")
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

test("az időbélyeg a RENDSZERÓRÁBÓL jön, helyi eltolással, EZREDMÁSODPERCCEL", () => {
  const ts = store.now(new Date("2026-08-03T12:34:56.078"))
  assert.match(ts, /^2026-08-03T12:34:56\.078[+-]\d{2}:\d{2}$/)
})

test("REGRESSZIÓ: azonos másodpercben küldött üzenetek sorrendje NEM fordul meg", () => {
  // A füst-teszt mért esete: a `zzz` küld előbb, az `aaa` válaszol — ábécében fordítva.
  // Másodperc-felbontásnál a history a VÁLASZT adta vissza elsőnek.
  store.send({ room: "sorrend", from: "zzz", type: "KÉRDÉS", text: "én voltam előbb" })
  store.send({ room: "sorrend", from: "aaa", type: "VÁLASZ", text: "én utána" })
  const h = store.history({ room: "sorrend" })
  assert.deepEqual(h.messages.map(m => m.from), ["zzz", "aaa"],
    "a válasz megelőzte a kérdést — a szál némán megfordult")
})

test("send APPENDEL, nem ír újra — a régi bejegyzés megmarad", () => {
  store.send({ room: "r", from: "a", type: "TÉNY", text: "első" })
  store.send({ room: "r", from: "a", type: "KÉRDÉS", text: "második" })
  const raw = readFileSync(store.busFile("r", "a"), "utf8")
  assert.ok(raw.includes("első"), "az első bejegyzés eltűnt — ez lost update")
  assert.ok(raw.includes("második"))
  assert.equal((raw.match(/^## /gm) || []).length, 2)
})

test("ismeretlen típus elhasal — a rossz típus némán elrontaná a parse-t", () => {
  assert.throws(() => store.send({ room: "r", from: "a", type: "PLETYKA", text: "x" }), /ismeretlen típus/)
})

test("üres üzenet elhasal", () => {
  assert.throws(() => store.send({ room: "r", from: "a", text: "   " }), /üres üzenet/)
})

test("inbox a MÁSOKÉT adja, a sajátot soha", () => {
  store.send({ room: "r", from: "b", type: "TÉNY", text: "b üzenete" })
  const r = store.inbox({ room: "r", agent: "a", advance: false })
  assert.equal(r.unread, 1)
  assert.equal(r.messages[0].from, "b")
  assert.equal(r.messages[0].text, "b üzenete")
})

test("a kurzor csak advance:true esetén lép — a peek nem nyeli el az üzenetet", () => {
  assert.equal(store.inbox({ room: "r", agent: "a", advance: false }).unread, 1)
  assert.equal(store.inbox({ room: "r", agent: "a", advance: true }).unread, 1)
  assert.equal(store.inbox({ room: "r", agent: "a", advance: false }).unread, 0, "a kurzor nem lépett előre")
})

test("többsoros szöveg és `re:` hivatkozás túléli a parse-t", () => {
  const { ts } = store.send({ room: "r", from: "b", type: "VÁLASZ", text: "egy\nkettő\n\nnégy", re: "2026-01-01T00:00:00+01:00" })
  const m = store.history({ room: "r", from: "b" }).messages.at(-1)
  assert.equal(m.ts, ts)
  assert.equal(m.re, "2026-01-01T00:00:00+01:00")
  assert.equal(m.text, "egy\nkettő\n\nnégy")
})

test("a history NEM mozgatja a kurzort", () => {
  const before = store.inbox({ room: "r", agent: "a", advance: false }).unread
  store.history({ room: "r" })
  assert.equal(store.inbox({ room: "r", agent: "a", advance: false }).unread, before)
})

test("a nyilvántartás idempotens: ugyanaz a név frissül, nem duplázódik", () => {
  store.register({ agent: "a", project: "/x", room: "r" })
  store.register({ agent: "a", project: "/x", room: "r2" })
  const list = store.agents().filter(x => x.agent === "a")
  assert.equal(list.length, 1)
  assert.deepEqual([...list[0].rooms].sort(), ["r", "r2"])
})

test("silentMinutes null, ha nincs életjel — a 'nem tudjuk' nem 'halott'", () => {
  const a = store.agents().find(x => x.agent === "a")
  assert.equal(typeof a.silentMinutes, "number")
  assert.ok(a.silentMinutes >= 0)
})

test("watch-lista: a szoba írófájljai, a sajátunk kiszűrhető", () => {
  const files = store.busFiles("r").map(p => p.split("/").pop())
  assert.deepEqual(files, ["a.md", "b.md"])
})
