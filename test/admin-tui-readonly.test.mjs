// THE ONE PROPERTY THAT MAKES `sac admin` SAFE TO LEAVE RUNNING: it writes nothing.
//
// The view is what an operator opens *while* the bus is being used. If watching a room could
// move a cursor, the act of looking would decide what a seat sees next — and the operator would
// have caused the failure they opened the tool to diagnose. Before navigation existed there were
// three keys and this was easy to believe. There are now sixteen, an overlay, and a search box,
// so it is asserted instead: every binding is exercised against a real store on disk, and the
// store is compared byte for byte afterwards.
//
// This file spawns nothing and stubs nothing. It builds a store, reads it the way the TUI does,
// and hashes it. A property that only holds for a mocked filesystem is not the property.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

// ⚠ The store root and the TUI's own HOME are both read at MODULE LOAD, so the environment has
// to be set before either import — which means the imports must be dynamic.
const ROOT = mkdtempSync(join(tmpdir(), "sac-tui-ro-"))
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = String(process.pid)
process.env.SET_AGENT_TRIAGE = "off"

const store = await import("../src/store.mjs")
const tui = await import("../src/admin-tui.mjs")

/** Every file under the store, with its content hash, size and mtime. */
function fingerprint(dir) {
  const out = {}
  const walk = (d, prefix = "") => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), rel = prefix + name
      const st = statSync(p)
      if (st.isDirectory()) walk(p, rel + "/")
      else out[rel] = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`
    }
  }
  walk(dir)
  return out
}

// A room with two writers and enough entries that every pane has something to scroll.
store.register({ agent: "web-app", project: "web-app", session: "1111", room: "team", writer: "web-app#1111" })
store.register({ agent: "api", project: "api", session: "2222", room: "team", writer: "api#2222" })
for (let i = 0; i < 12; i++) {
  store.send({
    room: "team",
    from: i % 2 ? "web-app#1111" : "api#2222",
    type: i % 3 === 0 ? "QUESTION" : "FACT",
    text: `bejegyzés ${i} — ${"x".repeat(200 + i)}`,
    ...(i % 4 === 0 ? { to: ["web-app#1111"] } : {}),
  })
}

const KEYS_TO_TRY = [
  "\t", "\x1b[Z",                                  // pane focus, both directions
  "\x1b[A", "\x1b[B", "k", "j",                    // movement
  "\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F",        // paging and ends
  "\x1b[1~", "\x1b[4~",
  "\r", "\n", "\x1b",                              // open and close
  "/", "a", "t", "\x7f", "\b",                     // search: type and delete
  "f", "?", "r", "x", "1", " ",                    // filter, help, unknown keys
]

test("REGRESSION: no navigation key can write to the store — the view is read-only under all of them", () => {
  process.stdout.columns = 100
  process.stdout.rows = 30

  const before = fingerprint(ROOT)
  assert.ok(Object.keys(before).length > 0, "the fixture store must not be empty")

  // Walk every key from every pane, and from inside an overlay and a search box, rendering
  // after each one — rendering is where a lazy read could turn into a write.
  for (const startPane of ["channels", "subs", "flow"]) {
    let ui = tui.normalizeUi({ pane: startPane })
    for (const key of KEYS_TO_TRY) {
      const snap = tui.snapshot()
      ui = tui.handleKey(snap, ui, key)
      tui.render(snap, ui)
    }
    // …and once more with an overlay open, since its keys take a different path entirely.
    let deep = tui.handleKey(tui.snapshot(), tui.normalizeUi({ pane: "flow" }), "\r")
    for (const key of KEYS_TO_TRY) {
      const snap = tui.snapshot()
      deep = tui.handleKey(snap, deep, key)
      tui.render(snap, deep)
    }
  }

  const after = fingerprint(ROOT)
  assert.deepEqual(after, before, "the store changed while the admin view was being navigated")
})

test("no navigation key creates a file either — not even an empty one", () => {
  const names = Object.keys(fingerprint(ROOT))
  const snap = tui.snapshot()
  let ui = tui.normalizeUi({})
  for (const key of KEYS_TO_TRY) { ui = tui.handleKey(snap, ui, key); tui.render(snap, ui) }
  assert.deepEqual(Object.keys(fingerprint(ROOT)), names)
})

test("the snapshot the TUI reads is the same bus the store reports", () => {
  const snap = tui.snapshot()
  const team = snap.rooms.find(r => r.room === "team")
  assert.ok(team, "the room the fixture wrote must be visible")
  assert.equal(team.total, 12)
  // The pane can only show what the window loaded; the room's own total is what it reports.
  assert.ok(team.messages.length <= team.total)
})

test("a smaller window loads fewer entries, and the room's total is unchanged", () => {
  const small = tui.snapshot({ window: 5 })
  const team = small.rooms.find(r => r.room === "team")
  assert.equal(team.messages.length, 5, "the window bounds what is loaded")
  assert.equal(team.total, 12, "…and never what is reported as the room's size")
})
