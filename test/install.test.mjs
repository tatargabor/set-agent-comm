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
// ⚠ A TEMP STORE, not the live one. `install` OPENS the rooms it wires in, and without this the
// suite left `team`, `design` and `proj` sitting in the developer's own bus — found there
// 2026-08-12, next to the rooms real sessions use.
const STORE = mkdtempSync(join(tmpdir(), "sac-install-store-"))
process.on("exit", () => {
  rmSync(PROJ, { recursive: true, force: true })
  rmSync(STORE, { recursive: true, force: true })
})

mkdirSync(join(PROJ, ".claude"), { recursive: true })
const install = (...args) => spawnSync(process.execPath, [SAC, "install", ...args], {
  cwd: PROJ, encoding: "utf8",
  env: { ...process.env, SET_AGENT_NAME: "proj", SET_AGENT_COMM_DIR: STORE },
})
const settings = () => JSON.parse(readFileSync(FILE, "utf8"))
const commands = (s, event) => (s.hooks?.[event] || []).flatMap(g => g.hooks || []).map(h => h.command)

writeFileSync(FILE, JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo someone-elses-hook" }] }] },
  env: { FOO: "bar" },
}, null, 2))

test("it adds all three hooks and leaves everything else alone", () => {
  const r = install("team")
  assert.equal(r.status, 0, r.stderr)
  const s = settings()
  assert.ok(commands(s, "SessionStart").includes("echo someone-elses-hook"), "it dropped another hook")
  assert.deepEqual(s.env, { FOO: "bar" }, "it touched a part of the file that is none of its business")
  assert.equal(commands(s, "SessionStart").filter(c => c.includes("session-start.mjs")).length, 1)
  assert.equal(commands(s, "Stop").filter(c => c.includes("stop.mjs")).length, 1)
  // The third one is the sign of life. Without it the registry's liveness field is written
  // once, at session start, and a seat that works for an hour reads as silent for an hour.
  assert.equal(commands(s, "PostToolUse").filter(c => c.includes("heartbeat.mjs")).length, 1)
  // The interpreter is an absolute path, not a bare `node`: hooks run in a non-interactive
  // shell, and on macOS node commonly lives under the home directory, reaching PATH only from
  // an interactive profile. A bare `node` there is a hook that silently never fires.
  for (const c of [...commands(s, "SessionStart"), ...commands(s, "Stop"), ...commands(s, "PostToolUse")].filter(c => c.includes(".mjs")))
    assert.match(c, /\s\/\S*node\S*\s/, `the hook command relies on PATH: ${c}`)
})

test("it installs the skill too, with the commands baked in", () => {
  // The hooks make sure a message is NOTICED; the skill says what to do with it. The commands
  // are substituted at install time because a skill is a static file, and an agent guessing at
  // a path is an agent that silently does not watch.
  const skill = readFileSync(join(PROJ, ".claude", "skills", "agent-comm", "SKILL.md"), "utf8")
  assert.doesNotMatch(skill, /\{\{/, "a placeholder was left in the installed skill")
  assert.match(skill, /Monitor\(\{ command: ".*sac\.mjs wait team"/, "the watch command is not spelled out")
  assert.match(skill, /^---\nname: agent-comm$/m, "the frontmatter is not what Claude Code reads")
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

test("a new room is ADDED to the project's rooms — it does not replace them", () => {
  // Reported from `consumer-a` 2026-08-12: on a project already in two rooms,
  // `sac install consumer-a-bugfix --dry-run` previewed `SET_AGENT_ROOM` cut down to the one room asked
  // for. This list is what EVERY session of the project starts in, and nothing said it would be
  // taken away. The reporter hand-edited settings.json to avoid it — which is project-wide too,
  // and pulled two live sibling sessions into the room within a minute.
  writeFileSync(FILE, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{
      type: "command",
      command: "SET_AGENT_ROOM=team,design node $HOME/code2/set-agent-comm/hooks/session-start.mjs",
    }] }] },
  }, null, 2))
  const r = install("bugfix")
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /rooms: team, design, bugfix/, "the resulting list is not stated")
  for (const event of ["SessionStart", "Stop", "PostToolUse"]) {
    const c = commands(settings(), event).find(c => c.includes("set-agent-comm") || c.includes(".mjs"))
    assert.match(c, /SET_AGENT_ROOM=team,design,bugfix /, `${event} lost a room`)
  }
})

test("--replace does cut it down, and says out loud which rooms it took", () => {
  const r = install("bugfix", "--replace")
  assert.match(r.stdout, /REMOVED: team, design/, "it took two rooms away without naming them")
  assert.match(r.stdout, /sac part/, "…and without pointing at the per-session way to leave one")
  const c = commands(settings(), "SessionStart").find(c => c.includes("session-start.mjs"))
  assert.match(c, /SET_AGENT_ROOM=bugfix /)
})

test("--dry-run previews the merged list and writes nothing", () => {
  const before = readFileSync(FILE, "utf8")
  const r = install("team", "--dry-run")
  assert.match(r.stdout, /rooms: bugfix, team/)
  assert.equal(readFileSync(FILE, "utf8"), before)
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
