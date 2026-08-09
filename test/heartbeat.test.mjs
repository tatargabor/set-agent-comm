// THE SIGN OF LIFE, measured on the registry it writes — not on the calls it makes.
//
// The hook exists because the liveness field was only ever written at session start: measured
// 2026-08-09, a seat showed `lastSeen` 86 minutes old while it worked the whole time, and the
// session reading that list mis-addressed a message because of it.
//
// Two things here can only be got wrong once and then look fine forever, so both are pinned:
//
//   1. IT RECORDS THE WINDOW'S PID, not the hook's. The hook process is gone milliseconds after
//      it runs; a beat that recorded its own pid would leave the seat resolving to "we do not
//      know" — reporting the very thing it exists to correct.
//   2. IT RATE-LIMITS. `register` rewrites the whole shared registry, and this fires on EVERY
//      tool call; several sessions doing that at once is a lost-update race on the one file
//      every seat reads.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, utimesSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = join(HERE, "..", "hooks", "heartbeat.mjs")
const SESSION = "11111111-2222-3333-4444-555555555555"

let store
const beat = (env = {}) => spawnSync(process.execPath, [HOOK], {
  encoding: "utf8",
  env: {
    ...process.env,
    SET_AGENT_COMM_DIR: store,
    SET_AGENT_NAME: "web-app",
    SET_AGENT_ROOM: "team",
    CLAUDE_PROJECT_DIR: "/tmp/web-app",
    CLAUDE_CODE_SESSION_ID: SESSION,
    // The test has no `claude` ancestor to walk up to, so the window pid is stated. `process.pid`
    // is this test runner — alive for the whole run, which is exactly what a window's pid is.
    SET_AGENT_OWNER_PID: String(process.pid),
    ...env,
  },
})

/**
 * Read the seat off disk — the same file another agent's listing would read.
 *
 * Looked up BY SESSION, not by name: a seat is named with the SHORTEST form of the id that is
 * still free (`seatFor`), so `web-app#11111111` is the normal outcome and the full-id spelling
 * is the exception. Keying on the long name silently found nothing and read as "never
 * registered".
 */
const readSeat = () => {
  let reg
  try { reg = JSON.parse(readFileSync(join(store, "registry.json"), "utf8")) } catch { return null }
  const seats = reg.agents?.["web-app"]?.seats || {}
  return Object.values(seats).find(s => s.session === SESSION) || null
}

test("a beat records the WINDOW's pid, so the seat reads as live", t => {
  store = mkdtempSync(join(tmpdir(), "sac-beat-"))
  t.after(() => rmSync(store, { recursive: true, force: true }))

  const r = beat()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "", "a hook that fires on every tool call must print nothing")

  const s = readSeat()
  assert.ok(s, "the seat was not registered at all")
  const pids = Object.keys(s.writers).map(Number)
  assert.deepEqual(pids, [process.pid], "it recorded a pid that is not the window's")
})

test("it rate-limits: a second beat straight away does not rewrite the registry", t => {
  store = mkdtempSync(join(tmpdir(), "sac-beat-"))
  t.after(() => rmSync(store, { recursive: true, force: true }))

  beat()
  const first = readSeat().writers[process.pid]
  assert.ok(existsSync(join(store, "beats", `web-app#${SESSION}`)), "no stamp was written")

  beat()
  assert.equal(readSeat().writers[process.pid], first, "it wrote the shared registry twice in a row")
})

test("…and beats again once the stamp is old enough", t => {
  store = mkdtempSync(join(tmpdir(), "sac-beat-"))
  t.after(() => rmSync(store, { recursive: true, force: true }))

  beat()
  const first = readSeat().writers[process.pid]

  // Age the stamp past the interval rather than waiting a minute for it.
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(join(store, "beats", `web-app#${SESSION}`), old, old)

  beat()
  assert.notEqual(readSeat().writers[process.pid], first, "a due beat did not refresh the seat")
})

test("no session id means no beat — there is no seat to keep alive", t => {
  store = mkdtempSync(join(tmpdir(), "sac-beat-"))
  t.after(() => rmSync(store, { recursive: true, force: true }))

  const r = beat({ CLAUDE_CODE_SESSION_ID: "" })
  assert.equal(r.status, 0)
  assert.equal(readSeat(), null, "a bare run (cron, a terminal) invented a seat")
})

test("a broken store cannot fail the tool call it rides on", t => {
  // Exit 0 whatever happens: a liveness ping able to fail a turn is worse than the silence it
  // was written to fix. The store here is a path UNDER A REGULAR FILE, so every write fails
  // with ENOTDIR — a real failure, and one that fails fast rather than blocking, which for a
  // hook on the tool-call path matters as much as not throwing.
  const dir = mkdtempSync(join(tmpdir(), "sac-beat-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const notADir = join(dir, "file")
  writeFileSync(notADir, "")

  store = dir
  const started = Date.now()
  const r = beat({ SET_AGENT_COMM_DIR: join(notADir, "store") })
  assert.equal(r.status, 0, "the hook failed the turn")
  assert.ok(Date.now() - started < 5000, "the hook blocked the tool call instead of giving up")
})
