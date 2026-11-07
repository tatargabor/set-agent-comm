// THE PORTABLE HOOK LINE and the machine half it needs — `sac hook`, `sac setup`, `sac uninstall`,
// `sac plugin-files`, `sac doctor` (2026-11-07).
//
// Measured that day on this machine: 5 of 10 projects of one family had no bus hook at all. The
// old line named this machine's node and checkout, so it could not live in a tracked file (a commit
// gate refused it; another machine's Stop hook broke on it), and every project that moved it out
// by hand lost it on the machine where the local file was never written. Every case here runs the
// line the way Claude Code does — `sh -c '<the line>'` — and reads the result back from the disk.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const SAC = join(HERE, "..", "bin", "sac.mjs")
const CHECKOUT = join(HERE, "..")
const STORE = mkdtempSync(join(tmpdir(), "sac-portable-store-"))
const HOME = mkdtempSync(join(tmpdir(), "sac-portable-home-"))
const CONFIG = mkdtempSync(join(tmpdir(), "sac-portable-claude-"))
process.env.SET_AGENT_COMM_DIR = STORE
process.env.CLAUDE_CONFIG_DIR = CONFIG
const store = await import("../src/store.mjs")

const BASE_ENV = { SET_AGENT_COMM_DIR: STORE, HOME, CLAUDE_CONFIG_DIR: CONFIG, SET_AGENT_TRIAGE: "off",
                   PATH: "/usr/bin:/bin", SET_AGENT_HEADLESS: "1" }
const sac = (args, { cwd = HOME, env = {} } = {}) =>
  spawnSync(process.execPath, [SAC, ...args], { cwd, encoding: "utf8", env: { ...BASE_ENV, ...env } })
const runLine = (line, { cwd, env = {}, stdin = {} } = {}) =>
  spawnSync("/bin/sh", ["-c", line], { cwd, encoding: "utf8", input: JSON.stringify({ cwd, ...stdin }),
    env: { ...BASE_ENV, ...env }, timeout: 20000 })
const project = name => { const d = join(mkdtempSync(join(tmpdir(), "sac-portable-proj-")), name); mkdirSync(join(d, ".claude"), { recursive: true }); return d }

test("setup writes a launcher that names this machine's node and checkout — outside every project", () => {
  const r = sac(["setup"])
  assert.equal(r.status, 0, r.stderr)
  const launcher = join(HOME, ".local", "bin", "sac")
  const body = readFileSync(launcher, "utf8")
  assert.ok(body.includes(process.execPath), "the launcher leaves the interpreter to the PATH")
  assert.ok(statSync(launcher).mode & 0o100, "the launcher is not executable")
  assert.equal(JSON.parse(sac(["setup"]).stdout).state, "already current", "a re-run rewrote it")
})

test("setup does not replace somebody else's `sac`", () => {
  const other = mkdtempSync(join(tmpdir(), "sac-portable-other-"))
  mkdirSync(join(other, ".local", "bin"), { recursive: true })
  writeFileSync(join(other, ".local", "bin", "sac"), "#!/bin/sh\necho a different tool\n")
  const r = sac(["setup"], { env: { HOME: other } })
  assert.notEqual(r.status, 0, "it overwrote a file that was not its own")
  assert.match(r.stderr, /not this launcher/)
})

