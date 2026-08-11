// THE ADMIN VIEW's judgement, measured on a rendered screen rather than on its internals.
//
// Only two things in `sac admin` are judgement rather than drawing, and both are the kind that
// makes an operator act on the wrong seat if they are wrong:
//
//   1. WHO IS INTERRUPTED by an entry (`wakesSeat`) — the bus's entire cost model.
//   2. WHAT COUNTS AS BEHIND. A closed session is not "behind", it is gone; counting its
//      backlog put 5959 unread on a room where nobody live was behind at all, and a number
//      like that is one an operator learns to ignore — which costs them the real ones too.
//
// The assertions read the rendered text, because that is what a human acts on. A count that is
// right in a variable and absent from the screen is not right.
import { test } from "node:test"
import assert from "node:assert/strict"

import { render, wakesSeat, width, handleKey, normalizeUi, wrap, KEYS } from "../src/admin-tui.mjs"

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, "")

/** A room as `snapshot()` hands it to `render` — written out so no store or disk is needed. */
function room(overrides = {}) {
  const subs = overrides.subs || []
  const reach = subs.filter(s => s.live !== false)
  return {
    room: "team",
    total: 3,
    messages: [],
    subs,
    seats: subs.length,
    reachable: reach.length,
    last: new Date().toISOString(),
    behind: reach.reduce((n, s) => n + s.behind, 0),
    waking: reach.reduce((n, s) => n + s.waking, 0),
    ...overrides,
  }
}

const seat = (o = {}) => ({
  seat: "web-app#1111", behind: 0, waking: 0, live: true,
  lastSeen: new Date().toISOString(), lastWrote: null, remote: false, focus: null, ...o,
})

const draw = rooms => {
  process.stdout.columns = 200
  process.stdout.rows = 40
  return plain(render({ rooms, at: new Date() }, { selected: 0 }))
}

test("an addressed entry wakes exactly its addressee — by seat, by project, and nobody else", () => {
  const m = { type: "FACT", from: "api#9", to: ["web-app#1111"] }
  assert.equal(wakesSeat(m, "web-app#1111"), true)
  assert.equal(wakesSeat(m, "web-app#2222"), false)

  // Addressing the PROJECT reaches every session of it — the documented cost of not naming one.
  const toProject = { type: "FACT", from: "api#9", to: ["web-app"] }
  assert.equal(wakesSeat(toProject, "web-app#1111"), true)
  assert.equal(wakesSeat(toProject, "web-app#2222"), true)
})

test("a broadcast wakes the room only when it asks for something", () => {
  for (const type of ["QUESTION", "REQUEST"]) {
    assert.equal(wakesSeat({ type, from: "api#9", to: [] }, "web-app#1111"), true, type)
  }
  // The generous move: delivered to everyone, costing nobody a turn.
  for (const type of ["FACT", "ANSWER"]) {
    assert.equal(wakesSeat({ type, from: "api#9", to: [] }, "web-app#1111"), false, type)
  }
})

test("a closed session's backlog is NOT counted as the room being behind", () => {
  const r = room({ subs: [seat({ live: false, behind: 5000 }), seat({ seat: "api#2", live: true, behind: 2 })] })
  const screen = draw([r])
  assert.match(screen, /1\/2/)                    // one of two seats can still read
  assert.ok(!screen.includes("5000 behind"), "a closed seat must not read as 'behind'")
  assert.match(screen, /5000 unread \(closed session\)/)
  assert.match(screen, /2 behind/)
})

