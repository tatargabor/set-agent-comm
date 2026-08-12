// WHEN THE CLI FAILS, IT HAS TO BE AUDIBLE.
//
// Both cases here were measured on 2026-08-10, minutes apart, in one probe that was TRYING to be
// careful — and the store still carries the wreckage:
//
//   1. The agent exported `SET_AGENT_COMM_HOME` to isolate its test. No such variable exists.
//      Nothing said so, and the probe ran against the live bus.
//   2. It then ran `sac send --help FACT "proba"`. `--help` was taken as the room name, and
//      join-on-write created a room called `--help` — which is still there.
//
// Neither failure printed a word. That is the class of bug this file exists to keep out: a
// defensive measure that evaporates in silence is worse than not having taken it, because the
// person believes they are protected.
//
// The CLI is spawned as a real process, the way a hook and a person both run it — asserting on
// the result rather than on the call.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = new URL("../bin/sac.mjs", import.meta.url).pathname

/**
 * Run the CLI, returning stdout, stderr and the exit code.
 *
 * ⚠ `spawnSync`, not `execFileSync`: the latter only hands back stderr on a NON-ZERO exit, and
 * the whole point here is a warning printed by a command that succeeds. Caught while writing
 * this file — the first version reported "no warning" for a warning that was being printed.
 */
function sac(args, env = {}) {
  const root = env.SET_AGENT_COMM_DIR || mkdtempSync(join(tmpdir(), "sac-cli-"))
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, SET_AGENT_COMM_DIR: root, ...env },
    encoding: "utf8",
  })
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 1, root }
}

test("REGRESSION: `sac send --help` prints usage and writes NOTHING — the `--help` room", () => {
  const root = mkdtempSync(join(tmpdir(), "sac-cli-"))
  const r = sac(["send", "--help", "FACT", "proba"], { SET_AGENT_COMM_DIR: root })
  assert.match(r.stdout + r.stderr, /usage: sac send/)
  assert.ok(!existsSync(join(root, "channels")),
    "a help flag must not create a room — this is exactly how `--help` got into the live store")
})

test("REGRESSION: the help names the commands that put THIS SEAT in a room", () => {
  // Reported from `consumer-a` 2026-08-12. A session wanted to join one room BY ITSELF. `sac join
  // <room>` does exactly that and has had a usage line all along — but the help's local section
  // did not list it, so the only two visible paths were `sac install` and hand-editing
  // `settings.json`, and both are project-wide. The second one was taken, and two live sibling
  // sessions joined the room through their own hooks within a minute.
  const r = sac([])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /sac join <room>/, "the per-seat way into a room is not in the help")
  assert.match(r.stdout, /sac part <room>/, "…nor the way out")
  // …and the project-wide one must say that it is project-wide, next to it.
  assert.match(r.stdout, /sac install[\s\S]{0,120}PROJECT/,
    "`install` does not say that it sets the default for every session of the project")
})

test("`--help` works on every subcommand that has a usage line", () => {
  for (const cmd of ["send", "inbox", "peek", "history", "install", "wait", "agents", "rooms", "focus", "join", "part"]) {
    const r = sac([cmd, "--help"])
    assert.match(r.stdout, new RegExp(`usage: sac ${cmd}`), `sac ${cmd} --help`)
    assert.equal(r.code, 0, `sac ${cmd} --help must exit 0`)
  }
})

test("REGRESSION: `sac rooms` does not show a project's whole roster as being in a room", () => {
  // Reported from `consumer-a` 2026-08-12: fourteen seats listed under a room that held exactly one
  // — `sac rooms` printed `participants`, which walks the AGENT-level room list `sac register`
  // writes. "Addressable" and "in the room, wakes" are two concepts, and printing them as one
  // list erred towards the reassuring answer: a room with one person in it looked crowded.
  const root = mkdtempSync(join(tmpdir(), "sac-cli-"))
  const reg = (session, room, owner) => sac(["register", room], {
    SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "proj",
    CLAUDE_CODE_SESSION_ID: session, SET_AGENT_OWNER_PID: String(owner),
  })
  // Two sessions of ONE project, in two DIFFERENT rooms. The first window is alive (this test
  // process stands in for it), the second is long gone.
  reg("aaaa1111-0000-0000-0000-000000000000", "egyik", process.pid)
  reg("bbbb2222-0000-0000-0000-000000000000", "masik", 999999)

  const out = sac(["rooms"], { SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "nezo" }).stdout
  const egyik = out.slice(out.indexOf("egyik "), out.indexOf("masik "))
  assert.match(egyik, /proj#aaaa1111/, "the seat that IS in the room is missing")
  assert.doesNotMatch(egyik, /proj#bbbb2222/,
    "a sibling seat that is in another room is reported as being in this one")
  assert.match(egyik, /also addressable: proj/,
    "…and the project, which can still be written to, is not named at all")
})

test("a flag in the room position is a usage error, never a room name", () => {
  const root = mkdtempSync(join(tmpdir(), "sac-cli-"))
  const r = sac(["send", "--to", "somebody", "FACT", "szöveg"], { SET_AGENT_COMM_DIR: root })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /is a flag, not a room name/)
  assert.ok(!existsSync(join(root, "channels")), "nothing may be written")
})

test("the commands that legitimately lead with a flag still do", () => {
  // `wait --once`, `prune --days` and `relay use` are not room-first, and must be unaffected.
  assert.equal(sac(["prune", "--days", "30", "--dry-run"]).code, 0)
  const w = sac(["wait", "--once"])
  assert.ok(!/is a flag, not a room name/.test(w.stderr), "`wait --once` must still parse")
})

test("REGRESSION: an unrecognised SET_AGENT_COMM_* variable is named, with the store actually in use", () => {
  const root = mkdtempSync(join(tmpdir(), "sac-cli-"))
  const r = sac(["agents"], { SET_AGENT_COMM_DIR: root, SET_AGENT_COMM_HOME: "/tmp/nem-letezik" })
  assert.match(r.stderr, /SET_AGENT_COMM_HOME/, "the misspelt variable is named")
  assert.match(r.stderr, /SET_AGENT_COMM_DIR/, "…and so is the one that was meant")
  assert.ok(r.stderr.includes(root), "…and the store the command actually used")
  assert.equal(r.code, 0, "it warns, it does not fail the command")
})

test("the warning goes to stderr, so stdout stays parseable", () => {
  const r = sac(["rooms"], { SET_AGENT_COMM_HOME: "/tmp/x" })
  assert.ok(!r.stdout.includes("warning"), "stdout must carry no warning")
  assert.match(r.stderr, /warning/)
})

test("a recognised environment is silent", () => {
  const r = sac(["agents"])
  assert.equal(r.stderr, "", `unexpected warning: ${r.stderr}`)
})
