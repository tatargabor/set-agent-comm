// THE SILENT JOIN — what a `claude -p` run costs to put on the bus.
//
// Why its own file: the failure this answers is not a lost message, it is a participant that
// left. Measured 2026-08-08, the heaviest one on the bus instructs its machines to skip
// agent-comm entirely — 237 of `consumer-b`'s 239 seats are timer-driven — because joining cost
// a reported 31 seconds. The mechanical floor is 370 ms, so the seconds are the CEREMONY: a hook
// that tells a model to arm a `Monitor` and declare a `focus`, both of which a run that does one
// task and exits can do nothing with.
//
// So these tests are about a boundary, and they are written from both sides of it: a headless run
// must still be ADDRESSABLE (or "join cheaply" quietly becomes "do not join"), and an interactive
// session must be untouched (the silent path leaking into a real window would take its watch away,
// which is the one failure this project exists to prevent).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), "sac-headless-"))
const SAC = join(HERE, "..", "bin", "sac.mjs")
const START = join(HERE, "..", "hooks", "session-start.mjs")
const STOP = join(HERE, "..", "hooks", "stop.mjs")
const WINDOW = { machine: 900011, human: 900012, other: 900013 }
const env = (session, extra = {}) => ({
  ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_ROOM: "team",
  SET_AGENT_NAME: "web-app", CLAUDE_CODE_SESSION_ID: session,
  SET_AGENT_OWNER_PID: String(WINDOW[session] ?? 0), ...extra,
})
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

const hook = (bin, session, extra = {}) => JSON.parse(spawnSync(process.execPath, [bin], {
  env: env(session, extra), encoding: "utf8",
  input: JSON.stringify({ cwd: "/x", session_id: session }),
}).stdout || "{}")
const sac = (session, ...args) => spawnSync(process.execPath, [SAC, ...args],
  { env: env(session), encoding: "utf8" })

// `SET_AGENT_COMM_DIR` is read at module load, so the store is imported after it is set.
process.env.SET_AGENT_COMM_DIR = ROOT
process.env.SET_AGENT_OWNER_PID = "0"
const store = await import("../src/store.mjs")

// ── the detection itself, against real processes ──────────────────────────────
// ⚠ Not against the `SET_AGENT_HEADLESS` override: the override is the test's convenience, and a
// suite that only ever exercised it would pass with the `/proc` parse completely broken.

test("a process with no controlling terminal reads as headless", () => {
  // pid 1 — systemd or launchd. Every machine this can run on has one, and none of them has a
  // terminal, which makes it the one unforgeable data point available in a unit test.
  assert.equal(store.headless(1), true,
    "field 7 of /proc/1/stat is not being read as tty_nr — the parse is off by a field")
})

test("an owner that cannot be identified falls back to the CEREMONY, never to silence", () => {
  // The direction is the whole design. Being wrong toward the ceremony costs a few turns; being
  // wrong toward silence leaves a real session with no watch armed, and that is the failure this
  // project exists to prevent. So every unknown answers "not headless".
  assert.equal(store.headless(null), false, "no owner was read as headless")
  assert.equal(store.headless(2 ** 30), false, "an unreadable /proc entry was read as headless")
})

test("print mode is caught even when there IS a terminal — a hand-run `claude -p`", (t) => {
  // The terminal test is a proxy; print mode is the property that actually matters, and a person
  // typing `claude -p …` by hand has a tty and still has no prompt to come back to.
  const sleeper = join(ROOT, "sleep.mjs")
  writeFileSync(sleeper, "setTimeout(() => {}, 10000)")
  const plain = spawn(process.execPath, [sleeper, "hello"], { stdio: "ignore" })
  const printy = spawn(process.execPath, [sleeper, "-p", "hello"], { stdio: "ignore" })
  // ⚠ A prompt that CONTAINS "-p" is one argv element, not a flag. On Linux the NUL separators in
  // /proc/cmdline keep that distinction exact; this asserts it, because losing it would silence a
  // real session whose prompt happened to mention the string.
  const quoted = spawn(process.execPath, [sleeper, "fix the -p flag"], { stdio: "ignore" })
  t.after(() => { for (const p of [plain, printy, quoted]) p.kill() })
  try {
    // ⚠ A test runner started from a hook, a CI job or an agent's shell usually has no terminal
    // of its own, and then the tty test answers before the argv test ever runs. Skipping is
    // honest, but it is not coverage — to actually exercise this branch, give the runner a pty:
    //   script -qec "node --test test/headless.test.mjs" /dev/null
    // Measured 2026-08-08: skipped without it, 10/10 with it.
    if (store.headless(plain.pid))
      return t.skip("this runner has no controlling terminal, so the tty test answers first")
    assert.equal(store.headless(printy.pid), true, "a standalone -p was not recognised as print mode")
    assert.equal(store.headless(quoted.pid), false,
      "'-p' inside a prompt was read as the flag — argv boundaries are being lost")
  } finally { for (const p of [plain, printy, quoted]) p.kill() }
})

