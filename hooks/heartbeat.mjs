#!/usr/bin/env node
/**
 * PostToolUse hook — the sign of life, fed by the MACHINE rather than by the model.
 *
 * WHY THIS EXISTS — measured 2026-08-09. `consumer-a#f93ef295` had `lastSeen: 11:05` at 12:31,
 * so for 86 minutes it looked silent on every listing while it was working the whole time.
 * Nothing was broken: the registry's liveness field is real, and `register` (which refreshes
 * it) only ever ran at session start. The signal existed; nobody fed it.
 *
 * That misreading is not cosmetic. `seatState` is three-state — `true` / `null` ("we do not
 * know") / `false` — and from the outside `null` and `false` both look like "not true", so a
 * seat that is mid-task gets treated as gone: work is handed to someone else, or a message is
 * addressed to a different session on the grounds that this one "went quiet". The first
 * message in this very exchange was mis-addressed for exactly that reason, and the sender said
 * so: they picked the seat by `focus`, because `live` was not usable.
 *
 * WHY A HOOK AND NOT THE AGENT: an agent-sent heartbeat costs a whole turn — tokens, and a
 * context interrupted to say nothing. This costs a process. It is the same lesson the chat→wall
 * mirror learned twice over in set-copilot: a prompt-level mandate to do something regularly is
 * a mandate that will be forgotten under load, and the fix is a mechanism, not a reminder.
 *
 * ⚠ IT RATE-LIMITS, and that is about CORRECTNESS, not speed. `register` rewrites the whole
 * shared registry (32 KB here); a PostToolUse hook fires on EVERY tool call, and several
 * sessions doing that concurrently is a lost-update race on the one file every seat depends on.
 * Once a minute per seat is far finer than the TTL that decides liveness, and leaves the file
 * essentially untouched. (Measured: a full `register` is 29 ms, of which node's own start-up is
 * 17 ms — so the skipped runs cost the start-up and nothing else.)
 *
 * IT NEVER BLOCKS AND NEVER SPEAKS. Exit 0 whatever happens: a liveness ping that can fail a
 * tool call would be worse than the silence it fixes, and anything it printed would land in the
 * session's transcript on every single tool use.
 */
import { basename, join } from "node:path"
import { mkdirSync, statSync, utimesSync, closeSync, openSync } from "node:fs"

const BEAT_INTERVAL_MS = 60_000

try {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const agent = process.env.SET_AGENT_NAME || basename(cwd)
  const session = process.env.CLAUDE_CODE_SESSION_ID || null
  const rooms = (process.env.SET_AGENT_ROOM || "").split(",").map(s => s.trim()).filter(Boolean)

  // Without a session there is no seat to keep alive (cron, a bare terminal): the registry's
  // per-seat liveness is the thing being fed, and a bare project name has none.
  if (session && rooms.length) {
    const store = await import("../src/store.mjs")
    const stamp = join(store.ROOT, "beats", `${agent}#${session}`)

    // The stamp is its own tiny file, so the check that runs on every tool call reads one
    // inode and stops — it must never parse the registry just to decide not to write it.
    let due = true
    try { due = Date.now() - statSync(stamp).mtimeMs >= BEAT_INTERVAL_MS } catch { /* first beat */ }

    if (due) {
      mkdirSync(join(store.ROOT, "beats"), { recursive: true })
      touch(stamp)
      // `register`, not `heartbeat`: `heartbeat` only refreshes the AGENT-level `lastSeen`,
      // while the seat's liveness (`seatState`) asks whether any pid recorded under that seat
      // is still running.
      //
      // ⚠ And the pid it records must be `ownerPid()` — the `claude` WINDOW — not this hook's
      // own. Measured while building this: with the default (`process.pid`) the beat wrote the
      // pid of a process that had already exited by the time anyone read the registry, so the
      // seat still resolved to "we do not know". A liveness ping that records a dead pid is a
      // liveness ping that reports the exact thing it exists to correct.
      const pid = store.ownerPid() || process.pid
      for (const room of rooms) store.register({ agent, project: cwd, session, room, pid })
    }
  }
} catch { /* a sign of life must never be able to break the turn it is a sign of */ }

function touch(path) {
  try {
    const now = new Date()
    try { utimesSync(path, now, now) } catch { closeSync(openSync(path, "w")) }
  } catch { /* the stamp is an optimisation; losing it costs one extra write */ }
}

process.exit(0)
