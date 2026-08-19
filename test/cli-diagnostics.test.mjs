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
import { mkdtempSync, existsSync, readdirSync, chmodSync, watch } from "node:fs"
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

// ── the room a seat name implies ─────────────────────────────────────────────
//
// ⚠ Measured 2026-08-19: `set-core` was handed a seat name and told to write to it. Nothing
// answered "which room is that seat in", so the session went hunting through rooms — the one
// question the person had already answered by naming the seat. Both halves are asserted through
// the CLI here because the rule lives in the core (`store.resolveRoom`) and the MCP face reads
// the same one; they may not drift.
const twoAgents = () => {
  const root = mkdtempSync(join(tmpdir(), "sac-route-"))
  const alpha = { SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "alpha", SET_AGENT_ROOM: "team,design",
                  CLAUDE_CODE_SESSION_ID: "aaaa1111-0000-4000-8000-000000000001", SET_AGENT_OWNER_PID: "987001" }
  const beta = { SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "beta", SET_AGENT_ROOM: "team",
                 CLAUDE_CODE_SESSION_ID: "bbbb2222-0000-4000-8000-000000000002", SET_AGENT_OWNER_PID: "987002" }
  const attic = { SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "archivist", SET_AGENT_ROOM: "attic",
                  CLAUDE_CODE_SESSION_ID: "cccc3333-0000-4000-8000-000000000003", SET_AGENT_OWNER_PID: "987003" }
  for (const [env, rooms] of [[alpha, ["team", "design"]], [beta, ["team"]], [attic, ["attic"]]])
    for (const r of rooms) sac(["register", r], env)
  return { root, alpha, beta, attic }
}

test("a seat name is a complete address — the room follows from it, and is REPORTED", () => {
  const { alpha } = twoAgents()
  // Only an ADDRESSED entry may leave the room out: a broadcast has no addressee to derive an
  // audience from, so the room stays required and the usage line says so.
  const r = sac(["send", "FACT", "the invoice rounds the gross too"], alpha)
  assert.notEqual(r.code, 0, "an unaddressed send picked a room on its own")
  assert.match(r.stderr, /usage: sac send \[<room>\]/)

  const addressed = sac(["send", "FACT", "the invoice rounds the gross too", "--to", "beta#bbbb2222"], alpha)
  assert.equal(addressed.code, 0, addressed.stderr)
  assert.equal(JSON.parse(addressed.stdout).room, "team", "it did not land where the addressee is")
  // Which room it went into decides who may READ it, so it may not be a silent choice.
  assert.match(addressed.stderr, /only reachable in 'team'/)
})

test("…and an addressee in NONE of my rooms is refused with the room it IS in", () => {
  const { alpha } = twoAgents()
  const r = sac(["send", "REQUEST", "are you there?", "--to", "archivist#cccc3333"], alpha)
  assert.notEqual(r.code, 0, "it wrote into a room the addressee cannot read")
  assert.match(r.stderr, /is in no room you are in/)
  assert.match(r.stderr, /attic/, "the refusal did not say where that seat actually is")
})

test("a room named in the room position still wins over the addressee's", () => {
  const { alpha } = twoAgents()
  const r = sac(["send", "design", "FACT", "explicit beats implied"], alpha)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).room, "design")
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

/**
 * ⚠ A WATCH THAT COULD NOT BE ARMED IS THE QUIETEST FAILURE THIS CLI HAS. `sac wait` falls back
 * to a 5-second poll when `fs.watch` throws, and for a long time said nothing at all — the empty
 * `catch` even carried a comment explaining why it was fine ("the poll below covers it"). It IS
 * covered; that is exactly why nobody found out that the wake-up had gone from ~100 ms to 5 s.
 *
 * Measured 2026-08-17: this machine sat at 126 of 128 `fs.inotify.max_user_instances`, so every
 * NEWLY armed watch threw EMFILE while the older ones kept working — the session somebody had
 * just opened was the one that degraded. 50 live `sac wait` processes, 20 holding an instance.
 *
 * The test forces a REAL failure rather than a simulated one, by taking read permission off the
 * channel directory. Which error arrives depends on the machine — EACCES where inotify has room,
 * EMFILE where it does not — so the assertion is on the sentence, not on the code.
 */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0

/**
 * `sac wait` BLOCKS — that is its whole job, and `--once` only exits when an event arrives. The
 * warning under test is printed while the watch is being armed, long before any of that, so this
 * kills the process after a moment and reads what it had already said. (The first version of
 * this test used the plain helper and hung the suite.)
 */
const waitBriefly = (args, env) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 2500, killSignal: "SIGKILL",
  })
  return { stdout: r.stdout || "", stderr: r.stderr || "" }
}

