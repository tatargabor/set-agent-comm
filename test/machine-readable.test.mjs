// A CONTRACT SOMEBODY ELSE'S SCREEN DEPENDS ON, and a phase nobody is allowed to guess.
//
// Both halves were asked for by `set-core` on 2026-08-17, while building a surface that shows
// every running agent on the machine at once (FleetView). Both came with a measurement:
//
//   1. `sac agents --json` printed the human tree and SWALLOWED the flag. The consequence is not
//      an ugly error message — it is that the surface went off and read `registry.json` and
//      `focus.json` directly, which quietly makes this store's on-disk layout their contract.
//   2. Reading the PHASE out of the session log does not work. In a session that spent its whole
//      life on OpenSpec work, the obvious signal — an `/opsx:` slash command — matched 0 times.
//
// The CLI is spawned as a real process here, the way a hook, a person and a foreign program all
// run it, and every case reads the result back rather than trusting the call.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = new URL("../bin/sac.mjs", import.meta.url).pathname

// ONE exit listener for all of them: a `process.on("exit")` per test hit node's ten-listener
// warning at test six, and a warning printed by the test file is noise in exactly the place a
// real failure has to be readable.
const ROOTS = []
process.on("exit", () => ROOTS.forEach(r => rmSync(r, { recursive: true, force: true })))

/** One store per test, and one owner pid, so the seats below are the only seats there are. */
function makeSac() {
  const root = mkdtempSync(join(tmpdir(), "sac-json-"))
  ROOTS.push(root)
  return (args, env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        SET_AGENT_COMM_DIR: root,
        SET_AGENT_NAME: "proj",
        CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1111-2222-3333-444444444444",
        ...env,
      },
      encoding: "utf8",
    })
    return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 1, root }
  }
}

// ── the machine-readable view ─────────────────────────────────────────────────

test("`sac agents --json` returns JSON — the flag is not swallowed", () => {
  const sac = makeSac()
  sac(["register", "r"])
  const r = sac(["agents", "--json"])
  assert.equal(r.code, 0, r.stderr)
  const out = JSON.parse(r.stdout)  // throws on the human tree, which is the whole point
  assert.equal(out.schema, "sac.agents/1",
    "the shape is versioned, or a reader cannot notice the day it changes")
  assert.equal(out.agents[0].agent, "proj")
})

test("the JSON is a NAMED projection, not the registry record spread into the wire", () => {
  // ⚠ If this ever fails because a new field appeared, that is the test doing its job: the field
  // was added to the store and leaked into somebody else's contract without anyone deciding to
  // publish it. Add it to `agentsReport` on purpose, or leave it out.
  const sac = makeSac()
  sac(["register", "r"])
  const out = JSON.parse(sac(["agents", "--json"]).stdout)
  assert.deepEqual(Object.keys(out).sort(), ["agents", "generatedAt", "schema"])
  assert.deepEqual(Object.keys(out.agents[0]).sort(),
    ["agent", "host", "lastSeen", "project", "rooms", "seats", "silentMinutes"])
  assert.deepEqual(Object.keys(out.agents[0].seats[0]).sort(),
    ["focus", "lastSeen", "lastWrote", "liveness", "quiet", "quietUntil", "seat", "session"])
  // The registry keeps this one; the wire does not publish it. Named list, not a spread.
  assert.ok(!("firstSeen" in out.agents[0]), "an internal field reached the wire")
})

test("liveness crosses the wire as a WORD — `unknown` cannot collapse into `gone`", () => {
  // The three-state rule only survives a process boundary if the value forces three branches.
  // `if (seat.live)` on a nullable boolean silently reads "we do not know" as "dead", in the
  // reassuring direction — measured 2026-08-09 as 86 minutes of apparent silence from a seat that
  // was working the whole time, and a session that addressed somebody else because of it.
  const sac = makeSac()
  // owner pid 0 is nobody's process, so the seat is not `live`; it just checked in, so it is not
  // `gone` either. That is precisely the middle state.
  sac(["register", "r"], { SET_AGENT_OWNER_PID: "0" })
  const out = JSON.parse(sac(["agents", "--json"], { SET_AGENT_OWNER_PID: "0" }).stdout)
  const seat = out.agents[0].seats[0]
  assert.equal(seat.liveness, "unknown")
  assert.ok(!("live" in seat), "a nullable boolean alongside it would be the collapse, back again")
})

