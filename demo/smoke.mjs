#!/usr/bin/env node
/**
 * The harness, tested without buying a single model call.
 *
 *   node demo/smoke.mjs
 *
 * A live run costs a few dollars and half an hour, which is the wrong loop to be in when what
 * broke is the harness itself. This puts a fake `claude` (see `fake-claude.mjs`) first on `PATH`,
 * runs a two-project scenario through the real harness, the real installer and the real store, and
 * checks the numbers the report is supposed to produce.
 *
 * It runs in its own `DEMO_RUN_DIR`, so it can never wipe a paid run's measurement.
 */
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), "sac-demo-smoke-"))
const bin = join(tmp, "bin")
mkdirSync(bin)

// A `claude` on PATH, ahead of the real one. The harness looks it up by name, exactly as it will
// in a paid run — the lookup itself is part of what is under test.
writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "fake-claude.mjs")}" "$@"\n`)
chmodSync(join(bin, "claude"), 0o755)

const r = spawnSync(process.execPath, [join(HERE, "harness.mjs"), join(HERE, "scenarios", "_smoke.json")], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEMO_RUN_DIR: join(tmp, "run"), SET_AGENT_TRIAGE: "off" },
  encoding: "utf8",
})
const out = r.stdout + r.stderr
const fail = m => { console.error(`${out}\n✖ ${m}`); rmSync(tmp, { recursive: true, force: true }); process.exit(1) }

try {
  assert.equal(r.status, 0, `the harness exited ${r.status}`)

  // Four distinct seats: two projects with two sessions each. This is the number that collapses to
  // one the moment window reconciliation is fed a shared owner pid, so it is checked first.
  const created = [...out.matchAll(/seat=([0-9a-f]{8})/g)].map(m => m[1])
  assert.equal(new Set(created).size, 4, `expected 4 distinct seats, got ${JSON.stringify(created)}`)

  // Both entries arrived, addressed the way the scenario wrote them.
  assert.match(out, /BEJEGYZÉSEK \(2\)/, "the two entries did not reach the report")
  assert.match(out, /broadcast\s+1\/2/, "the broadcast FACT was miscounted")
  assert.match(out, /projektre címzett\s+1\/2/, "the project-addressed REQUEST was miscounted")

  // The rule, computed over every (entry, seat) pair. The broadcast FACT wakes nobody; the REQUEST
  // to `alpha` wakes both of its seats and neither of beta's — so 2 now against 5 under the old
  // "everything addressed to me interrupts me" rule.
  assert.match(out, /a mostani szabállyal\s+2\b/, "the wake-up count is not what the rule says")
  assert.match(out, /a régivel \(minden 'nekem szól'\)\s+5\b/, "the old-rule baseline drifted")

  // Every seat declared a focus in its intro — including the two that never wrote to the room.
  // The denominator is the point: derived from the writers it used to print 2/2 and look perfect.
  assert.match(out, /FÓKUSZ \(4\/4 seat mondta ki\)/, "the focus coverage denominator is wrong again")

  console.log("✔ demo harness smoke: 4 seats, 2 entries, wake-ups 2 vs 5, focus 4/4")
} catch (e) { fail(e.message) }
rmSync(tmp, { recursive: true, force: true })
