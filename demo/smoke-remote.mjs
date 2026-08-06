#!/usr/bin/env node
/**
 * The REMOTE leg, tested without buying a single model call.
 *
 *   node demo/smoke-remote.mjs
 *
 * Two "machines" are two store directories — which is all a second computer is, as far as this
 * code is concerned — with a real relay between them and the real `sac relay use` / `sac invite` /
 * `sac join` handshake. A fake `claude` (see `fake-claude.mjs`) does the writing and the reading.
 *
 * What it proves is the one question a local run cannot ask: does an entry written on one machine
 * ARRIVE on the other. Undelivered and merely slow look identical from the writing machine, which
 * is exactly why this is measured rather than assumed.
 */
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), "sac-demo-remote-"))
const bin = join(tmp, "bin")
mkdirSync(bin)
writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "fake-claude.mjs")}" "$@"\n`)
chmodSync(join(bin, "claude"), 0o755)

// A port of its own, so a run of this never collides with a real relay or with the other smoke test.
const PORT = process.env.DEMO_RELAY_PORT || "7614"

const r = spawnSync(process.execPath, [join(HERE, "harness.mjs"), join(HERE, "scenarios", "_smoke-remote.json")], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEMO_RUN_DIR: join(tmp, "run"),
         DEMO_RELAY_PORT: PORT, SET_AGENT_TRIAGE: "off" },
  encoding: "utf8",
})
const out = r.stdout + r.stderr
const fail = m => { console.error(`${out}\n✖ ${m}`); rmSync(tmp, { recursive: true, force: true }); process.exit(1) }

try {
  assert.equal(r.status, 0, `the harness exited ${r.status}`)
  assert.match(out, new RegExp(`relay http://127\\.0\\.0\\.1:${PORT}`), "the relay never came up, or the handshake failed")

  // Four seats across two machines. Same trap as the local smoke test: a shared owner pid would
  // collapse them, and here a shared STORE would collapse the two machines as well.
  const seats = [...out.matchAll(/seat=([0-9a-f]{8})/g)].map(m => m[1])
  assert.equal(new Set(seats).size, 4, `expected 4 distinct seats, got ${JSON.stringify(seats)}`)

  assert.match(out, /BEJEGYZÉSEK \(1\)/,
    "the entry was counted twice — the two machines' copies were not recognised as one entry")
  assert.match(out, /átért a másik gépre\s+1\/1/,
    "the entry never reached the other machine: written, pushed, and nowhere to be read")

  console.log(`✔ demo remote smoke: relay on ${PORT}, 2 machines, 4 seats, 1 entry, crossed 1/1`)
} catch (e) { fail(e.message) }
rmSync(tmp, { recursive: true, force: true })