test("REGRESSION: a watch that could not be armed says so — on stderr, once", { skip: asRoot && "root ignores the permission bits this test relies on" }, () => {
  const root = mkdtempSync(join(tmpdir(), "sac-cli-"))
  const env = { SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "watcher" }
  assert.equal(sac(["register", "zart"], env).code, 0)
  chmodSync(join(root, "channels", "zart"), 0o000)
  try {
    const r = waitBriefly(["wait", "zart"], env)
    assert.match(r.stderr, /could not arm the file watcher/,
      "the watch fell back to the 5s poll and nothing said so — the failure this test exists for")
    assert.match(r.stderr, /zart/, "the room whose watch failed is named")
    assert.match(r.stderr, /5s poll/, "…and what it costs, which is the part a reader can act on")
    // ⚠ STDOUT IS THE EVENT STREAM. A Claude Code Monitor turns every line of it into a
    // notification, so a warning printed there would spend a whole turn of the agent's context
    // reporting something only an operator can do anything about.
    assert.ok(!/could not arm/.test(r.stdout), "the warning reached the event stream")
    // Once for all the rooms, not once per room.
    assert.equal((r.stderr.match(/could not arm the file watcher/g) || []).length, 1)
  } finally { chmodSync(join(root, "channels", "zart"), 0o755) }
})

/**
 * ⚠ THE HEALTHY-PATH TEST NEEDS A HEALTHY MACHINE, and on a saturated one it cannot get it: with
 * every `fs.inotify.max_user_instances` in use, there is no such thing as a watch that WAS armed.
 * Probed for real rather than assumed — and the skip REASON names the condition, because a
 * developer whose machine is in that state wants to be told, not to see a green suite. This is
 * how the case first appeared: the test failed on the author's machine, correctly.
 */
const canWatch = (() => {
  try {
    const w = watch(mkdtempSync(join(tmpdir(), "sac-probe-")), () => {})
    w.close()
    return true
  } catch { return false }
})()

test("…and a watch that WAS armed stays silent about it", {
  skip: asRoot ? "see above"
    : !canWatch && "this machine has no free inotify instances — see `max_user_instances`",
}, () => {
  // The other half: a warning that also fires on the healthy path is one people learn to ignore.
  const root = mkdtempSync(join(tmpdir(), "sac-cli-"))
  const env = { SET_AGENT_COMM_DIR: root, SET_AGENT_NAME: "watcher" }
  sac(["register", "nyitott"], env)
  const r = waitBriefly(["wait", "nyitott"], env)
  assert.ok(!/could not arm/.test(r.stderr), `warned about a healthy watch: ${r.stderr}`)
})

// ── `sac dm` — a room of two, named so both sides derive the same one ─────────
//
// Decided 2026-08-19 (see `store.dmRoom`): a DM is a room whose membership is two, not a new
// object below the room. What was missing was never the mechanism, it was the ergonomics — three
// commands and a name both sides had to agree on out of band, which nobody did.
test("`sac dm` opens a room of exactly two, and both sides derive the SAME name", () => {
  const { alpha, beta } = twoAgents()
  const mine = sac(["dm", "beta#bbbb2222"], alpha)
  assert.equal(mine.code, 0, mine.stderr)
  const { room, invited } = JSON.parse(mine.stdout)
  assert.equal(room, "dm-alpha-aaaa1111-beta-bbbb2222")
  assert.equal(invited, true, "the peer was not put in the room, so it would never be woken there")

  // The other side computes the name from the same two seats, so it finds the room rather than
  // opening a second one. That is the entire reason the name is derived and not chosen.
  const theirs = JSON.parse(sac(["dm", "alpha#aaaa1111"], beta).stdout)
  assert.equal(theirs.room, room)
  assert.equal(theirs.created, false, "the second side opened a SECOND room for the same pair")

  // …and it really is a room of two: the addressee check is what proves membership is visible.
  const sent = sac(["send", room, "QUESTION", "just us?", "--to", "beta#bbbb2222"], alpha)
  assert.equal(sent.code, 0, sent.stderr)
  assert.deepEqual(JSON.parse(sent.stdout).wakes, ["beta#bbbb2222"])
})

test("…and with the DM open, an unrouted addressed send ASKS instead of picking the loud room", () => {
  const { alpha } = twoAgents()
  const { room } = JSON.parse(sac(["dm", "beta#bbbb2222"], alpha).stdout)
  const r = sac(["send", "FACT", "which audience?", "--to", "beta#bbbb2222"], alpha)
  assert.notEqual(r.code, 0, "it chose an audience on the sender's behalf")
  assert.match(r.stderr, /cannot be guessed for you/)
  assert.match(r.stderr, new RegExp(room), "the refusal does not even name the room of two")
})

