// The NOTIFICATION path, measured with real processes: the Stop hook and `sac wait`.
//
// Why its own test file: delivery (store.test.mjs) and being told about it are two different
// things, and on 2026-08-04 exactly the second one failed. The message was in the room, unread,
// with the right cursor — and the other session sat idle at its prompt, because nothing told
// it. These tests therefore run the hook and the CLI as separate processes, the way Claude Code
// runs them, rather than calling the functions behind them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), "sac-nudge-"))
const SAC = join(HERE, "..", "bin", "sac.mjs")
const STOP = join(HERE, "..", "hooks", "stop.mjs")
const env = session => ({
  ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_ROOM: "team",
  SET_AGENT_NAME: "web-app", CLAUDE_CODE_SESSION_ID: session,
})
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }))

const sac = (session, ...args) => spawnSync(process.execPath, [SAC, ...args], { env: env(session), encoding: "utf8" })
const stopHook = session => JSON.parse(spawnSync(process.execPath, [STOP], {
  env: env(session), encoding: "utf8", input: JSON.stringify({ cwd: "/x", session_id: session }),
}).stdout || "{}")

// Two sessions of one project — the seat name carries the session id, so they are
// `web-app#one` and `web-app#two`.
const SEAT = "web-app#two"
sac("one", "register", "team")
sac("two", "register", "team")

test("the Stop hook lets a turn end when there is nothing unread", () => {
  assert.deepEqual(stopHook("two"), {})
})

test("the Stop hook BLOCKS the end of the turn when a message arrived", () => {
  sac("one", "send", "team", "REQUEST", "Do not regenerate the atlas yet.")
  const out = stopHook("two")
  assert.equal(out.decision, "block", "the agent was allowed to finish with unread mail")
  assert.match(out.reason, /team/, "the reason does not name the room to read")
  assert.match(out.reason, /regenerate/, "the reason does not show what arrived")
})

test("it nudges ONCE per entry — Claude Code has no stop_hook_active to break the loop", () => {
  assert.deepEqual(stopHook("two"), {},
    "it blocked for the same message a second time — an agent that does not read it would be trapped")
})

test("a nudge is NOT a delivery: the message stays unread", () => {
  // The worst possible outcome would be a hook that marks it read on the agent's behalf: it
  // would be nudged about something it can then never see.
  assert.match(sac("two", "peek", "team").stdout, /regenerate/,
    "the nudge swallowed the message")
})

test("`sac wait` reports what is ALREADY waiting, then exits with --once", async () => {
  // This is what a Claude Code Monitor runs — the only thing that starts a new turn in an idle
  // session. Measured: `watchPaths`/`FileChanged` fire while idle but cannot wake the session.
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SAC, "wait", "--once", "team"], { env: env("two"), encoding: "utf8" })
    let text = ""
    p.stdout.on("data", d => { text += d })
    p.on("error", reject)
    p.on("exit", code => resolve({ code, text }))
    setTimeout(() => { p.kill(); reject(new Error("`sac wait` did not exit — it hung")) }, 10_000)
  })
  assert.equal(out.code, 0)
  assert.match(out.text, /unread in "team"/)
  assert.match(out.text, /inbox/, "the event does not say what to do about it")
})

test("`sac wait` emits an event for a message that arrives WHILE it is running", async () => {
  const p = spawn(process.execPath, [SAC, "wait", "team"], { env: env("two") })
  try {
    let text = ""
    p.stdout.on("data", d => { text += d })
    // The first line is the message already waiting; then a new one arrives.
    await new Promise(r => setTimeout(r, 700))
    sac("one", "send", "team", "FACT", "The invoice draft is ready.")
    await new Promise(r => setTimeout(r, 1500))
    assert.match(text, /invoice draft|2 unread/,
      "a message written while the monitor was running produced no event")
  } finally { p.kill() }
})

test("the cursor did not move through any of it — `wait` only looks", () => {
  const cursors = JSON.parse(readFileSync(join(ROOT, "cursors.json"), "utf8"))
  assert.equal(cursors[`team::${SEAT}`]?.["web-app#one"], undefined,
    "watching advanced the read cursor, so the message would be lost")
})