test("the portable SessionStart line, run as Claude Code runs it, checks the session in", () => {
  const dir = project("portable-a")
  const line = store.portableHook("session-start", { agent: "portable-a", rooms: ["team"] })
  const r = runLine(line, { cwd: dir, env: { CLAUDE_CODE_SESSION_ID: "aaaa0001-0000-4000-8000-000000000001",
                                             SET_AGENT_OWNER_PID: "991001" } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Checked in as `portable-a#aaaa0001`/, `the hook did not run: ${r.stdout}${r.stderr}`)
  const reg = JSON.parse(readFileSync(join(STORE, "registry.json"), "utf8"))
  assert.ok(reg.agents["portable-a"]?.seats?.["portable-a#aaaa0001"], "nothing reached the registry")
})

test("…with no `sac` on this machine it says so ONCE, into the session — the other three stay silent", () => {
  const dir = project("portable-b")
  const bare = { HOME: mkdtempSync(join(tmpdir(), "sac-portable-nohome-")) }
  const start = runLine(store.portableHook("session-start", { agent: "portable-b" }), { cwd: dir, env: bare })
  assert.equal(start.status, 0)
  const note = JSON.parse(start.stdout)
  assert.match(note.hookSpecificOutput.additionalContext, /OFF the bus/, "a machine without sac is silent")
  for (const name of ["stop", "heartbeat", "watch-guard"]) {
    const r = runLine(store.portableHook(name, { agent: "portable-b" }), { cwd: dir, env: bare })
    assert.equal(r.status, 0, `${name} fails a turn on a machine without sac`)
    assert.equal(r.stdout, "", `${name} prints on every call`)
  }
})

test("a PLUGIN's line stands down where the project wires the same hook — no double firing", () => {
  const dir = project("portable-c")
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: "command", command: store.portableHook("session-start", { agent: "portable-c" }) }] }] } }))
  const env = { CLAUDE_CODE_SESSION_ID: "cccc0001-0000-4000-8000-000000000001", SET_AGENT_OWNER_PID: "991002",
                CLAUDE_PROJECT_DIR: dir }
  const plugin = runLine(store.portableHook("session-start", { plugin: true }), { cwd: dir, env })
  assert.equal(plugin.status, 0, plugin.stderr)
  assert.equal(plugin.stdout, "", "the plugin's copy ran next to the project's own")

  // A hook with no room configured (the form a plugin ships) joins the project's relation rooms.
  const bare = project("portable-d")
  store.openProjectRoom("portable-d", "portable-a")
  const alone = runLine(store.portableHook("session-start", { plugin: true }), { cwd: bare,
    env: { ...env, CLAUDE_PROJECT_DIR: bare, CLAUDE_CODE_SESSION_ID: "dddd0001-0000-4000-8000-000000000001" } })
  assert.match(JSON.parse(alone.stdout || "{}").hookSpecificOutput?.additionalContext || "", /Checked in as `portable-d#dddd0001` in "dm-portable-a--portable-d"/,
    `where the project wires nothing, the plugin's hook did not run: ${alone.stdout}${alone.stderr}`)
})

test("`sac hook` with an unknown name says so and never fails the turn", () => {
  const r = sac(["hook", "nope"])
  assert.equal(r.status, 0)
  assert.match(r.stderr, /unknown hook 'nope'/)
})

test("uninstall takes out only the bus hooks, from both files, and the skill copy", () => {
  const dir = project("portable-e")
  const mine = { type: "command", command: store.portableHook("stop", { agent: "portable-e" }) }
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ env: { A: "1" }, hooks: {
    Stop: [{ hooks: [mine, { type: "command", command: "echo keep-me" }] }] } }))
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ hooks: {
    PostToolUse: [{ hooks: [{ type: "command", command: `${process.execPath} /x/set-agent-comm/hooks/heartbeat.mjs` }] }] } }))
  mkdirSync(join(dir, ".claude", "skills", "agent-comm"), { recursive: true })
  writeFileSync(join(dir, ".claude", "skills", "agent-comm", "SKILL.md"), "x")
  const r = sac(["uninstall"], { cwd: dir })
  assert.equal(r.status, 0, r.stderr)
  const tracked = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))
  assert.deepEqual(tracked.env, { A: "1" })
  assert.deepEqual(tracked.hooks.Stop[0].hooks.map(h => h.command), ["echo keep-me"], "it took someone else's hook")
  assert.equal(JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).hooks, undefined)
  assert.ok(!existsSync(join(dir, ".claude", "skills", "agent-comm")), "the skill copy stayed")
  assert.equal(store.hookWiring(dir).length, 0)
})