test("a DM needs somebody you can already reach — and a seat, not a project", () => {
  const { alpha } = twoAgents()
  const stranger = sac(["dm", "nobody#deadbeef"], alpha)
  assert.notEqual(stranger.code, 0)
  assert.match(stranger.stderr, /is in no room this store knows/)

  const whole = sac(["dm", "beta"], alpha)
  assert.notEqual(whole.code, 0, "a project name opened a 'room of two' with every session of it")
  assert.match(whole.stderr, /is a PROJECT/)
  assert.match(whole.stderr, /beta#bbbb2222/, "it does not say which session could have been meant")
})

test("a seat that LEFT the pair room is not put back by the other side", () => {
  const { alpha, beta } = twoAgents()
  const { room } = JSON.parse(sac(["dm", "beta#bbbb2222"], alpha).stdout)
  assert.equal(sac(["part", room], beta).code, 0)
  const again = JSON.parse(sac(["dm", "beta#bbbb2222"], alpha).stdout)
  assert.equal(again.invited, false, "`part` was undone by the other side calling `dm` again")
  assert.match(again.note, /has LEFT this room/)
})

test("`--re` is parsed, not swallowed into the message — it was in the usage line all along", () => {
  const { alpha, beta } = twoAgents()
  const first = JSON.parse(sac(["send", "team", "QUESTION", "ready?", "--to", "beta#bbbb2222"], alpha).stdout)
  const answer = sac(["send", "team", "ANSWER", "yes", "--to", "alpha#aaaa1111", "--re", first.ts], beta)
  assert.equal(answer.code, 0, answer.stderr)
  const out = JSON.parse(answer.stdout)
  assert.equal(out.re, first.ts, "the reference was dropped")
  // The failure this replaced: the flag and its value ended up INSIDE the text, and the entry
  // referred to nothing — so the asker was never woken by the `re:` rule.
  const back = sac(["history", "team", "5"], alpha).stdout
  assert.doesNotMatch(back, /--re/, "the flag was written into the message body")
})

// ── a pair room is the one place reading is restricted ───────────────────────
//
// ⚠ Asked for by set-core on 2026-08-19, with a reason no convenience argument would have
// carried: their agents run inside CLIENT projects, where content may not leak anywhere else.
// Measured before this existed: a third seat ran `sac history <pair room>` and read the entry in
// full — membership bounded waking and listing, never reading. And the other half of the same
// requirement: "a 1:1 with a subscription rule is not a 1:1".
const threeAgents = () => {
  const t = twoAgents()
  const gamma = { SET_AGENT_COMM_DIR: t.root, SET_AGENT_NAME: "gamma", SET_AGENT_ROOM: "team",
                  CLAUDE_CODE_SESSION_ID: "dddd4444-0000-4000-8000-000000000004", SET_AGENT_OWNER_PID: "987004" }
  sac(["register", "team"], gamma)
  return { ...t, gamma }
}

test("in a pair room every entry wakes the other side — no addressing, no type to pick", () => {
  const { alpha } = threeAgents()
  const { room } = JSON.parse(sac(["dm", "beta#bbbb2222"], alpha).stdout)
  // A broadcast FACT: the one shape that wakes nobody anywhere else on this bus.
  const out = JSON.parse(sac(["send", room, "FACT", "no addressee, no urgency"], alpha).stdout)
  assert.deepEqual(out.wakes, ["beta#bbbb2222"], "a channel of two behaved like a room")
  assert.ok(!out.notice?.some(n => /wakes NOBODY/.test(n)))
})

test("…and a third seat cannot read it, through either door", () => {
  const { alpha, beta, gamma } = threeAgents()
  const { room } = JSON.parse(sac(["dm", "beta#bbbb2222"], alpha).stdout)
  sac(["send", room, "FACT", "client contract clause 4.2"], alpha)

  for (const cmd of [["history", room], ["inbox", room], ["peek", room]]) {
    const r = sac(cmd, gamma)
    assert.notEqual(r.code, 0, `\`sac ${cmd[0]}\` handed a pair room to a third seat`)
    assert.match(r.stderr, /is a channel between two seats/)
    assert.doesNotMatch(r.stdout + r.stderr, /clause 4\.2/, "the refusal leaked the entry itself")
  }
  // …while the two who are in it read it normally.
  assert.match(sac(["history", room], beta).stdout, /clause 4\.2/)

  // The NAME is metadata — it says who talks to whom — so it is not listed to anyone else either.
  assert.doesNotMatch(sac(["rooms"], gamma).stdout, new RegExp(room))
  assert.match(sac(["rooms"], alpha).stdout, new RegExp(room))
})

test("an ordinary room is NOT restricted — the exception is the pair, not the rule", () => {
  const { alpha, gamma } = threeAgents()
  sac(["send", "team", "FACT", "everyone may read this"], alpha)
  const r = sac(["history", "team"], gamma)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /everyone may read this/)
})
