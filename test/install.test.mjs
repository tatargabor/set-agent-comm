// `sac install` — it edits a file that is NOT ours: the project's settings.json, which holds
// other people's hooks. Every case here is about not damaging it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const SAC = join(HERE, "..", "bin", "sac.mjs")
const PROJ = mkdtempSync(join(tmpdir(), "sac-install-"))
const FILE = join(PROJ, ".claude", "settings.json")
process.on("exit", () => rmSync(PROJ, { recursive: true, force: true }))

mkdirSync(join(PROJ, ".claude"), { recursive: true })
const install = (...args) => spawnSync(process.execPath, [SAC, "install", ...args], {
  cwd: PROJ, encoding: "utf8", env: { ...process.env, SET_AGENT_NAME: "proj" },
})
const settings = () => JSON.parse(readFileSync(FILE, "utf8"))
const commands = (s, event) => (s.hooks?.[event] || []).flatMap(g => g.hooks || []).map(h => h.command)

writeFileSync(FILE, JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo someone-elses-hook" }] }] },
  env: { FOO: "bar" },
}, null, 2))

test("it adds both hooks and leaves everything else alone", () => {
  const r = install("team")
  assert.equal(r.status, 0, r.stderr)
  const s = settings()
  assert.ok(commands(s, "SessionStart").includes("echo someone-elses-hook"), "it dropped another hook")
  assert.deepEqual(s.env, { FOO: "bar" }, "it touched a part of the file that is none of its business")
  assert.equal(commands(s, "SessionStart").filter(c => c.includes("session-start.mjs")).length, 1)
  assert.equal(commands(s, "Stop").filter(c => c.includes("stop.mjs")).length, 1)
})

test("it takes a backup before writing — this file is not reconstructible", () => {
  assert.ok(readdirSync(join(PROJ, ".claude")).some(f => f.startsWith("settings.json.bak.")))
})

test("running it again changes nothing — no second copy", () => {
  const before = readFileSync(FILE, "utf8")
  const r = install("team")
  assert.match(r.stdout, /already wired/)
  assert.equal(readFileSync(FILE, "utf8"), before, "an idempotent run rewrote the file")
})

test("a changed room UPDATES the command instead of adding another one", () => {
  install("team,design")
  const cmds = commands(settings(), "SessionStart").filter(c => c.includes("session-start.mjs"))
  assert.equal(cmds.length, 1, "the old command was left in place next to the new one")
  assert.match(cmds[0], /SET_AGENT_ROOM=team,design/)
})

test("REGRESSION: it recognises an entry written with $HOME, not just an absolute path", () => {
  // Measured on the live `consumer-a` project: the hook was already wired in as
  // `$HOME/code2/set-agent-comm/hooks/session-start.mjs`. Matching on the absolute path did not
  // see it, so a re-run would have added a SECOND copy of the same hook next to it.
  writeFileSync(FILE, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{
      type: "command",
      command: "SET_AGENT_ROOM=team node $HOME/code2/set-agent-comm/hooks/session-start.mjs",
    }] }] },
  }, null, 2))
  install("team")
  assert.equal(commands(settings(), "SessionStart").filter(c => c.includes("session-start.mjs")).length, 1,
    "the same hook ended up in the file twice")
})

test("it refuses to touch a settings.json it cannot parse", () => {
  writeFileSync(FILE, "{ this is not json")
  const r = install("team")
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /not valid JSON/)
  assert.equal(readFileSync(FILE, "utf8"), "{ this is not json", "it wrote over a file it did not understand")
})

test("--dry-run writes nothing", () => {
  writeFileSync(FILE, "{}")
  const r = install("team", "--dry-run")
  assert.match(r.stdout, /\[dry run\]/)
  assert.equal(readFileSync(FILE, "utf8"), "{}")
})
