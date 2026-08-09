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

import { render, wakesSeat, width } from "../src/admin-tui.mjs"

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
  assert.ok(!screen.includes("5000 le van maradva"), "a closed seat must not read as 'behind'")
  assert.match(screen, /5000 olvasatlan \(lezárt ülés\)/)
  assert.match(screen, /2 le van maradva/)
})

test("an UNKNOWN liveness counts as reachable and is drawn as unknown, never as dead", () => {
  // Measured 2026-08-09: a seat looked silent for 86 minutes while working the whole time.
  // Rendering "we do not know" as "dead" is how work gets routed away from a live session.
  const screen = draw([room({ subs: [seat({ live: null, behind: 4, waking: 1 })] })])
  assert.match(screen, /1\/1/)
  assert.match(screen, /\?\s+web-app#1111/)
  assert.match(screen, /4 le van maradva \(1 ébresztő\)/)
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
  assert.match(draw([]), /még nincs szoba/)
})