test("an UNKNOWN liveness counts as reachable and is drawn as unknown, never as dead", () => {
  // Measured 2026-08-09: a seat looked silent for 86 minutes while working the whole time.
  // Rendering "we do not know" as "dead" is how work gets routed away from a live session.
  const screen = draw([room({ subs: [seat({ live: null, behind: 4, waking: 1 })] })])
  assert.match(screen, /1\/1/)
  assert.match(screen, /\?\s+web-app#1111/)
  assert.match(screen, /4 behind \(1 waking\)/)
})

test("the seats that can still act are drawn first", () => {
  const screen = draw([room({
    subs: [
      seat({ seat: "dead#1", live: false, behind: 9 }),
      seat({ seat: "live#2", live: true, behind: 1, waking: 1 }),
    ],
  })])
  assert.ok(screen.indexOf("live#2") < screen.indexOf("dead#1"), "a reachable seat sorts above a closed one")
})

test("every line fits the terminal — a wrapped line breaks the whole layout", () => {
  process.stdout.columns = 60
  process.stdout.rows = 24
  const long = seat({
    seat: "some-very-long-project-name#deadbeefcafe",
    behind: 12,
    focus: "x".repeat(400),
  })
  const screen = render({ rooms: [room({ subs: [long] })], at: new Date() }, { selected: 0 })
  for (const line of screen.split("\n")) {
    assert.ok(width(line) <= 60, `line too wide (${width(line)}): ${plain(line).slice(0, 40)}`)
  }
})

test("a room with no channels renders rather than throwing", () => {
  assert.match(draw([]), /no rooms yet/)
})

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION, added 2026-08-11. What is asserted here is that everything on the
// screen can be REACHED — before this, three things could not be, by any key:
// an entry's text, the seats past `(rows-14)/2`, and anything older than one
// screenful of flow. Plus the two properties that make the tool safe to leave
// running: it writes nothing, and no line ever wraps.

const UP = "\x1b[A", DOWN = "\x1b[B", PGUP = "\x1b[5~", PGDN = "\x1b[6~"
const HOME_K = "\x1b[H", END_K = "\x1b[F", TAB = "\t", STAB = "\x1b[Z", ESC_K = "\x1b", ENTER = "\r"

const msg = (o = {}) => ({
  ts: o.ts || "2026-08-11T10:00:00.000+02:00",
  type: "FACT", from: "api#9", to: [], text: "szöveg", ...o,
})

/** A snapshot as `snapshot()` builds it, with one room. */
const snapOf = (r) => ({ rooms: [r], at: new Date(), window: 400 })

const drawUi = (rooms, ui, cols = 200, rows = 40) => {
  process.stdout.columns = cols
  process.stdout.rows = rows
  return plain(render({ rooms, at: new Date(), window: 400 }, ui))
}

test("the pre-navigation ui shape still works — `{ selected: n }` picks the room", () => {
  const a = room({ room: "alpha" }), b = room({ room: "beta" })
  assert.match(drawUi([a, b], { selected: 1 }), /SUBSCRIBERS.*beta/s)
  // …and a completely empty ui is valid too.
  assert.match(drawUi([a, b], {}), /SUBSCRIBERS.*alpha/s)
  assert.equal(normalizeUi({}).pane, "channels")
})

test("exactly one pane is active, and Tab cycles through all three", () => {
  const r = room({ subs: [seat()], messages: [msg()] })
  let ui = normalizeUi({})
  const seen = []
  for (let i = 0; i < 4; i++) { seen.push(ui.pane); ui = handleKey(snapOf(r), ui, TAB) }
  assert.deepEqual(seen, ["channels", "subs", "flow", "channels"], "Tab cycles and wraps")
  assert.equal(handleKey(snapOf(r), normalizeUi({}), STAB).pane, "flow", "Shift-Tab goes back")
})

test("the active pane is marked on screen, and only that one", () => {
  const r = room({ subs: [seat()], messages: [msg()] })
  // The marker is the reverse-video block, which survives into the raw (uncleaned) render.
  const raw = p => {
    process.stdout.columns = 200; process.stdout.rows = 40
    return render({ rooms: [r], at: new Date() }, { pane: p })
  }
  assert.ok(raw("subs").includes("\x1b[7m\x1b[1m SUBSCRIBERS "), "the active pane is highlighted")
  assert.ok(!raw("subs").includes("\x1b[7m\x1b[1m FLOW "), "…and the others are not")
  assert.ok(raw("flow").includes("\x1b[7m\x1b[1m FLOW "))
})

test("↑/↓ on the channels pane still changes room — no existing key regressed", () => {
  const a = room({ room: "alpha" }), b = room({ room: "beta" })
  const snap = { rooms: [a, b], at: new Date() }
  const ui = handleKey(snap, normalizeUi({}), DOWN)
  assert.match(drawUi([a, b], ui), /SUBSCRIBERS.*beta/s)
  assert.match(drawUi([a, b], handleKey(snap, ui, UP)), /SUBSCRIBERS.*alpha/s)
})

test("EVERY seat is reachable — the `… és még N` truncation is gone", () => {
  // Measured: the live `consumer-a-atlas` has 18 seats and the pane kept about four of them.
  const subs = Array.from({ length: 18 }, (_, i) =>
    seat({ seat: `p${String(i).padStart(2, "0")}#x`, behind: i, live: true }))
  const r = room({ subs })
  const snap = snapOf(r)
  let ui = normalizeUi({ pane: "subs" })
  const shown = new Set()
  for (let i = 0; i < 40; i++) {
    const screen = drawUi([r], ui, 200, 24)
    for (const s of subs) if (screen.includes(s.seat)) shown.add(s.seat)
    ui = handleKey(snap, ui, DOWN)
  }
  assert.equal(shown.size, 18, `every seat must be reachable, saw ${shown.size}`)
  assert.ok(!drawUi([r], normalizeUi({ pane: "subs" }), 200, 24).includes("és még"),
    "no silent truncation may remain")
})

test("a scrolled pane says where you are in it", () => {
  const subs = Array.from({ length: 18 }, (_, i) => seat({ seat: `p${i}#x` }))
  const screen = drawUi([room({ subs })], { pane: "subs" }, 200, 24)
  assert.match(screen, /SUBSCRIBERS.*1\/18/, "position within the pane is stated")
})

test("the cursor stops at the ends rather than running off", () => {
  const subs = [seat({ seat: "a#1" }), seat({ seat: "b#2" })]
  const snap = snapOf(room({ subs }))
  let ui = normalizeUi({ pane: "subs" })
  for (let i = 0; i < 5; i++) ui = handleKey(snap, ui, UP)
  assert.equal(ui.sel.subs, "a#1", "↑ on the first row stays on the first row")
  for (let i = 0; i < 9; i++) ui = handleKey(snap, ui, DOWN)
  assert.equal(ui.sel.subs, "b#2", "↓ past the end stays on the last row")
})

test("REGRESSION: an entry arriving above the cursor does not slide the selection", () => {
  // The view redraws every second and the list grows underneath it. With an index-based
  // cursor, a new entry would move the selection onto a different message — and the operator
  // would open the wrong one. Asserted on the RENDERED marker, which is what they act on.
  const marked = screen => screen.split("\n").find(l => l.includes("▸") && l.includes(":"))
  const a = msg({ ts: "2026-08-11T09:00:00.000+02:00", text: "legrégebbi" })
  const target = msg({ ts: "2026-08-11T10:00:00.000+02:00", text: "ezt-neztem" })
  const c = msg({ ts: "2026-08-11T11:00:00.000+02:00", text: "legujabb" })

  let ui = handleKey(snapOf(room({ messages: [a, target, c] })), normalizeUi({ pane: "flow" }), UP)
  assert.equal(ui.sel.flow, `${target.ts}|${target.from}`, "the cursor moved off the newest")
  assert.match(marked(drawUi([room({ messages: [a, target, c] })], ui)), /ezt-neztem/)

  // Now one arrives BETWEEN the two older entries: target's index shifts from 1 to 2.
  const inserted = msg({ ts: "2026-08-11T09:30:00.000+02:00", from: "other#1", text: "kozbeszurt" })
  const grown = room({ messages: [a, inserted, target, c] })
  assert.match(marked(drawUi([grown], ui)), /ezt-neztem/, "still the same entry, one row lower")
})

test("Enter opens an entry, and the WHOLE text is rendered — never clipped", () => {
  const long = "A".repeat(3000)
  const r = room({ messages: [msg({ text: long, to: ["web-app"], type: "QUESTION" })] })
  const ui = handleKey(snapOf(r), normalizeUi({ pane: "flow" }), ENTER)
  assert.equal(ui.overlay.kind, "entry")
  let seen = ""
  let u = ui
  for (let i = 0; i < 60; i++) {                    // scroll the overlay to the bottom
    seen += drawUi([r], u, 100, 30)
    u = handleKey(snapOf(r), u, PGDN)
  }
  const chars = (seen.match(/A/g) || []).length
  assert.ok(chars >= 3000, `the whole 3000-character entry must be readable, saw ${chars}`)
  assert.match(seen, /3000 characters/)
  assert.match(seen, /QUESTION/)
})

test("closing an overlay puts you back exactly where you were", () => {
  const subs = [seat({ seat: "a#1" }), seat({ seat: "b#2", behind: 3 })]
  const snap = snapOf(room({ subs }))
  let ui = handleKey(snap, normalizeUi({ pane: "subs" }), DOWN)
  const before = ui.sel.subs
  ui = handleKey(snap, ui, ENTER)
  assert.equal(ui.overlay.kind, "seat")
  ui = handleKey(snap, ui, ESC_K)
  assert.equal(ui.overlay, null)
  assert.equal(ui.sel.subs, before, "the same seat is still selected")
  assert.equal(ui.pane, "subs", "and the same pane is still active")
})

test("the seat overlay keeps liveness three-state — unknown is never drawn as dead", () => {
  const r = room({ subs: [seat({ live: null, behind: 4, waking: 1, focus: "a kosárral" })] })
  const ui = handleKey(snapOf(r), normalizeUi({ pane: "subs" }), ENTER)
  const screen = drawUi([r], ui, 120, 30)
  assert.match(screen, /unknown \(NOT "dead"\)/)
  assert.ok(!/closed session/.test(screen), "unknown must not read as closed")
  assert.match(screen, /a kosárral/)
})

test("a closed seat's backlog is explained rather than counted as lateness", () => {
  const r = room({ subs: [seat({ live: false, behind: 5000 })] })
  const ui = handleKey(snapOf(r), normalizeUi({ pane: "subs" }), ENTER)
  assert.match(drawUi([r], ui, 120, 30), /closed: not behind, gone/)
})

test("a search narrows, says so, and Esc restores", () => {
  const rooms = [room({ room: "consumer-a-atlas" }), room({ room: "consumer-a-promo" }), room({ room: "pair-room" })]
  const snap = { rooms, at: new Date() }
  let ui = handleKey(snap, normalizeUi({}), "/")
  assert.equal(ui.typing, true)
  for (const ch of "atlas") ui = handleKey(snap, ui, ch)
  ui = handleKey(snap, ui, ENTER)                  // finish typing, keep the query
  const screen = drawUi(rooms, ui)
  assert.match(screen, /consumer-a-atlas/)
  assert.ok(!screen.includes("pair-room"), "non-matching rooms are hidden")
  assert.match(screen, /\/atlas/, "the query is stated in the header")
  assert.match(screen, /1\/3 shown/, "…with how much is being hidden")

  ui = handleKey(snap, ui, ESC_K)
  assert.match(drawUi(rooms, ui), /pair-room/, "Esc restores every row")
})

test("a search that matches nothing says nothing matched", () => {
  const rooms = [room({ room: "alpha" })]
  let ui = normalizeUi({ query: { channels: "zzz" } })
  assert.match(drawUi(rooms, ui), /no room matches/)
})

test("while typing a query, an arrow key is IGNORED — not typed into the box", () => {
  // An arrow arrives as three bytes; a half-decoded sequence would put `[A` in the search box.
  const snap = snapOf(room())
  let ui = handleKey(snap, normalizeUi({}), "/")
  for (const ch of "ab") ui = handleKey(snap, ui, ch)
  ui = handleKey(snap, ui, UP)
  ui = handleKey(snap, ui, PGDN)
  assert.equal(ui.query.channels, "ab", "navigation keys must not reach the query")
  ui = handleKey(snap, ui, "\x7f")
  assert.equal(ui.query.channels, "a", "backspace does")
})

test("the flow filter shows only what wakes somebody, and names itself", () => {
  const subs = [seat({ seat: "web-app#1111" })]
  const messages = [
    msg({ type: "FACT", text: "nem ébreszt senkit" }),
    msg({ ts: "2026-08-11T10:01:00.000+02:00", type: "QUESTION", text: "ez ébreszt" }),
  ]
  const r = room({ subs, messages })
  let ui = handleKey(snapOf(r), normalizeUi({ pane: "flow" }), "f")
  assert.equal(ui.filter, "waking")
  const screen = drawUi([r], ui)
  assert.match(screen, /ez ébreszt/)
  assert.ok(!screen.includes("nem ébreszt senkit"), "non-waking entries are filtered out")
  assert.match(screen, /waking only/, "the filter names itself on screen")
})

test("the flow follows new entries only when it is at the bottom", () => {
  const a = msg({ ts: "2026-08-11T10:00:00.000+02:00", text: "első" })
  const b = msg({ ts: "2026-08-11T10:01:00.000+02:00", text: "második" })
  const snap = snapOf(room({ messages: [a, b] }))
  const atBottom = normalizeUi({ pane: "flow" })
  assert.equal(atBottom.follow, true, "a fresh view follows")

  const scrolledUp = handleKey(snap, atBottom, UP)
  assert.equal(scrolledUp.follow, false, "scrolling up stops following")
  assert.equal(scrolledUp.sel.flow, `${a.ts}|${a.from}`)

  const backDown = handleKey(snap, scrolledUp, END_K)
  assert.equal(backDown.follow, true, "End follows again")
})

test("the flow states when newer entries are below the fold", () => {
  const messages = Array.from({ length: 30 }, (_, i) =>
    msg({ ts: `2026-08-11T10:${String(i).padStart(2, "0")}:00.000+02:00`, text: `m${i}` }))
  const snap = snapOf(room({ messages }))
  let ui = normalizeUi({ pane: "flow" })
  for (let i = 0; i < 25; i++) ui = handleKey(snap, ui, UP)
  assert.match(drawUi([room({ messages })], ui, 200, 24), /newer below/)
})

test("the top of the LOADED window is stated, never a silent boundary", () => {
  // `history` returns the newest N; ending at entry 400 with no word about it is the same
  // mistake as the `… és még N` this change removed.
  const messages = Array.from({ length: 5 }, (_, i) =>
    msg({ ts: `2026-08-11T10:0${i}:00.000+02:00`, text: `m${i}` }))
  const r = room({ messages, total: 160 })
  const ui = normalizeUi({ pane: "flow", sel: { flow: `${messages[0].ts}|${messages[0].from}` } })
  assert.match(drawUi([r], ui, 200, 40), /top of the loaded window.*holds 160 entries/s)
})

test("`?` lists every binding, generated from the one key table", () => {
  const r = room()
  const ui = handleKey(snapOf(r), normalizeUi({}), "?")
  const screen = drawUi([r], ui, 120, 30)
  for (const k of KEYS) assert.ok(screen.includes(k.keys), `missing binding: ${k.keys}`)
  assert.match(screen, /only reads/, "the read-only promise is stated where the keys are")
  assert.equal(handleKey(snapOf(r), ui, "x").overlay, null, "any key closes the help")
})

test("every line fits, at 60 columns, with an overlay open and a query active", () => {
  const long = seat({ seat: "some-very-long-project-name#deadbeefcafe", behind: 12, focus: "x".repeat(400) })
  const r = room({ subs: [long], messages: [msg({ text: "y".repeat(2000), to: ["a".repeat(80)] })] })
  process.stdout.columns = 60
  process.stdout.rows = 24
  const screens = [
    render({ rooms: [r], at: new Date() }, { pane: "subs", query: { subs: "z".repeat(50) } }),
    render({ rooms: [r], at: new Date() }, { overlay: { kind: "entry", entry: r.messages[0], room: "team", scroll: 0 } }),
    render({ rooms: [r], at: new Date() }, { overlay: { kind: "seat", seat: long, scroll: 0 } }),
    render({ rooms: [r], at: new Date() }, { overlay: { kind: "help", scroll: 0 } }),
  ]
  for (const screen of screens) {
    for (const line of screen.split("\n")) {
      assert.ok(width(line) <= 60, `line too wide (${width(line)}): ${plain(line).slice(0, 50)}`)
    }
  }
})

test("a terminal too short to give a pane rows renders rather than throwing", () => {
  const r = room({ subs: [seat()], messages: [msg()] })
  for (const rows of [1, 3, 6, 10]) {
    assert.doesNotThrow(() => drawUi([r], { pane: "flow" }, 80, rows), `rows=${rows}`)
  }
})

test("wrap breaks long text without losing a character", () => {
  const text = "szó ".repeat(200).trim()
  const lines = wrap(text, 40)
  for (const l of lines) assert.ok(width(l) <= 40)
  assert.equal(lines.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim())
  // A word longer than the line is broken, not dropped and not left to wrap the terminal.
  assert.ok(wrap("x".repeat(100), 20).every(l => width(l) <= 20))
})

test("`quiet` is a FOURTH state — not dead, not unknown, not simply live", () => {
  // The only one of the four somebody declared. Folding it into `live` would make a seat that
  // asked not to be interrupted indistinguishable from one that died.
  const q = seat({ seat: "csendes#1", live: true, quiet: true, quietUntil: "2026-08-11T12:00:00.000+02:00", behind: 7 })
  const r = room({ subs: [q] })
  // The seat's OWN row, not the whole screen — the pane header carries a legend of all four
  // marks, which is exactly what a naive `screen.includes("○")` would trip over.
  const row = plain(render({ rooms: [r], at: new Date() }, { pane: "subs" }))
    .split("\n").find(l => l.includes("csendes#1"))
  assert.match(row, /◐/, "quiet has its own mark")
  assert.ok(!/○/.test(row), "…and it is not the dead circle")
  assert.ok(!/\?/.test(row), "…nor the unknown mark")

  const ui = handleKey(snapOf(r), normalizeUi({ pane: "subs" }), ENTER)
  const detail = drawUi([r], ui, 120, 30)
  assert.match(detail, /quiet/)
  assert.match(detail, /still receives everything/, "the overlay says delivery is unaffected")
  assert.match(detail, /12:00/, "…and until when")
})