test("an unknown flag on `agents` STOPS — the same rule `prune --dry` earned", () => {
  const sac = makeSac()
  const r = sac(["agents", "--jsn"])
  assert.notEqual(r.code, 0, "a misspelled flag that prints the human tree is how this started")
  assert.match(r.stderr + r.stdout, /unknown flag '--jsn'/)
})

test("`sac agents --json` on an empty registry is still JSON, not the prose line", () => {
  // The human face prints "(the registry is empty)". A caller that parses the output must get an
  // empty list on the empty case, or its first run against a fresh store is a crash.
  const out = JSON.parse(makeSac()(["agents", "--json"]).stdout)
  assert.deepEqual(out.agents, [])
})

// ── the declared phase ────────────────────────────────────────────────────────

test("`--phase` is stored, and reaches the machine view next to the sentence", () => {
  const sac = makeSac()
  sac(["register", "r"])
  const set = JSON.parse(sac(["focus", "reading the store", "--phase", "explore"]).stdout)
  assert.equal(set.phase, "explore")
  const out = JSON.parse(sac(["agents", "--json"]).stdout)
  const f = out.agents[0].seats[0].focus
  assert.equal(f.phase, "explore")
  assert.equal(f.text, "reading the store")
  assert.equal(f.stale, false, "`stale` travels WITH the declaration — a phase ages out with it")
})

test("an unknown phase is an ERROR — the vocabulary is the point of the field", () => {
  const sac = makeSac()
  sac(["register", "r"])
  const r = sac(["focus", "doing things", "--phase", "refactoring"])
  assert.notEqual(r.code, 0, "a free-text phase is a phase a program has to go back to guessing")
  assert.match(r.stderr + r.stdout, /unknown phase 'refactoring'/)
  assert.match(r.stderr + r.stdout, /explore, plan, apply, verify, blocked/)
})

test("a phase does NOT survive a re-declaration of the sentence", () => {
  // A sentence from now and a phase from three hours ago is the exact lie this field exists to
  // avoid. "We do not know" is this project's honest default everywhere else.
  const sac = makeSac()
  sac(["register", "r"])
  sac(["focus", "first thing", "--phase", "apply"])
  const again = JSON.parse(sac(["focus", "a different thing"]).stdout)
  assert.equal(again.phase, undefined, "the old phase was carried over onto a new sentence")
})

test("`--phase` ALONE re-declares the standing sentence — it is not a read", () => {
  const sac = makeSac()
  sac(["register", "r"])
  sac(["focus", "the same piece of work", "--files", "a.mjs,b.mjs", "--phase", "plan"])
  const moved = JSON.parse(sac(["focus", "--phase", "verify"]).stdout)
  assert.equal(moved.phase, "verify")
  assert.equal(moved.text, "the same piece of work", "the sentence was lost — this is a phase move")
  assert.deepEqual(moved.files, ["a.mjs", "b.mjs"])
})

test("a phase with nothing to attach it to fails, rather than declaring half a thing", () => {
  const sac = makeSac()
  sac(["register", "r"])
  const r = sac(["focus", "--phase", "blocked"])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr + r.stdout, /say what you are working on first/)
})

test("`sac focus` with no arguments still READS, and `--json` is a no-op on it", () => {
  const sac = makeSac()
  sac(["register", "r"])
  sac(["focus", "something", "--phase", "apply"])
  const read = JSON.parse(sac(["focus"]).stdout)
  assert.equal(read.phase, "apply")
  assert.deepEqual(JSON.parse(sac(["focus", "--json"]).stdout).phase, "apply",
    "the flag another program will spell out must not clear the focus or fail")
})

test("the human view shows the phase, and shows nothing where none was declared", () => {
  const sac = makeSac()
  sac(["register", "r"])
  sac(["focus", "with a phase", "--phase", "blocked"])
  assert.match(sac(["agents"]).stdout, /blocked · with a phase/)
  sac(["focus", "without one"])
  const plain = sac(["agents"]).stdout
  assert.match(plain, /↳ without one/)
  assert.ok(!/unknown|null/.test(plain), "a missing declaration is not a state to draw")
})
