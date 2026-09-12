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
  assert.match(skill, /Monitor\(\{ command: ".*sac\.mjs wait"/, "the watch command is not spelled out")
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

// ⚠ A HAND-TUNED COMMAND IS SOMEONE'S WORK. Measured 2026-09-11 on blackbelt-web: the wired
// hooks carried (1) a portable `sh -c` form that finds node and the checkout at run time — the
// file is tracked and shared by two machines, so an absolute `/opt/homebrew/Cellar/node/25.8.2/…`
// path breaks the other one and the next `brew upgrade` — and (2) a guard that keeps `claude -p`
// children off the bus. `sac install bbweb-wpc --dry-run` previewed all three commands swapped
// for the canonical form: both edits gone, silently. The room list is the only part install owns.
const CUSTOM = (script, rooms) =>
  `[ -n "\${APPLY_CYCLE_CHILD:-}" ] && exit 0; SET_AGENT_NAME=proj SET_AGENT_ROOM=${rooms} sh -c 'N=$(command -v node) || exit 0; for d in "$HOME/code/set-agent-comm" "$HOME/set-agent-comm"; do [ -f "$d/hooks/${script}" ] && exec "$N" "$d/hooks/${script}"; done; exit 0'`
const customFile = rooms => writeFileSync(FILE, JSON.stringify({ hooks: {
  SessionStart: [{ hooks: [{ type: "command", command: CUSTOM("session-start.mjs", rooms) }] }],
  Stop: [{ hooks: [{ type: "command", command: CUSTOM("stop.mjs", rooms) }] }],
  PostToolUse: [{ hooks: [{ type: "command", command: CUSTOM("heartbeat.mjs", rooms) }] }],
} }, null, 2))

test("REGRESSION: a new room edits ONLY the room list of a hand-tuned command", () => {
  customFile("team")
  const r = install("bbweb")
  assert.equal(r.status, 0, r.stderr)
  for (const [event, script] of [["SessionStart", "session-start.mjs"], ["Stop", "stop.mjs"], ["PostToolUse", "heartbeat.mjs"]]) {
    const c = commands(settings(), event).find(c => c.includes(script))
    assert.equal(c, CUSTOM(script, "team,bbweb"), `${event}: more than the room list changed`)
  }
  assert.match(r.stdout, /rooms updated/, "it did not say what it changed")
})

test("an unchanged room list leaves a hand-tuned command byte-for-byte alone", () => {
  customFile("team")
  const before = readFileSync(FILE, "utf8")
  const r = install("team")
  assert.match(r.stdout, /already wired/)
  assert.equal(readFileSync(FILE, "utf8"), before, "it rewrote a command whose rooms were already right")
})

test("--rewrite restores the canonical command, and says so", () => {
  customFile("team")
  const r = install("team", "--rewrite")
  const c = commands(settings(), "SessionStart").find(c => c.includes("session-start.mjs"))
  assert.doesNotMatch(c, /APPLY_CYCLE_CHILD|sh -c/, "--rewrite kept the hand-tuned form")
  assert.match(c, /\s\/\S*node\S*\s/)
  assert.match(r.stdout, /rewritten/, "a full rewrite happened without being named")
})

test("a command with no SET_AGENT_ROOM in it is replaced — out loud", () => {
  writeFileSync(FILE, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: "command", command: "node $HOME/set-agent-comm/hooks/session-start.mjs",
  }] }] } }, null, 2))
  const r = install("team")
  const c = commands(settings(), "SessionStart").find(c => c.includes("session-start.mjs"))
  assert.match(c, /SET_AGENT_ROOM=team /)
  assert.match(r.stdout, /no SET_AGENT_ROOM/, "the replacement was silent")
})

// ── the watch command the skill hands the agent ─────────────────────────────────────────────
// It has to agree with the SessionStart note in all three respects, and the skill copy had drifted
// in all three. The third one is the counter-intuitive one: see `waitCmd` in the hook for why a
// self-re-arming `while` wrapper is not the fix it looks like.

test("the skill's watch command is a SIMPLE command — never a self-re-arming loop", () => {
  // ⚠ Tried and reverted 2026-09-12. `bash -c '<simple command>'` execs, so the watch's parent is
  // the process the Monitor spawned it from and the "die with the session" guard works. In a loop
  // bash forks, node's parent becomes that bash, the guard never fires, and the age cap respawns
  // the watcher instead of ending it — an immortal watch ingesting off a cursor nobody advances.
  const skill = readFileSync(join(PROJ, ".claude", "skills", "agent-comm", "SKILL.md"), "utf8")
  const line = skill.split("\n").find(l => l.includes("Monitor({ command:"))
  assert.doesNotMatch(line, /while true/, "a wrapper orphans the watch from its session")
  assert.doesNotMatch(line, /\|\| break/, "`break` returns 0 — a failed watch reports a clean finish")
})

test("the skill's watch command SEEDS the rooms in the environment, never as arguments", () => {
  // ⚠ Argued, the rooms mean 'watch exactly these', resolved once when the Monitor is armed — so a
  // room joined later is watched by nothing while `send` reports the seat woken (2026-08-19).
  const skill = readFileSync(join(PROJ, ".claude", "skills", "agent-comm", "SKILL.md"), "utf8")
  const line = skill.split("\n").find(l => l.includes("Monitor({ command:"))
  assert.match(line, /SET_AGENT_ROOM=team/, "the room list is not in the environment")
  assert.match(line, /sac\.mjs wait"/, "a room was argued to `wait` — it pins the list")
})

test("…and it carries SET_AGENT_COMM_DIR, so the watch is on the store the hook uses", () => {
  // The measured 2026-08-08 failure the hook's own ENV exists for: a watch armed against the
  // DEFAULT store creates an empty room directory and sits watching it. Nothing fails, and it is
  // indistinguishable from a working watch until a message does not arrive.
  const skill = readFileSync(join(PROJ, ".claude", "skills", "agent-comm", "SKILL.md"), "utf8")
  const line = skill.split("\n").find(l => l.includes("Monitor({ command:"))
  assert.ok(line.includes(`SET_AGENT_COMM_DIR=${STORE}`), "the skill would watch a different store")
})