// ── SessionStart: checked in, and nothing else ────────────────────────────────

test("a headless run IS checked in — cheap to join is not the same as absent", () => {
  hook(START, "machine", { SET_AGENT_HEADLESS: "1" })
  assert.ok(store.liveSeats("team").includes("web-app#machine"),
    "the machine is not in the room — nobody can address it, which is what skipping the bus already did")
  assert.ok(existsSync(store.busFile("team", "web-app#machine")),
    "it has no file to be written to")
})

test("…and it is told its seat name, because a name is what it needs to sign a report", () => {
  const out = hook(START, "machine", { SET_AGENT_HEADLESS: "1" })
  assert.match(out.hookSpecificOutput.additionalContext, /web-app#machine/,
    "it was checked in under a name it was never told")
})

test("the one command it is offered does not rely on PATH", () => {
  // The project's rule, and it applies to a line printed into a context just as much as to one
  // written into a settings file: `sac` is not on the PATH of a non-interactive shell, and an
  // agent guessing at a command is an agent that silently does nothing.
  const ctx = hook(START, "machine", { SET_AGENT_HEADLESS: "1" }).hookSpecificOutput.additionalContext
  assert.match(ctx, /\/\S*node\S*\s+\S+sac\.mjs send team/, `the send command relies on PATH: ${ctx}`)
  assert.match(ctx, new RegExp(`SET_AGENT_COMM_DIR=${ROOT}`),
    "a non-default store root was not passed on — the command would write into the real bus")
})

test("a headless run is given NO imperative and NO watching", () => {
  const out = hook(START, "machine", { SET_AGENT_HEADLESS: "1" })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.doesNotMatch(ctx, /Monitor\(/, "it was told to arm a watch that can never wake it")
  assert.doesNotMatch(ctx, /ARM YOUR INBOX/, "the imperative survived")
  assert.doesNotMatch(ctx, /say so once with/, "it was told to declare a focus nobody will read")
  assert.equal(out.hookSpecificOutput.watchPaths, undefined,
    "it registered file watches for a process that exits after one task")
})

test("REGRESSION: an interactive session still gets all of it", () => {
  // The dangerous direction. If the silent path ever leaks into a real window, the symptom is a
  // session that looks fine and is simply never woken again.
  const out = hook(START, "human", { SET_AGENT_HEADLESS: "0" })
  const ctx = out.hookSpecificOutput.additionalContext
  assert.match(ctx, /Monitor\(/, "an interactive session was left without its watch command")
  assert.match(ctx, /focus/, "the focus request is gone")
  assert.ok(out.hookSpecificOutput.watchPaths?.length, "an interactive session is watching nothing")
})

test("REGRESSION: the watch it arms points at THIS store, not the default one", () => {
  // ⚠ Measured 2026-08-08, in a throwaway project with its own store. The session obeyed the
  // "arm your inbox watch" line, and the watch read the DEFAULT store — it created an empty room
  // directory there and sat watching it. Nothing errored. A watch pointed at the wrong store is
  // indistinguishable from a working one right up until a message does not arrive, which is the
  // whole failure this hook was written to remove.
  const ctx = hook(START, "human", { SET_AGENT_HEADLESS: "0" }).hookSpecificOutput.additionalContext
  const cmd = ctx.match(/Monitor\(\{ command: "([^"]+)"/)?.[1]
  assert.ok(cmd, `no watch command to check: ${ctx}`)
  assert.match(cmd, new RegExp(`SET_AGENT_COMM_DIR=${ROOT}\\b`),
    `the armed watch would read the default store: ${cmd}`)
})

// ── Stop: a machine is never sent back to work ────────────────────────────────

test("a headless run is NOT blocked by mail it could not act on", () => {
  hook(START, "other", { SET_AGENT_HEADLESS: "0" })
  sac("other", "send", "team", "REQUEST", "Do not regenerate the atlas yet.")
  assert.deepEqual(hook(STOP, "machine", { SET_AGENT_HEADLESS: "1" }), {},
    "the machine was sent back to triage somebody else's message — up to 24 blocked turns an hour")
})

test("…and it did not SPEND the nudge: the interactive reader still gets blocked", () => {
  // The subtle one, and the reason the Stop hook returns before `shouldNudge` rather than after.
  // A nudge is spent on disk and fires ONCE per entry. A headless run that consumed it would
  // silently rob the session that can actually answer of the only notice it will ever get —
  // delivery would still be perfect and the message would still go unanswered, which is exactly
  // the 2026-08-04 failure this bus was built for.
  const out = hook(STOP, "human", { SET_AGENT_HEADLESS: "0" })
  assert.equal(out.decision, "block", "the headless run ate the nudge on the human's behalf")
  assert.match(out.reason, /regenerate/, "it blocked without saying what arrived")
})

test("a nudge is still not a delivery — the message stays unread for the headless run too", () => {
  assert.match(sac("machine", "peek", "team").stdout, /regenerate/,
    "passing through the Stop hook silently marked it read")
})
