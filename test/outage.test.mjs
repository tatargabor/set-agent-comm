// WHAT THE WATCHER IS ALLOWED TO SAY WHILE IT IS FIXING SOMETHING ITSELF.
//
// The watcher's stdout is the event stream that starts a turn, so its own housekeeping obeys the
// same rule as the traffic it carries: being read is free, being interrupted is not. Measured
// 2026-08-07 on this project's room — three transient 502s in an evening, every one absorbed by
// the retry loop within a second, and every one bought a turn of an Opus session. Three of the
// five events that watch produced all night were that.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "sac-outage-"))
process.env.SET_AGENT_COMM_DIR = ROOT
const { outageLog } = await import("../src/bridge.mjs")
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

const recorder = (after = 5) => {
  const said = []
  return { said, log: outageLog({ report: m => said.push(m), after }) }
}

test("a blip the retry loop absorbs by itself says NOTHING", () => {
  const { said, log } = recorder()
  log.failed("relay down")
  log.recovered("relay back")
  assert.deepEqual(said, [],
    "one 502 that healed in a second woke a session — the failure this whole rule exists to prevent")
})

test("an outage that stops being plausible is announced ONCE, not per attempt", () => {
  const { said, log } = recorder()
  for (let i = 0; i < 20; i++) log.failed("relay down")
  assert.equal(said.length, 1, `20 failed attempts produced ${said.length} interruptions`)
  assert.match(said[0], /relay down/)
  assert.match(said[0], /local messages are unaffected/,
    "an alarm that does not say what still works invites a second turn spent finding out")
})

test("coming back is worth exactly one line — and only if we complained", () => {
  const { said, log } = recorder()
  for (let i = 0; i < 5; i++) log.failed("relay down")
  log.recovered("relay back")
  assert.deepEqual(said.slice(1), ["relay back"])
  // …and a later blip starts the count again rather than riding on the old alarm.
  log.failed("relay down")
  assert.equal(said.length, 2, "the counter did not reset — the next real outage would stay silent")
})
