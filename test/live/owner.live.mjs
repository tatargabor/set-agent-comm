// LIVE: asking the person (owner-addressee), with a real `claude -p` session. `npm run live`.
//
// Asserted on what lands on disk: a session told in plain words to ask the human of this machine
// addresses `owner` (not a broadcast, not "→ owner" in the text), wakes nobody, and the question
// appears on `sac owner --json` until the owner closes it.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { bus, session, say, results, entries, seatOf, stopAll } from "./harness.mjs"

const b = bus()
after(() => stopAll(b))
const SAC = fileURLToPath(new URL("../../bin/sac.mjs", import.meta.url))
const sac = (...args) => spawnSync(process.execPath, [SAC, ...args], { encoding: "utf8",
  env: { ...process.env, SET_AGENT_COMM_DIR: b.root, SET_AGENT_NAME: "operator", CLAUDE_CODE_SESSION_ID: "",
         CLAUDE_CODE_MESSAGING_SOCKET: "", SET_AGENT_TRIAGE: "off" } })

const worker = session(b, "ops", { mode: "default" })
const other = session(b, "peer", { mode: "default" })

test("a session asked to consult the person addresses `owner`, and it waits on the owner's list", async () => {
  say(other, "Reply with one word: READY.")
  await results(other, 1)
  say(worker, "Kérdezd meg a gép gazdáját (az embert, nem egy másik agentet) az agent buszon, hogy " +
    "telepíthetünk-e pénteken. Aztán válaszolj egy szóval: KÉSZ.")
  await results(worker, 1)
  const q = entries(b).find(e => e.from.startsWith("ops#") && /→ owner/.test(e.header))
  assert.ok(q, `no entry addressed to owner: ${JSON.stringify(entries(b).map(e => e.header))}`)
  const view = JSON.parse(sac("owner", "--json").stdout)
  assert.equal(view.schema, "sac.owner/1")
  const item = view.open.find(o => o.from === seatOf(b, worker))
  assert.ok(item, `not on the owner's list: ${JSON.stringify(view)}`)
  // Nobody was rung, and the other session did not start a turn for it.
  assert.ok(!existsSync(join(b.root, "rung")) || readdirSync(join(b.root, "rung")).length === 0)
  await new Promise(r => setTimeout(r, 10_000))
  assert.equal(other.results, 1, "a session was woken for a question only the person can answer")

  const closed = sac("owner", "close", "team", item.ts, "yes, Friday is fine")
  assert.equal(closed.status, 0, closed.stderr)
  assert.equal(JSON.parse(sac("owner", "--json").stdout).open.length, 0)
})