test("plugin-files writes the four lines and the skill, merged, with no machine path", () => {
  const plugin = mkdtempSync(join(tmpdir(), "sac-portable-plugin-"))
  mkdirSync(join(plugin, "hooks"))
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "the-plugins-own-guard" }] }] } }))
  const r = sac(["plugin-files", plugin])
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"))
  const all = Object.values(cfg.hooks).flat().flatMap(g => g.hooks).map(h => h.command)
  assert.ok(all.includes("the-plugins-own-guard"), "it dropped the plugin's own hook")
  for (const name of store.HOOK_NAMES)
    assert.ok(all.some(c => store.hookOf(c)?.hook === name && c.includes("--from-plugin")), `${name} is missing`)
  assert.equal(cfg.hooks.PreToolUse.find(g => all && g.hooks.some(h => store.hookOf(h.command)))?.matcher, "Monitor")
  const skill = readFileSync(join(plugin, "skills", "agent-comm", "SKILL.md"), "utf8")
  assert.doesNotMatch(skill, /\{\{/, "a placeholder was left in the shipped skill")
  for (const f of [join(plugin, "hooks", "hooks.json"), join(plugin, "skills", "agent-comm", "SKILL.md")]) {
    const t = readFileSync(f, "utf8")
    assert.ok(!t.includes(process.execPath) && !t.includes(CHECKOUT.replace(/\/$/, "")), `${f} carries a machine path`)
  }
  // Run twice, still one line per hook.
  sac(["plugin-files", plugin])
  const again = Object.values(JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks)
    .flat().flatMap(g => g.hooks).filter(h => store.hookOf(h.command))
  assert.equal(again.length, 4, "a re-run added a second copy")
})

test("doctor marks a project with no bus hook OFF, and one with them ok", () => {
  const on = project("doc-on"), off = project("doc-off")
  writeFileSync(join(on, ".claude", "settings.json"), JSON.stringify({ hooks: Object.fromEntries(
    [["SessionStart", "session-start"], ["Stop", "stop"], ["PostToolUse", "heartbeat"], ["PreToolUse", "watch-guard"]]
      .map(([e, n]) => [e, [{ hooks: [{ type: "command", command: store.portableHook(n, { agent: "doc-on" }) }] }]])) }))
  store.register({ agent: "doc-on", project: on, session: "eeee0001-0000-4000-8000-000000000001", room: "team", owner: 991010 })
  store.register({ agent: "doc-off", project: off, session: "ffff0001-0000-4000-8000-000000000001", room: "team", owner: 991011 })
  const r = sac(["doctor", "--project", "doc-*", "--json"])
  assert.equal(r.status, 0, r.stderr)
  const by = Object.fromEntries(JSON.parse(r.stdout).projects.map(p => [p.project, p]))
  assert.equal(by["doc-on"].verdict, "ok", JSON.stringify(by["doc-on"].problems))
  assert.equal(by["doc-off"].verdict, "off")
  assert.match(by["doc-off"].problems.join(" "), /OFF the bus/)
})

test("doctor sees a hook a PLUGIN brings, from Claude Code's own install record", () => {
  const dir = project("doc-plugin")
  const plugin = mkdtempSync(join(tmpdir(), "sac-portable-plugin2-"))
  sac(["plugin-files", plugin])
  mkdirSync(join(CONFIG, "plugins"), { recursive: true })
  writeFileSync(join(CONFIG, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "family-kit@family": [{ scope: "local", projectPath: dir, installPath: plugin, version: "1.0.0" }] } }))
  store.register({ agent: "doc-plugin", project: dir, session: "abab0001-0000-4000-8000-000000000001", room: "team", owner: 991012 })
  const p = JSON.parse(sac(["doctor", "--project", "doc-plugin", "--json"]).stdout).projects[0]
  assert.equal(p.verdict, "ok", JSON.stringify(p.problems))
  assert.match(p.hooks.stop.join(), /plugin family-kit@1\.0\.0/)
  void readdirSync
})
