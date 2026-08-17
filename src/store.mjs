// The core: registry (who exists, who is alive) + channel (who said what).
// Zero runtime dependencies — hooks and cron call this too, where there is no node_modules.
//
// Protocol (extracted from the consumer-a ↔ set-core channel, run in on 400 entries):
// ONE FILE, ONE WRITER. Everyone appends to their own file only, and reads the others'.
// That way there is no lost update and no lockfile is needed — after a session dies the
// lock would stay stuck, and from then on nobody would write.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync,
         existsSync, renameSync, openSync, fsyncSync, closeSync, statSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { homedir, hostname } from "node:os"
// Only for the non-Linux branch of `parentOf` — everything else here stays dependency-free and
// synchronous, because hooks and cron call it where there is no node_modules and no event loop.
import { execFileSync } from "node:child_process"

export const ROOT = process.env.SET_AGENT_COMM_DIR
  || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "set-agent-comm")

const REGISTRY = join(ROOT, "registry.json")
const CHANNELS = join(ROOT, "channels")
const CURSORS = join(ROOT, "cursors.json")
const NUDGES = join(ROOT, "nudges.json")
const FOCUS = join(ROOT, "focus.json")
// ⚠ DECLARED state, added 2026-08-11 — see the block above `roomExists` for why these are three
// small files rather than three more keys in `registry.json`.
const ROOMS_FILE = join(ROOT, "rooms.json")
const MEMBERS = join(ROOT, "members.json")
const PRESENCE = join(ROOT, "presence.json")

export const TYPES = ["QUESTION", "ANSWER", "FACT", "REQUEST"]

// Where "long" starts. Not a limit — `send` never refuses — the point at which the writer is told
// how much everyone else is about to read. The measured average was 2168 characters; entries of
// 2701 and 3284 were still going out two days after the wake-up rule landed.
const LONG_CHARS = Number(process.env.SET_AGENT_LONG_CHARS) || 1500

// Where an entry stops being delivered whole to a reader who was NOT woken by it. 0 turns it off.
//
// ⚠ This is the only lever on the READER's bill, and the reader's bill is the big one. Measured
// across the live rooms on 2026-08-06: `consumer-a-atlas` alone held 157 entries averaging 2338
// characters — with three sessions open that is roughly 1.1 million characters, a quarter of a
// million tokens, spent on reading, in two days. An entry that is entitled to interrupt you always
// arrives whole; the rest arrive lede-first, with `history` one call away.
const INBOX_CHARS = process.env.SET_AGENT_INBOX_CHARS === undefined
  ? 1200 : Number(process.env.SET_AGENT_INBOX_CHARS)

/**
 * The entry type lives ON DISK, so the pre-English keywords are still out there in existing
 * channels. Both directions accept them: `send` normalises them, `parse` maps them on read.
 * A rename is not a reason to make already written entries unreadable.
 */
const LEGACY_TYPES = { "KÉRDÉS": "QUESTION", "VÁLASZ": "ANSWER", "TÉNY": "FACT", "KÉRÉS": "REQUEST" }
export const normalizeType = type => LEGACY_TYPES[type] || type

/**
 * The shape of an entry header — `## <ts> — <TYPE> [→ <to>, <to>] [(re: <ts>)]`.
 *
 * ⚠ ONE definition, used BOTH to read an entry back and to decide which body lines have to be
 * neutralised before they are written. If those two ever drift apart, the gap between them is a
 * forged entry, so they may not be two regexes.
 *
 * The timestamp and the type are matched STRICTLY, and that is the repair as much as the guard:
 * the old pattern took `(\S+) — (anything)`, so an ordinary markdown heading in a message body
 * opened a new entry. Measured 2026-08-08 on the live store — 5 of 163 entries in `consumer-a-atlas`
 * were phantoms born this way (`## Hatókör — megerősítve`), each one having TRUNCATED the real
 * message at that line and buried its tail under a timestamp of `0`, which sorts to the front of
 * the room and is never fresh for a reader who already has a cursor. Tightening the pattern gives
 * those five their missing halves back, because the log is append-only but the way we read it
 * is not.
 *
 * The `→` group stays optional: every entry written before addressing existed parses as the
 * broadcast it was. An entry may never become unreadable because the protocol grew.
 */
const TS_PATTERN = String.raw`\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?`
const ENTRY_HEADER = new RegExp(
  `^## (${TS_PATTERN}) — (${[...TYPES, ...Object.keys(LEGACY_TYPES)].join("|")})` +
  String.raw`(?:\s*→\s*([^\n(]+?))?(?:\s*\(re: ([^)]*)\))?\s*$`)

/**
 * A body line that would read back as a header, pushed one space to the right so it cannot.
 *
 * ⚠ Strictness alone is not enough, and the remaining hole is the likeliest one in THIS project
 * of all projects: agents quote channel headers at each other constantly. A body line reading
 * `## 2099-01-01T00:00:00.000+02:00 — FACT` still matches the strict pattern, and measured on
 * 2026-08-08 it does something far worse than split a message. The forged entry is real enough to
 * move the reader's cursor to 2099 — after which every later entry from that writer fails the
 * `t(e.ts) > t(seen[writer])` test, is never fresh, and is never delivered. `send` meanwhile
 * reports `wakes: ["beta"]` to the sender. Delivery confirmed, message muted, for 73 years.
 *
 * The space is deliberately visible rather than clever: what was written is still legible, and
 * nothing has to be un-escaped on the way out.
 */
const escapeBodyHeaders = text =>
  text.split("\n").map(l => ENTRY_HEADER.test(l) ? ` ${l}` : l).join("\n")

/**
 * `SET_AGENT_ROOM` may name SEVERAL rooms, comma-separated ("promo,atlas"): one agent can be
 * part of more than one conversation. Note what this deliberately does NOT do: with several
 * rooms configured there is no default room, so `send` without an explicit `room` fails
 * loudly. Picking "the first one" would send a message into the wrong room silently — and a
 * message delivered to the wrong audience cannot be taken back.
 */
export const parseRooms = value => (value || "").split(",").map(s => s.trim()).filter(Boolean)

/**
 * The addressee list of an entry. Accepts a string ("a, b") and an array alike.
 *
 * BROADCAST IS THE EMPTY LIST, and that stays the default deliberately. A room of two needs no
 * addressing; a room of four does — measured 2026-08-05 in the `consumer-a-promo` / `consumer-a-atlas` /
 * `consumer-a-demo` rooms, where a message aimed at ONE sibling session woke every seat, and each of
 * them spent a full turn establishing that it was not being spoken to. The reverse mistake is
 * worse, though: a message nobody is woken for. Hence the asymmetry — omitting `to` reaches
 * everyone, while a `to` that names nobody in the room is an ERROR (see `send`).
 */
export const parseTo = value =>
  [...new Set((Array.isArray(value) ? value : String(value ?? "").split(","))
    .map(s => String(s).trim()).filter(Boolean))]

/**
 * The names that address THIS seat: the seat itself (`consumer-a#968f89d7`), the project behind
 * it (`consumer-a` — every session of it, which is the common case: the sender knows who it is
 * talking to, not which window happens to be open), and for a remote seat the project without
 * its machine (`consumer-a@mac-mini` → `consumer-a`), so addressing a project reaches it on every
 * machine.
 */
export const addressForms = seat => {
  const base = seatBase(seat)
  return new Set([seat, base, base.split("@")[0]].filter(Boolean))
}

/** Is this entry for me? A broadcast is for everyone — that is what keeps `to` optional. */
export function isForMe(entry, me) {
  if (!entry.to?.length) return true
  const forms = addressForms(me)
  return entry.to.some(n => forms.has(n))
}

/**
 * DOES THIS ENTRY START A TURN? — a strictly narrower question than `isForMe`, and the two were
 * conflated until 2026-08-06. Reading is cheap; being woken is not. A wake-up is a whole turn of
 * the main agent, on the expensive model, with the room's context pulled in behind it.
 *
 * ⚠ THE MEASUREMENT THIS RULE COMES FROM, taken over the first two days of live use across the
 * `consumer-a-atlas` / `consumer-a-promo` / `consumer-a-demo` rooms:
 *
 *   190 entries were written. 190 of them were broadcasts — `to` was used ZERO times, in
 *   47 opportunities after it existed. So "only the addressee is woken" was correct code that
 *   nothing ever invoked, and in practice EVERY entry woke EVERY seat.
 *
 *   In `consumer-a-atlas` this produced a closing handshake that could not terminate: 23 entries in
 *   8 minutes between four seats, every one of them a broadcast `FACT` averaging 2168
 *   characters, every one of them `re:`-chained to the last, with content like "Vettem — és jól
 *   tetted…" and "Ezzel tényleg lezárom." The message announcing the end of the conversation
 *   woke everyone and asked, by the protocol then in force, for another answer.
 *
 * So the default flips, and it flips HERE rather than in a prompt — an optional field that
 * 190 entries declined to use is not a mechanism, it is a suggestion:
 *
 *   named in `to`                    → wakes. Addressing someone is now the ONLY way to claim
 *                                      a specific agent's attention, which is what makes `to`
 *                                      worth typing.
 *   `re:` points at MY entry         → wakes, WHATEVER THE TYPE. A reply to what I wrote is
 *                                      aimed at me in all but name.
 *   broadcast QUESTION / REQUEST     → wakes. A question with no addressee is a question to the
 *                                      room, and the room is allowed to be interrupted by one.
 *   anything else                    → DOES NOT WAKE. It is delivered, it is unread, `inbox`
 *                                      hands it over — it simply does not buy a turn.
 *
 * Against the measured traffic this is a 91% cut: of 133 entries in `consumer-a-atlas`, 12 would have
 * woken anyone (11 REQUEST + 1 KÉRÉS), instead of all 133.
 *
 * ⚠ THE `re:` RULE IS TYPE-BLIND, and it was not until a live run on 2026-08-06 proved it had to
 * be. In `demo/scenarios/three-projects-two-seats.json`, `invoicing` asked a QUESTION addressed to
 * a `pricing` seat; another `pricing` seat answered it — correctly, with `re:` pointing straight at
 * the question — but typed the entry `FACT` rather than `ANSWER`. The old rule looked at `re:` only
 * on an `ANSWER`, so `unreadWaking` was 0 and the asker was never woken. Two rounds later it was
 * still writing "no answer from pricing yet, I am waiting". Delivered, unread, nobody woken, the
 * waiting party blocked — the exact failure this whole project exists to prevent, reintroduced by
 * my own rule through a type the sender happened to pick.
 *
 * A sender's choice of type may not decide whether the person they are replying to hears them.
 *
 * @param mine  the timestamps THIS seat has written in the room (see `ownTimestamps`) — without
 *              it the `re:` rule is off, and a reply reaches nobody by that route.
 */
export function wakes(entry, me, mine, quiet = undefined) {
  if (!isForMe(entry, me)) return false
  // ⚠ A DECLARED quiet is applied HERE and nowhere else, because this function is the single
  // rule the Stop hook, `sac wait` and `inbox` all read. Delivery is untouched: a quiet seat
  // still receives every entry — only the expensive half is suppressed. `quiet` is passed in by
  // callers that loop (one read instead of one per entry) and read from disk otherwise.
  if (quiet === undefined ? seatPresence(me).quiet : quiet) return false
  if (entry.to?.length) return true
  if (entry.re && mine?.has(entry.re)) return true
  return entry.type === "QUESTION" || entry.type === "REQUEST"
}

/** The timestamps this seat has written in the room — what someone else's `re:` can point at. */
export function ownTimestamps(room, agent) {
  return new Set(parse(busFile(room, agent), agent).map(e => e.ts))
}

/**
 * ISO timestamp with local offset, at MILLISECOND resolution.
 *
 * ⚠ This may NEVER be a value written from memory. Measured on 2026-07-24 on the old,
 * hand-kept channel: the real clock said 10:50 while one side claimed `T16:50` (+6 hours)
 * and the other `T12:25` (+1.5 hours) — *both* agents were guessing. A fake timestamp is
 * not cosmetic: the "the other side has been silent for N minutes" condition rests on it,
 * so it blinds the watcher.
 *
 * ⚠ SECONDS ARE NOT ENOUGH — measured on our own smoke test. At machine speed a question
 * and its answer land in the same second; on equal timestamps sorting falls back to the
 * alphabetical order of file names, and `history` returns the ANSWER first. The thread
 * silently reverses, and the agent reading it misunderstands. Older entries without ms still
 * sort correctly (within the same second they come before `.000`).
 */
export function now(d = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, "0")
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? "-" : "+"
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.trunc(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
}

/**
 * Sort key. By REAL time, not by string comparison: string sorting gets it wrong across a
 * DST switch (`…T02:30+02:00` vs `…T02:30+01:00` share the text prefix but are an hour
 * apart). On a tie the caller's original order is kept (stable sort).
 */
const t = ts => Date.parse(ts) || 0
const byTime = (a, b) => t(a.ts) - t(b.ts)

// ── mkdir -p, by hand ─────────────────────────────────────────────────────────
/**
 * `mkdirSync(dir, { recursive: true })` is called nowhere on any path a hook, the CLI or the
 * bridge can reach (only in tests, against a `mkdtemp` dir), and this is why.
 *
 * ⚠ Measured 2026-08-09, spotted in `htop`: one `hooks/heartbeat.mjs` had been burning a whole
 * core for 6 hours 9 minutes. Node's recursive mkdir (v22.22.0) creates the missing parent and
 * then RETRIES the leaf, counting the parent's EEXIST as success — so wherever the leaf keeps
 * answering ENOENT while its parent exists, it retries forever, in a loop inside node that
 * never returns. procfs is exactly that shape: `mkdir /proc/x` gives ENOENT, `/proc` exists.
 * The store root was `/proc/nonexistent-and-unwritable`, a throwaway "unwritable store" test
 * fixture, and the process outlived the test run that spawned it by six hours.
 *
 * The `catch` around every caller never ran, and could not have: a hook that exits 0 whatever
 * happens still cannot defend itself against an API that never comes back, and neither can a
 * timeout — the loop is synchronous, so no timer in this process would ever get a turn. The
 * only defence is not to call it.
 *
 * So: one `mkdir` per path segment, from the root down, bounded by the number of segments.
 * A segment that is already a directory is success whatever the errno (an existing ancestor we
 * have no right to create answers EACCES or EROFS, not EEXIST); anything else throws to the
 * caller, who already treats a broken store as a lost write. Same result on the paths that
 * work, an error on the paths that do not, and no path that never returns.
 */
export function ensureDir(dir) {
  const parts = []
  for (let p = resolve(dir); ; p = dirname(p)) {
    parts.push(p)
    if (dirname(p) === p) break
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    try { mkdirSync(parts[i]) } catch (e) {
      try { if (statSync(parts[i]).isDirectory()) continue } catch { /* not there at all */ }
      throw e
    }
  }
}

// ── atomic JSON write ─────────────────────────────────────────────────────────
// tmp → fsync → rename. On a crash `writeFileSync` leaves truncated JSON in the target file,
// and from then on the registry is unreadable — a pattern borrowed from AMQ.
function writeJson(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp.${process.pid}`
  const fd = openSync(tmp, "w")
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(tmp, path)
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return fallback }
}

// ── registry ──────────────────────────────────────────────────────────────────

/**
 * Does that process still exist? EPERM means it does, but belongs to someone else.
 *
 * The pid is what we have: identity comes from the project directory (see stdio.mjs), so the
 * name cannot tell two sessions apart, but the WRITING PROCESS always can — no configuration,
 * nothing to mistype.
 */
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" }
}

// ── which window are we in ────────────────────────────────────────────────────
/**
 * The pid and name of a process's parent. Linux from `/proc`, everything else through `ps`.
 * `/proc/<pid>/stat` is `pid (comm) state ppid …`, and the comm may itself contain spaces and
 * parentheses — hence the search for the LAST `)` rather than a split on whitespace.
 */
function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const close = stat.lastIndexOf(")")
    return { comm: stat.slice(stat.indexOf("(") + 1, close), ppid: Number(stat.slice(close + 2).split(" ")[1]) }
  } catch { /* not Linux, or the process is gone */ }
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim()
    const [pp, ...rest] = out.split(/\s+/)
    return { comm: rest.join(" "), ppid: Number(pp) }
  } catch { return null }
}

/**
 * WHICH CLAUDE CODE WINDOW THIS PROCESS BELONGS TO — the pid of the nearest `claude` ancestor.
 *
 * ⚠ Measured 2026-08-06 in a live `consumer-a` window, and it is the reason this exists. The MCP
 * server (pid 1669607) was started by that window's own `claude` process (1668522) at 10:46:15,
 * and Claude Code put `CLAUDE_CODE_SESSION_ID=fef3e62f…` into its environment — an id with NO
 * TRANSCRIPT ON DISK, while the session was demonstrably writing `8a31f74c….jsonl` at the time.
 * The SessionStart hook, in the same window, got the real one. So the two claimed two seats, two
 * empty files appeared in the room within a minute for one window, and the agent read its inbox
 * on a cursor that belonged to nobody: the hook said "1 unread", the tool said "0".
 *
 * The session id is therefore not something we can rely on being the same for both halves. The
 * owning `claude` process is: the MCP server is its child, and a hook or a `sac` call is its
 * grandchild through a shell. That pid is unforgeable, needs no configuration, and is identical
 * for everything running inside one window.
 *
 * `SET_AGENT_OWNER_PID` overrides it — for a wrapper that knows better, and for the tests, which
 * cannot conjure a `claude` ancestor.
 */
export function ownerPid(start = process.pid) {
  // `SET_AGENT_OWNER_PID=0` (or any non-positive value) says "no window" and stops the walk —
  // that is the honest answer for cron, a bare terminal, and the tests, where a `claude` ancestor
  // would be found but would not be the caller's window.
  const forced = process.env.SET_AGENT_OWNER_PID
  if (forced) return Number(forced) > 0 ? Number(forced) : null
  let pid = start
  for (let i = 0; i < 12 && pid > 1; i++) {
    const p = parentOf(pid)
    if (!p) return null
    if (/(^|\/)claude$/.test(p.comm)) return pid
    pid = p.ppid
  }
  return null
}

/**
 * The owner's controlling terminal, from `/proc/<pid>/stat` field 7 (`tty_nr`): `0` means the
 * process has none. The fields after the last `)` are state, ppid, pgrp, session, tty_nr — hence
 * index 4, and the same `lastIndexOf(")")` trick as `parentOf`, for the same reason.
 *
 * Off Linux there is no field number, only `ps -o tty=`, which prints `??` for "no terminal" —
 * so the answer there is coarse (0 or 1), which is all any caller needs. `null` = could not tell.
 */
function ttyNr(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4])
  } catch { /* not Linux, or the process is gone */ }
  try {
    const tt = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8" }).trim()
    return tt === "" || tt === "?" || tt === "??" ? 0 : 1
  } catch { return null }
}

/**
 * Is the owner running in PRINT MODE (`claude -p`)? This is the direct evidence — print mode is
 * the property that matters, the terminal is only a proxy for it — and it catches the case the
 * terminal test cannot: a person typing `claude -p …` by hand, which has a tty and still has no
 * prompt to come back to.
 *
 * ⚠ Linux only, and deliberately so. `/proc/<pid>/cmdline` is NUL-separated, so the argv
 * boundaries are exact and `-p` cannot be matched inside a prompt. `ps -o args=` joins them with
 * spaces and loses that; a prompt containing " -p " would then read as print mode and SILENCE A
 * REAL SESSION — the expensive direction. Off Linux we keep the terminal test alone.
 */
function printMode(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0").some(a => a === "-p" || a === "--print")
  } catch { return false }
}

/**
 * IS THIS A HEADLESS RUN — a `claude -p` that nobody is sitting in front of.
 *
 * WHY IT MATTERS: joining the bus is written as instructions to a model (arm a `Monitor`, declare
 * a `focus`), and a timer-driven run obeys them at the cost of two to four turns before it starts
 * its actual work. That ceremony buys it nothing: it has no idle prompt to be woken at, so the
 * Monitor watches nothing, and it exits after one task, so its `focus` is read by nobody. It needs
 * exactly ONE thing from the bus — to be checked in, so that it is addressable. The heaviest
 * participant on the bus had already instructed its machines to skip agent-comm entirely over this
 * (measured 2026-08-08: 237 of `consumer-b`'s 239 seats are machines).
 *
 * ⚠ Measured 2026-08-08, and this is the second measurement of the signal — the first had one data
 * point per side. Seven live `claude` processes on the box: six interactive owners reported
 * `tty_nr` 34820/34822/34823/34824/34829/34830, one `claude -p` work-queue run reported `0`, and
 * the argv test agreed with the terminal test on all seven. One of the six is hosted inside an IDE
 * (Zed), which was the risk worth checking: an editor that gave its session no pty would be
 * silenced by this test. It gives it a real one (`pts/4`).
 *
 * ⚠ IT FAILS TOWARD THE CEREMONY. Every unknown — no owner, an unreadable `/proc`, a platform
 * with neither — answers "not headless". Getting it wrong that way costs a few turns; getting it
 * wrong the other way leaves a real session with no watch armed, which is this project's one
 * unacceptable failure. `SET_AGENT_HEADLESS=1|0` forces it, for the tests (which cannot conjure a
 * tty-less `claude` ancestor) and for a wrapper that knows better.
 */
export function headless(owner = ownerPid()) {
  const forced = process.env.SET_AGENT_HEADLESS
  if (forced) return !/^(0|off|false|no)$/i.test(forced)
  if (!owner) return false
  return printMode(owner) || ttyNr(owner) === 0
}

/** The seat this window already holds, whatever either half thinks its session id is. */
const seatOfOwner = (seats, owner) => owner
  ? Object.keys(seats).find(n => seats[n].owner === owner && seatState(seats[n]) !== false)
  : undefined

// ── seats: one session, one writer file ───────────────────────────────────────
/**
 * A SEAT is the writer identity: the name of the file this session appends to. The agent name
 * (the project directory) identifies the PROJECT; the seat identifies the SESSION inside it.
 * Every session writes into its own file, named after its session id: `consumer-a#968f89d7`.
 *
 * ⚠ Measured 2026-08-04 in the `consumer-a-atlas` room, and this is what the seat exists for: two
 * Claude sessions open in ONE project were ONE name on the bus, because identity is the
 * directory. Three consequences, all silent: they wrote into the SAME file, `inbox` skipped
 * that file as "my own" so they could never receive each other, and they SHARED one read
 * cursor — whichever read first marked the message read for the other. The room carried
 * "do not regenerate yet" (11:31) and "already regenerated" (11:46) under a single sender
 * name; the receiving agent answered the wrong one and had to say so.
 *
 * The seat comes from `CLAUDE_CODE_SESSION_ID` (measured: the MCP server process, the hook
 * and any `sac` call inherit the same value), so it stays unforgeable — nothing to type,
 * nothing to make up. Without a session id there is no seat: the caller writes under the bare
 * project name (cron, a bare terminal), and the co-writer warning of `send` covers that case.
 */
export const seatBase = writer => String(writer).replace(/#[^#]+$/, "")

/**
 * The seat name carries the SESSION ID (`consumer-a#968f89d7`), by the author's decision on
 * 2026-08-04, made with the trade-off in front of him: this way a name says exactly which
 * session it is — it can be matched against what Claude Code's `/status` shows — while a
 * counter (`#2`) says only "the second one, some time". The price he accepted: a name is
 * good for one session, so every restart starts a new file, and the room accumulates the
 * files of past sessions.
 *
 * Eight characters of a UUID is plenty to tell sessions apart, but the id does not HAVE to be
 * a UUID (a test, another client), so a shortened form that is already held by a DIFFERENT
 * session gets longer rather than colliding. Two sessions in one file is the failure this
 * whole mechanism exists to prevent — it may not come back through the name.
 */
const SEAT_LENGTHS = [8, 12, 16]
const seatName = (agent, session, len) => `${agent}#${session.slice(0, len)}`

/**
 * Is anyone alive on this seat? THREE answers, not two — the same rule `agents` follows for
 * `silentMinutes`: "we don't know" and "dead" are different claims.
 *
 *   true   a process of it is alive (an MCP server lives as long as its session)
 *   null   no live process, but it checked in recently — a session running with only the hook
 *          and the CLI has no lasting process, so this cannot be called dead
 *   false  no live process and quiet for half an hour
 *
 * Since the name follows from the session id, nothing is ever taken over on the strength of
 * this — it only decides what we REPORT, and what `pruneEmptySeats` may delete (`false` only).
 */
const SEAT_TTL_MS = 30 * 60_000

const seatState = seat => {
  if (!seat) return false
  if (Object.keys(seat.writers || {}).some(p => alive(Number(p)))) return true
  return Date.now() - (Date.parse(seat.lastSeen) || 0) < SEAT_TTL_MS ? null : false
}

/**
 * How many CLOSED windows one project keeps in the roster. Live and unknown seats are never
 * counted or dropped — this only bounds the tail of sessions that are provably gone.
 *
 * ⚠ `pruneSeats` already forgets dead seats, and it was not enough, for a reason worth writing
 * down: it is calibrated in DAYS while seats are created per session. Measured 2026-08-08 on the
 * live store — 302 seats, 238 of them one project's, 236 of those a confident `seatState === false`
 * — and `sac prune --dry` dropped exactly 0 of them, because 193 were written the previous day and
 * nothing was 7 days old yet. Meanwhile `agents` returned 77,923 characters, over the tool-result
 * limit, so "who is doing what" — the lookup that exists to save the room a conversation — could
 * not be answered at all. A time-based rule cannot bound a per-session quantity; a count can.
 */
const SEATS_KEPT_PER_AGENT = 10

/** Drop all but the most recently seen closed windows. Never touches a message file or a cursor. */
function capDeadSeats(seats, keep = SEATS_KEPT_PER_AGENT) {
  const dead = Object.entries(seats).filter(([, s]) => seatState(s) === false)
  if (dead.length <= keep) return seats
  dead.sort((a, b) => (Date.parse(b[1].lastSeen) || 0) - (Date.parse(a[1].lastSeen) || 0))
  for (const [name] of dead.slice(keep)) delete seats[name]
  return seats
}

/** Record this process on the seat, and forget the processes that have exited. */
function touchSeat(seats, name, { session = null, pid, owner = null, room = null }) {
  const held = seats[name]
  // A seat held by ANOTHER session is not ours to inherit — start a fresh record. Without a
  // session id we do not overwrite the holder: the CLI must not evict a live session.
  //
  // ⚠ SAME OWNER COUNTS AS OURS, even when the session ids differ, and that exception is the
  // whole point of `ownerPid`: the MCP server and the hook of ONE window disagree about the id
  // (measured — see `ownerPid`), and without this the second one to arrive would wipe the
  // first's record and take the seat over as a stranger.
  const ours = held && (!session || !held.session || held.session === session ||
                        (owner && held.owner === owner))
  const prev = ours ? held : {}
  const writers = { ...(prev.writers || {}), [pid]: now() }
  for (const p of Object.keys(writers)) if (Number(p) !== pid && !alive(Number(p))) delete writers[p]
  seats[name] = {
    session: prev.session ?? session ?? null,   // the FIRST id claimed for the window stands
    owner: owner ?? prev.owner ?? null,
    writers,
    // ⚠ PER SEAT, not per agent. One project's sessions are in different rooms — that is the
    // normal case, not the exception — and the agent-level list cannot express it. Measured
    // 2026-08-08: with the room recorded only on the agent, `liveSeats("shared-room")` and
    // `liveSeats("pair-room")` returned byte-identical lists, naming four seats that had never
    // written into either. `send`'s wake report reads that list, so the sender was told its
    // entry woke seats that were not in the room.
    rooms: [...new Set([...(prev.rooms || []), ...(room ? [room] : [])])],
    firstSeen: prev.firstSeen || now(),
    lastSeen: now(),
  }
  return seats[name]
}

/**
 * Which seat is this session's? The name FOLLOWS FROM the session id, so it needs no
 * negotiation: two sessions starting at the same moment cannot pick the same one, and a
 * restarted session with the same id gets its file and its cursor back.
 */
export function claimSeat({ agent, session, pid = process.pid, owner = ownerPid() }) {
  if (!agent) throw new Error("claimSeat: `agent` is required")
  const reg = readJson(REGISTRY, { agents: {} })
  const rec = (reg.agents[agent] ||= { agent })
  const seats = (rec.seats ||= {})
  // ⚠ ONE WINDOW, ONE SEAT. The owning `claude` process decides first, and the session id only
  // gets to NAME a seat that does not exist yet — because the two halves of a window do not
  // reliably agree on the id (see `ownerPid`), and disagreeing about the id is survivable while
  // writing into two files with two cursors is not. Whoever arrives first names it; the other
  // adopts it. That also means a window keeps its seat when only one half is restarted.
  const held = seatOfOwner(seats, owner)
  if (!held && !session) return agent           // no window, no id — the bare project name, as before
  const name = held || seatFor(seats, agent, session, owner)
  touchSeat(seats, name, { session, pid, owner })
  writeJson(REGISTRY, reg)
  return name
}

/**
 * The shortest form of the id that is not already held by a DIFFERENT session — or by a
 * different live WINDOW.
 *
 * ⚠ The second half of that is not paranoia. The id an MCP server is handed can be one no
 * session on disk answers to (see `ownerPid`), so "the session ids match" is not proof that two
 * claimants are the same session — and if it lets a second window onto a seat, the two share a
 * file and a cursor, which is the exact failure seats were built to end.
 */
function seatFor(seats, agent, session, owner = null) {
  for (const len of SEAT_LENGTHS) {
    const name = seatName(agent, session, len)
    const held = seats[name]
    if (!held || (held.session === session && !otherWindow(held, owner))) return name
  }
  return seatName(agent, session, session.length)
}

/**
 * Is this seat held by a DIFFERENT window that still exists? The pid decides, not the clock.
 *
 * ⚠ Measured 2026-08-06 in `demo/scenarios/handoff-chain.json`: six sessions produced NINETEEN
 * seats. Every round resumed the same session ids, but `claude --resume` is a NEW PROCESS each
 * time, so the owner pid changed under a seat whose id had not. Judged on recency alone the
 * previous round's owner — dead for forty seconds — still counted as a live window, so the seat
 * was refused and the name grew a syllable: `catalog#21215117`, `…-2da`, `…-2daa-45`,
 * `…-2daa-45a0-8cae-df47b53fbe66`. Four files, four cursors, and the focus left behind on each.
 * That is the same shape as the seat sprawl seen on every restart of a live window.
 *
 * A dead owner cannot be in a conflict with anyone. Recency stays in the test as well: a pid is
 * reused eventually, and a seat nobody has touched for hours is not a window either.
 */
const otherWindow = (held, owner) =>
  !!held?.owner && held.owner !== owner && alive(held.owner) && seatState(held) !== false

/**
 * Which seat is this session's — WITHOUT claiming one. For read-only callers.
 *
 * ⚠ Measured while it was being built: `sac agents`, a pure query, claimed itself a seat,
 * because the CLI inherits `CLAUDE_CODE_SESSION_ID` from whatever started it — a listing
 * therefore invented a third session in a project that had two. Reading may not change the
 * state it reports on.
 */
export function seatOf({ agent, session, owner = ownerPid() }) {
  const seats = readJson(REGISTRY, { agents: {} }).agents?.[agent]?.seats || {}
  // The window first, for the reason given in `claimSeat`: a reader that resolves itself to a
  // different seat than the writer half of the same window reads the wrong cursor, which is
  // exactly how "the hook says 1 unread, the tool says 0" happens.
  const held = seatOfOwner(seats, owner)
  if (held) return held
  if (!session) return agent
  // Same test as `seatFor`: the seat of a session that was resumed is held by an owner pid that
  // no longer exists, and a dead window is not a competing one.
  return Object.keys(seats).find(n => seats[n].session === session && seatState(seats[n]) !== false &&
                                      !otherWindow(seats[n], owner))
    || seatFor(seats, agent, session, owner)
}

/**
 * An agent checking in. Idempotent: the same name is updated, not duplicated.
 *
 * With a `session` the check-in claims a seat (see `claimSeat`); `writer` skips the claim for
 * a seat that is already known — `send` uses that, so writing a message never reshuffles seats.
 */
export function register({ agent, project, session, room, pid = process.pid, writer,
                           owner = ownerPid() }) {
  if (!agent) throw new Error("register: `agent` is required")
  const seat = writer || claimSeat({ agent, session, pid, owner })
  /**
   * ⚠ A ROOM THIS SEAT HAS LEFT IS NOT RE-ENTERED — in the REGISTRY as well, not only in
   * `members.json`. The SessionStart hook calls `register` once per configured room on every
   * start, and the roster is what every other session reads. Measured 2026-08-12: after
   * `sac part`, `members` had dropped the room and `liveSeats` still named the seat in it, so
   * the next hook run put a leaving that had "stuck" back into everybody else's list.
   *
   * `seedMembers` has had this asymmetry since 2026-08-11 — the environment may ADD a room,
   * never restore one somebody removed. This is the same rule, applied where it is visible.
   */
  const joining = room && !leftRooms(seat).includes(room) ? room : null
  const reg = readJson(REGISTRY, { agents: {} })
  const prev = reg.agents[agent] || {}
  const seats = { ...(prev.seats || {}) }
  // `owner` is passed through, not re-derived: without it a check-in whose session id differs
  // from the one that named the seat would read as a stranger and wipe the window's record.
  const mine = touchSeat(seats, seat, { session, pid, owner, room: joining })
  // Bounded HERE rather than in a command someone has to remember to run: the registry grows one
  // seat per session, and a roster nobody can read is the same as no roster at all.
  capDeadSeats(seats)

  reg.agents[agent] = {
    ...prev,
    agent,
    project: project ?? prev.project ?? null,
    session: session ?? prev.session ?? null,
    host: hostname(),
    rooms: [...new Set([...(prev.rooms || []), ...(joining ? [joining] : [])])],
    seats,
    firstSeen: prev.firstSeen || now(),
    lastSeen: now(),
  }
  writeJson(REGISTRY, reg)
  // ⚠ CHECKING IN IS AN EXPLICIT ACT, so it may open the room; `send` may not. The room name a
  // `register` carries comes from the project's settings — written by `sac install`, read by the
  // SessionStart hook — which is a decision somebody made. The name a `send` carries was typed
  // in the moment, and that is where the measured failure was: a mistyped room becoming a new
  // silent room the writer is alone in, with `send` returning success.
  if (joining && !roomExists(joining)) createRoom(joining, seat)
  // Membership is per seat from here on; the configured rooms seed it once and never again.
  if (joining) seedMembers(seat, [joining])
  seedCursor(joining, seat)
  // Co-writers are counted PER SEAT — that is, per file. Another session of the same project
  // sits in its own seat and does not collide, so it must not raise a warning.
  return {
    ...reg.agents[agent],
    writer: seat,
    seatSession: mine.session,
    coWriters: Object.keys(mine.writers).map(Number).filter(p => p !== pid),
  }
}

/** Sign of life — refreshes `lastSeen` without recording a new session. */
export function heartbeat(agent) {
  const reg = readJson(REGISTRY, { agents: {} })
  if (!reg.agents[agent]) return null
  reg.agents[agent].lastSeen = now()
  writeJson(REGISTRY, reg)
  return reg.agents[agent]
}

/**
 * The registered agents. `silentMinutes`: how long since the last sign of life.
 *
 * ⚠ `alive` is ALWAYS null when there is no `lastSeen` — never `false`. "We don't know" and
 * "definitely dead" are two different claims, and a false `false` errs in the wrong
 * direction: the caller would give up on a live partner.
 */
/** When this seat last APPENDED anything, across its rooms — from the file's mtime. */
function lastWrote(writer, rooms) {
  let newest = 0
  for (const room of rooms) {
    try {
      const st = statSync(busFile(room, writer))
      if (st.size && st.mtimeMs > newest) newest = st.mtimeMs
    } catch { /* no file in that room — it never wrote there */ }
  }
  return newest ? now(new Date(newest)) : null
}

export function agents() {
  const reg = readJson(REGISTRY, { agents: {} })
  return Object.values(reg.agents).map(a => {
    const ms = a.lastSeen ? Date.now() - new Date(a.lastSeen).getTime() : null
    // The seats are shown as a LIST, and the live ones separately: this is what tells another
    // agent that this project currently has two sessions, and which names to address.
    // The FULL session id is reported, not the shortened form in the name: that is what can be
    // matched against what Claude Code shows for a session, which is the point of the whole
    // naming scheme — to be able to say WHICH window that seat is.
    //
    // `lastWrote` is a SEPARATE fact from `lastSeen`, and conflating them misleads: checking in
    // is not writing. Measured 2026-08-05 — an agent read "silent since 09:03" off the registry
    // for a seat and concluded it had gone quiet. Cheap to answer honestly: the mtime of that
    // seat's files, no parsing.
    // `focus` rides along with the seat: "who is in which files" is the question agents were
    // burning whole broadcast rounds on, and it is answerable from here.
    const seats = Object.entries(a.seats || {}).map(([writer, s]) => {
      // ⚠ `quiet` RIDES ALONGSIDE `live`, never inside it. Liveness stays three-state — `true` /
      // `null` / `false`, where `null` is "we do not know" — and quiet is a fourth, DECLARED
      // state, the only one somebody chose. Folding it into `live` would make a seat that asked
      // not to be interrupted indistinguishable from one that died, which is the exact
      // conflation the three-state rule exists to prevent.
      const p = seatPresence(writer)
      return {
        writer, session: s.session ?? null, live: seatState(s), lastSeen: s.lastSeen ?? null,
        lastWrote: lastWrote(writer, a.rooms || []),
        focus: getFocus(writer),
        ...(p.quiet && { quiet: true, quietUntil: p.until }),
      }
    })
    return {
      ...a,
      seats,
      // Live and "we don't know" both belong here: leaving out a session that may well be
      // working would send the caller looking for someone to talk to who is right there.
      live: seats.filter(s => s.live !== false).map(s => s.writer),
      silentMinutes: ms == null ? null : Math.round(ms / 60000),
    }
  }).sort((x, y) => (x.silentMinutes ?? 1e9) - (y.silentMinutes ?? 1e9))
}

/**
 * THE MACHINE-READABLE VIEW — `sac agents --json`, and the only shape another program may bind to.
 *
 * ⚠ Added 2026-08-17, asked for by `set-core` while building FleetView. Their words, and they are
 * the whole justification: without it the screen "would have to read the internal files directly
 * (registry.json, focus.json) — which means your internal format becomes my contract, and your
 * next format change silently breaks the surface." That is exactly right, and it is why this is a
 * hand-written projection rather than `JSON.stringify(agents())`: `agents()` spreads the whole
 * registry record (`...a`), so shipping it would publish every field this store has ever kept,
 * including the ones added tomorrow. Everything below is named on purpose. `schema` is how a
 * reader notices the day that stops being true.
 *
 * ⚠ LIVENESS IS A WORD HERE, NOT `true`/`null`/`false`. Inside this file the three-state rule
 * survives because every call site was written knowing about it; across a process boundary it
 * would not. `if (seat.live)` collapses "we do not know" into "dead" silently, in the reassuring
 * direction, and this project has already paid for that once (`consumer-a#f93ef295`, 2026-08-09: 86
 * minutes of apparent silence from a seat that worked throughout, and a session that addressed
 * somebody else because of it). Three words force three branches; a nullable boolean does not.
 *
 * ⚠ AND `silentMinutes` IS NOT ACTIVITY. It is the age of the last hook or `sac` call, which is a
 * proxy — `set-core` measured this store reporting "21m silent" for a project whose session log
 * had been written that same minute, because that project has no `sac install` and so nothing
 * feeds the heartbeat. `lastWrote` is a real event (the seat appended); `lastSeen` is a check-in.
 * Anything asking "is it moving right now" should ask the runtime, not this.
 */
export const AGENTS_SCHEMA = "sac.agents/1"

const liveness = live => (live === true ? "live" : live === false ? "gone" : "unknown")

export function agentsReport() {
  return {
    schema: AGENTS_SCHEMA,
    generatedAt: now(),
    agents: agents().map(a => ({
      agent: a.agent,
      project: a.project ?? null,
      host: a.host ?? null,
      rooms: a.rooms || [],
      lastSeen: a.lastSeen ?? null,
      silentMinutes: a.silentMinutes,
      seats: (a.seats || []).map(s => ({
        seat: s.writer,
        session: s.session,
        liveness: liveness(s.live),
        lastSeen: s.lastSeen,
        lastWrote: s.lastWrote,
        quiet: !!s.quiet,
        quietUntil: s.quietUntil ?? null,
        // The declaration, whole — `stale` travels WITH it rather than being applied here, so a
        // reader can show "they said this, four hours ago" instead of losing the only fact there is.
        focus: s.focus ? {
          text: s.focus.text,
          files: s.focus.files || [],
          phase: s.focus.phase ?? null,
          ts: s.focus.ts,
          ageMinutes: s.focus.ageMinutes,
          stale: s.focus.stale,
        } : null,
      })),
    })),
  }
}

// ── channel ───────────────────────────────────────────────────────────────────

export const channelDir = room => join(CHANNELS, room)
export const busFile = (room, agent) => join(channelDir(room), `${agent}.md`)
const writerOf = path => path.split("/").pop().replace(/\.md$/, "")

/**
 * A WRITER NAME BECOMES A FILE NAME — so a name that arrived from another machine has to be
 * checked before it is one.
 *
 * ⚠ Measured 2026-08-05 while reviewing the relay: `ingest` with the writer
 * `../../../../pwned@mac#1` wrote a file FOUR DIRECTORIES ABOVE the store. The relay let it
 * through, because its own check only looks at the `@ns` part of the name. The `.md` suffix is
 * no protection at all — `../../.claude/skills/agent-comm/SKILL` plus `.md` is a skill file,
 * i.e. instructions the agent loads on its next start.
 *
 * Deliberately a REFUSAL on dangerous shape rather than a whitelist of characters: project
 * names come from directory names, and rejecting an accented or spaced one would drop real
 * messages. Path separators, NUL and traversal segments are what make a name a path.
 */
export function assertSafeWriter(writer) {
  const w = String(writer)
  const bad = !w || w.length > 200 || /[\\/\u0000-\u001f]/.test(w) ||
    w.split(/[@#]/).some(part => part === "." || part === "..")
  // Belt and braces: whatever the name looks like, the file it resolves to must be IN the room.
  if (!bad && dirname(busFile("x", w)) === channelDir("x")) return
  throw new Error(`unsafe writer name '${w.slice(0, 80)}' — it would not stay inside the room`)
}

/**
 * The timestamp is written verbatim into an entry's header line, so it may not carry one.
 * A newline in `ts` lets a remote sender forge extra headers inside its own file — attributed
 * to itself, but with any type, addressee and time it likes.
 */
export function assertSafeTs(ts) {
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?$/.test(String(ts)))
    throw new Error(`unusable timestamp '${String(ts).slice(0, 40)}'`)
}

/** Every writer file in the room — this is what the hook registers as `watchPaths`. */
export function busFiles(room) {
  try {
    return readdirSync(channelDir(room)).filter(f => f.endsWith(".md") && f !== "README.md")
      .map(f => join(channelDir(room), f)).sort()
  } catch { return [] }
}

/**
 * Delete the EMPTY writer files of this project's dead sessions.
 *
 * The counterweight to session-id names: the SessionStart hook announces every session with a
 * file of its own ("I am here, this is where I write"), so a session that never writes still
 * leaves one behind — a handful of empty files a day. Without this, the room would be unusable
 * to look at in a week.
 *
 * Three conditions, all of them necessary, so that this can never destroy anything:
 *  - the file is EMPTY (not one entry in it) — a file with content is history, never touched;
 *  - it belongs to a seat of THIS project (we do not clean up after others);
 *  - nobody is alive on that seat, and it is not the caller's own.
 */
export function pruneEmptySeats({ room, agent, keep }) {
  const seats = readJson(REGISTRY, { agents: {} }).agents?.[agent]?.seats || {}
  const removed = []
  for (const path of busFiles(room)) {
    const w = writerOf(path)
    // `!== false` — only a seat we are SURE is dead may be cleaned up after.
    if (w === keep || seatBase(w) !== agent || seatState(seats[w]) !== false) continue
    try {
      if (statSync(path).size) continue
      unlinkSync(path)
      removed.push(w)
    } catch { /* someone got there first, or it is being written — leave it alone */ }
  }
  return removed
}

/**
 * Append an entry to your own file. APPEND, never a full rewrite.
 *
 * This is the most concrete gain of the extraction: on the old channel the agent wrote with
 * the `Write`/`Edit` tool, which is a FULL rewrite of a 555 KB file per message — the file
 * lands in the context, and out of two concurrent writes one is silently lost.
 */
export function send({ room, from, type = "FACT", text, re, to }) {
  if (!room || !from) throw new Error("send: `room` and `from` are required")
  if (!text?.trim()) throw new Error("send: empty message")
  type = normalizeType(type)
  if (!TYPES.includes(type)) throw new Error(`send: unknown type '${type}' (${TYPES.join(" | ")})`)
  // An addressee nobody answers to is the one failure this must not commit silently: it would
  // be a message with the room full of readers and NOT ONE of them woken — indistinguishable
  // from a quiet room. So a name that matches no participant fails here, at the writer, where
  // it can still be corrected, and the error names everyone who could have been meant.
  const addressed = parseTo(to)
  if (addressed.length) {
    const known = participants(room)
    const unknown = addressed.filter(n => !known.includes(n))
    if (unknown.length) throw new Error(
      `send: nobody in "${room}" is called ${unknown.map(n => `'${n}'`).join(", ")} — ` +
      `the room has: ${known.join(", ") || "(nobody yet)"}. ` +
      `A misspelt addressee is a message NOBODY is woken for; leave \`to\` out to address everyone.`)
  }
  const path = busFile(room, from)
  ensureDir(dirname(path))
  const ts = now()
  const head = `## ${ts} — ${type}${addressed.length ? ` → ${addressed.join(", ")}` : ""}${re ? ` (re: ${re})` : ""}`
  const body = escapeBodyHeaders(text.trim())
  appendFileSync(path, `${existsSync(path) && statSync(path).size ? "\n" : ""}${head}\n${body}\n`)
  // `from` is a SEAT, so the registry entry belongs to the project behind it. `writer` keeps
  // the seat as it is: sending a message may not reshuffle who sits where.
  const { coWriters, seatSession } = register({ agent: seatBase(from), writer: from, room })
  // Told to the WRITER, at the moment of writing: by the time the reader notices that one
  // sender is contradicting itself, the wrong instruction has already been acted on.
  //
  // ⚠ ONLY for a seat with no session (cron, a bare terminal, a non-Claude-Code client). A
  // seat that HAS one belongs to exactly one session by construction, and several live pids on
  // it are that session's own processes — the MCP server, the hook, the `sac wait` monitor.
  // Measured 2026-08-05 on the live bus: warning on those made an agent report "two writers on
  // one file" as a standing condition of the project. It was false, and a false alarm is worse
  // than none — it was reasoned from correctly, all the way to a wrong conclusion.
  const warning = coWriters.length && !seatSession
    ? `⚠ ${coWriters.length} other live process(es) write into the SAME file as \`${from}\` ` +
      `(pid ${coWriters.join(", ")}) — this name has no session id, so they share your file. ` +
      `The reader cannot tell your entries from theirs: say which thread you are, and do not ` +
      `assume an earlier entry under this name was yours.`
    : undefined
  // ── what this entry actually did, told to the writer, now ───────────────────
  // ⚠ The two failures left standing after the wake-up rule landed were both invisible at the
  // moment of writing, and both were measured rather than suspected:
  //
  //   · 2026-08-06, six live sessions: ALL FIVE entries were broadcast FACTs — including the one
  //     renaming an id that two other projects had to follow. A FACT wakes nobody, so the errand
  //     inside it waited for someone to happen to look. Every sender believed they had told the
  //     others.
  //   · The average entry on the live bus is 2168 characters and did not move when the rule did.
  //     Entries of 2701 and 3284 characters were still going out two days later, each read in
  //     full by every seat in the room.
  //
  // Neither is a thing the sender can look up afterwards, and neither is a thing to leave to good
  // intentions. So the server answers both here: who this woke, and how long it was. Reported,
  // never enforced — `send` refusing a message would be a far worse failure than a verbose one.
  const live = liveSeats(room)
  const entry = { ts, from, type, to: addressed, re }
  // ⚠ THE RULE'S DECISION IS RECORDED HERE, once per entry per live seat, because this is the
  // one place it is computed for everybody at once. Doing it in `inbox` instead would re-record
  // the same entries on every read; doing it in the watcher would miss every seat that has no
  // watcher armed — which is precisely the number worth having.
  const woke = live.filter(s => {
    if (s === from) return false
    const quiet = seatPresence(s).quiet
    const w = wakes(entry, s, ownTimestamps(room, s), quiet)
    recordDecision({ room, seat: s, entry: ts, by: quiet && isForMe(entry, s) ? "quiet" : "rule", woke: w })
    return w
  })
  const others = live.filter(s => s !== from).length
  const notice = []
  // A name is valid for as long as the registry remembers it, and the registry remembers a seat
  // long after its window closed — 25 of them for one project, measured. Addressing one of those
  // is not an error (the entry waits in the room, and a session that comes back reads it), but it
  // is not delivery either, and the difference is invisible unless it is said out loud.
  const dormant = addressed.filter(n => !live.some(s => isForMe({ to: [n] }, s)))
  if (dormant.length)
    notice.push(`No session of ${dormant.map(n => `'${n}'`).join(", ")} is running. The entry ` +
      `waits in the room and is read if that session comes back — \`agents\` lists who is live now.`)
  // ⚠ A QUIET ADDRESSEE BOUGHT NO ATTENTION, and that has to be visible at the moment of
  // writing, where it can still be redirected — the same argument as the two notices around it.
  // A seat that declared itself quiet is not gone (it reads the entry) and is not asleep by
  // accident (somebody chose it), so neither of those two notices covers it.
  const quieted = live.filter(s => s !== from && isForMe({ to: addressed }, s) && seatPresence(s).quiet)
  if (addressed.length && quieted.length) {
    notice.push(`Quiet: ${quieted.map(s => {
      const p = seatPresence(s)
      return `'${s}'${p.until ? ` until ${p.until}` : ""}`
    }).join(", ")} — the entry is delivered and read, but interrupts nobody there.`)
  }
  if (!woke.length && others)
    notice.push(`This wakes NOBODY — ${others} live seat(s) will read it when they next look. ` +
      `That is right for a fact nobody must act on. If someone has to DO something because of ` +
      `this, it needs \`to\` (one seat), or the QUESTION / REQUEST type.`)
  if (body.length > LONG_CHARS)
    notice.push(`${body.length} characters — every seat in the room reads all of it. The decision ` +
      `and what it changes for someone else is the message; the reasoning and the code are in the ` +
      `files, and they can read those.`)

  return { ts, room, from, type, to: addressed, path, wakes: woke,
           ...(notice.length && { notice }), ...(warning && { warning }) }
}

/**
 * Who can be addressed in this room — every writer file's seat, every seat of every agent
 * registered here, and the project names behind them.
 *
 * A remote seat carries its machine (`consumer-a@mac-mini#3f9c`); the bare project name is listed
 * too, because "I am talking to consumer-a" is a statement about the project, not about which of
 * its machines happens to hold the open window.
 */
/** The seats in a room that are not known to be gone — who an entry can still reach today. */
/**
 * The seats that could be woken by an entry in THIS room — per seat, never per project.
 *
 * ⚠ The room is read off the seat, not off the agent. The agent-level `rooms` list is a union
 * across all of that project's sessions, so testing it and then emitting every seat reports a
 * project's whole roster in every room it has ever joined. See `touchSeat` for the measurement.
 *
 * ⚠ A seat recorded before this rule existed carries no `rooms` and is therefore absent until it
 * next checks in. That is deliberate: the alternative — falling back to the agent's list — keeps
 * the defect alive for exactly the stale records that caused it. A live session re-registers on
 * SessionStart and on every `send`, so it reappears within one turn; one that never does was not
 * going to be woken anyway.
 */
export function liveSeats(room) {
  const reg = readJson(REGISTRY, { agents: {} })
  const out = []
  for (const a of Object.values(reg.agents)) {
    for (const [w, s] of Object.entries(a.seats || {})) {
      if (!(s.rooms || []).includes(room)) continue
      if (seatState(s) !== false) out.push(w)
    }
  }
  return out
}

/**
 * Forget the seats of windows that are long gone. THE REGISTRY ONLY — never a message file.
 *
 * ⚠ What this may not do is lose anything: a seat's entries are its file on disk, and that file
 * is the log. Pruning drops the *name* from the roster, so the room stops offering an addressee
 * that nothing will ever read, and `agents` stops describing a project by sessions that closed
 * days ago. Measured 2026-08-06: 32 seats in the registry, 25 of them one project's, 2 alive.
 *
 * Conservative on purpose — a seat is kept unless ALL of these hold: no live process on it, its
 * owning window is gone, and it has been silent longer than `days`. A session that is merely
 * closed for the evening is inside that window and keeps its name, its cursor and its focus.
 */
export function pruneSeats({ days = 7, keep = SEATS_KEPT_PER_AGENT, dry = false } = {}) {
  const cutoff = Date.now() - days * 86400_000
  const reg = readJson(REGISTRY, { agents: {} })
  const dropped = []
  for (const a of Object.values(reg.agents)) {
    for (const [name, s] of Object.entries(a.seats || {})) {
      const silent = (Date.parse(s.lastSeen) || 0) < cutoff
      if (seatState(s) === false && !(s.owner && alive(s.owner)) && silent) {
        delete a.seats[name]
        dropped.push({ seat: name, lastSeen: s.lastSeen ?? null })
      }
    }
    // …and then the same count cap `register` applies, so a project that has been checking in all
    // day is cut back here too. Age alone could not do it: measured 2026-08-08, this loop dropped
    // 0 of 302 seats because 193 of them were written the day before.
    const before = new Set(Object.keys(a.seats || {}))
    capDeadSeats(a.seats || {}, keep)
    for (const name of before) if (!(name in (a.seats || {}))) dropped.push({ seat: name, lastSeen: null })
  }
  if (dropped.length && !dry) writeJson(REGISTRY, reg)
  return { dropped, dry,
           kept: Object.values(reg.agents).reduce((n, a) => n + Object.keys(a.seats || {}).length, 0) }
}

/**
 * Every seat that is IN this room, whatever state it is in — membership read off the SEAT, never
 * off the agent, exactly as in `liveSeats`.
 *
 * This is `liveSeats` for a SCREEN: it keeps the ones known to be gone, because "closed" is
 * information an operator needs, while `liveSeats` answers "who could an entry reach today" and
 * must not offer them. A seat that has written into the room counts as in it — its file is the
 * proof, and it predates the per-seat room list.
 *
 * ⚠ It is deliberately NOT `participants`, which answers a different question — who may be
 * ADDRESSED — and includes project names and every seat of every project registered in the room.
 * Reported from `consumer-a` 2026-08-12: `sac rooms` listed all 14 seats of a project under a room
 * `liveSeats` correctly said held one, and it erred towards the reassuring answer: the screen
 * showed fourteen people in a room where there was one.
 */
export function roomSeats(room) {
  const names = new Set()
  for (const p of busFiles(room)) names.add(writerOf(p))
  const reg = readJson(REGISTRY, { agents: {} })
  for (const a of Object.values(reg.agents)) {
    for (const [w, s] of Object.entries(a.seats || {})) if ((s.rooms || []).includes(room)) names.add(w)
  }
  return [...names].sort()
}

export function participants(room) {
  const names = new Set()
  for (const p of busFiles(room)) { const w = writerOf(p); names.add(w); names.add(seatBase(w)) }
  const reg = readJson(REGISTRY, { agents: {} })
  for (const a of Object.values(reg.agents)) {
    if (!(a.rooms || []).includes(room)) continue
    names.add(a.agent)
    for (const s of Object.keys(a.seats || {})) { names.add(s); names.add(seatBase(s)) }
  }
  for (const n of [...names]) names.add(n.split("@")[0])
  return [...names].sort()
}

/**
 * Write an entry that arrived FROM ANOTHER MACHINE into the local room (see bridge.mjs).
 *
 * Once it is in the writer's file, nothing downstream can tell it apart from a local one:
 * `inbox`, the cursor, the Stop hook, `sac wait` all treat it the same. That is deliberate —
 * the network is a delivery detail, not a second kind of message.
 *
 * Idempotent on `(writer, ts)`, and that is what makes the whole remote leg safe: the bridge
 * may re-upload freely after a relay restart, because a duplicate is dropped here. The reverse
 * — being clever about not re-sending — would trade harmless duplicates for silent gaps.
 *
 * @returns true if it was new
 */
export function ingest({ room, writer, ts, type = "FACT", re, text, to }) {
  if (!room || !writer || !ts) throw new Error("ingest: `room`, `writer` and `ts` are required")
  if (!text?.trim()) throw new Error("ingest: empty message")
  assertSafeWriter(writer)
  assertSafeTs(ts)
  // The type is written into the header too, and an unknown one would make the entry
  // unparseable for every reader — including the sender's next `history`.
  type = normalizeType(type)
  if (!TYPES.includes(type)) throw new Error(`ingest: unknown type '${String(type).slice(0, 40)}'`)
  const path = busFile(room, writer)
  if (parse(path, writer).some(e => e.ts === ts)) return false
  ensureDir(dirname(path))
  // The addressee crosses the wire as written and is NOT validated here: the sender's room
  // membership is the sender's machine's business, and dropping an entry we cannot resolve
  // would turn an unknown name into a lost message.
  const addressed = parseTo(to)
  const head = `## ${ts} — ${normalizeType(type)}${addressed.length ? ` → ${addressed.join(", ")}` : ""}` +
    `${re ? ` (re: ${re})` : ""}`
  // Escaped on the RECEIVING side too, not merely trusted from the sender: the other machine may
  // be running an older build, or may not be a friend at all. What crosses the wire is normalised
  // where it lands (see `assertSafeTs`, which exists for the same reason and the same attacker).
  appendFileSync(path, `${existsSync(path) && statSync(path).size ? "\n" : ""}${head}\n${escapeBodyHeaders(text.trim())}\n`)
  noteRemote(writer, room)
  return true
}

/**
 * A remote participant in the registry, so `agents` can answer "who can I talk to" for them too.
 *
 * ⚠ No pid and no session: `lastSeen` is when the entry REACHED US, not the sender's clock —
 * clocks differ between machines, and this project has already paid once for a timestamp that
 * was not measured. Its liveness is therefore always "we don't know" or "silent for long",
 * never a confident `true`, which is the honest answer for a machine we cannot see.
 */
function noteRemote(writer, room) {
  const agent = seatBase(writer)
  const reg = readJson(REGISTRY, { agents: {} })
  const prev = reg.agents[agent] || {}
  const seats = { ...(prev.seats || {}) }
  seats[writer] = { ...(seats[writer] || {}), session: null, writers: {}, remote: true,
    rooms: [...new Set([...(seats[writer]?.rooms || []), room])],
    firstSeen: seats[writer]?.firstSeen || now(), lastSeen: now() }
  capDeadSeats(seats)
  reg.agents[agent] = {
    ...prev, agent, remote: true, host: agent.split("@")[1] || null,
    rooms: [...new Set([...(prev.rooms || []), room])],
    seats, firstSeen: prev.firstSeen || now(), lastSeen: now(),
  }
  writeJson(REGISTRY, reg)
}

/** The entries of one file, newest at the bottom (as they stand in the file). */
function parse(path, agent) {
  let raw
  try { raw = readFileSync(path, "utf8") } catch { return [] }
  const out = []
  let cur = null
  for (const line of raw.split("\n")) {
    const m = line.match(ENTRY_HEADER)
    if (m) {
      if (cur) out.push(cur)
      cur = { ts: m[1], type: normalizeType(m[2].trim()), to: parseTo(m[3]),
              re: m[4]?.trim() || null, from: agent, lines: [] }
    } else if (cur) cur.lines.push(line)
  }
  if (cur) out.push(cur)
  return out.map(e => ({ ...e, text: e.lines.join("\n").trim(), lines: undefined }))
}

/**
 * How far back a newly born seat still counts entries as UNREAD MAIL rather than history.
 *
 * ⚠ Measured 2026-08-04, 23:09, and it cost the very message this whole thing was built for.
 * A session sent a detailed REQUEST at 22:38; the other side was resumed half an hour later,
 * and the resume gave it a new session id, hence a new seat. The seeding rule then said "a
 * sibling's earlier entries are history" — and marked the 22:38 request READ before anyone
 * had seen it. The room was quiet, the cursor was correct, the request was gone.
 *
 * The rule was right in intent and wrong at the edge: what someone wrote HALF AN HOUR ago is
 * a live conversation, not history. Half an hour is a plausible gap between "I asked you" and
 * "you restarted"; an hour is a safe margin over it. What is older than that is what `history`
 * is for.
 */
const SEED_FRESH_MS = 60 * 60_000

/**
 * The read cursor of a NEWLY BORN seat. Called by `register` — at that point we know the room,
 * which `claimSeat` does not.
 *
 * The question it answers: how far has THE PROJECT already read this writer? Not "what does
 * one seat's cursor say" — a session-id name means every restart creates a new seat, so the
 * project's reading is spread across all of its past seats. We take the furthest of them.
 *
 *  - from a STRANGER: exactly that maximum. What the project has read is not unread for the
 *    session that just joined, and what nobody read stays unread.
 *  - from a SIBLING: the same maximum, but never further back than `SEED_FRESH_MS` — this is
 *    what keeps a 400-entry room from landing in a new session's inbox, while a request from
 *    half an hour ago still gets delivered.
 */
function seedCursor(room, writer) {
  const base = seatBase(writer)
  if (!room || writer === base) return
  const cursors = readJson(CURSORS, {})
  const key = `${room}::${writer}`
  if (cursors[key]) return                           // an existing seat keeps its own cursor
  const prefix = `${room}::${base}`
  const mine = Object.entries(cursors)
    .filter(([k]) => k === prefix || k.startsWith(`${prefix}#`))
    .map(([, v]) => v)

  const seen = {}
  const furthest = w => mine.reduce((best, c) => (c[w] && t(c[w]) > t(best) ? c[w] : best), null)
  for (const path of busFiles(room)) {
    const w = writerOf(path)
    if (w === writer) continue
    const read = furthest(w)
    if (seatBase(w) !== base) { if (read) seen[w] = read; continue }
    // A sibling: at most an hour of its past counts as unread — see SEED_FRESH_MS.
    const floor = now(new Date(Date.now() - SEED_FRESH_MS))
    seen[w] = !read || t(read) < t(floor) ? floor : read
  }
  cursors[key] = seen
  writeJson(CURSORS, cursors)
}

/**
 * New entries FROM OTHERS. Skips your own file — we do not read ourselves back.
 * With `advance: true` the cursor moves forward (marks them read).
 *
 * `agent` here is a SEAT: another session of the same project is "someone else", so its
 * messages are delivered, and every seat has its own cursor. Before seats, both were false:
 * the sibling's file counted as "my own file" and the shared cursor meant whichever session
 * read first marked the message read for the other one too.
 *
 * ADDRESSING CHANGES NOTHING ABOUT DELIVERY. Every entry is returned, including one addressed
 * to someone else — `forMe: false` marks it, and the room stays readable to everyone in it,
 * which is the point of a room. What the addressee decides is who gets WOKEN (`sac wait`, the
 * Stop hook); reading is never the thing we restrict, because a reader who cannot see what the
 * others agreed on is how two sessions end up doing the same work twice.
 */
/**
 * A long entry that is NOT entitled to interrupt you, shortened to its opening.
 *
 * ⚠ What is never clipped: anything with `wakes: true`. Reading half of a question you have to
 * answer is worse than reading all of one you do not — so the cut falls only where the entry was
 * already "read it if it is useful to you", which is what a broadcast FACT is by construction.
 *
 * It cuts at a paragraph or sentence boundary when one is near the limit, because a line severed
 * mid-clause reads as data loss rather than as a summary, and it says how much is missing and
 * where to get it. `history` returns every entry whole and is one call away.
 */
function clip(e) {
  if (e.wakes || !INBOX_CHARS || e.text.length <= INBOX_CHARS) return e
  const cut = e.text.slice(0, INBOX_CHARS)
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "))
  const head = (at > INBOX_CHARS * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd()
  return { ...e, clipped: e.text.length,
           text: `${head}\n\n… +${e.text.length - head.length} characters — \`history\` for the whole entry` }
}

/**
 * `respectQuiet` — ⚠ THE TWO WAKE-UP PATHS DO NOT COST THE SAME, and `quiet` belongs to only one
 * of them. Caught 2026-08-11 by `set-agent-comm#f7195843` reading this code, hours after it was
 * written:
 *
 *   · `sac wait` starts a turn WHILE THE AGENT IS WORKING. That is the interruption a person
 *     asks to stop, and it is what `quiet` is for.
 *   · the Stop hook runs only where the turn was ending anyway. It cannot interrupt anything —
 *     and it is the last safety net before a session goes away.
 *
 * Applying quiet to both meant a silent seat could stop with an unread REQUEST addressed to it,
 * and if that session never came back, "not right now" quietly became "never" — permanently, for
 * a `quiet` with no expiry. So the Stop hook passes `respectQuiet: false`: it is the one reader
 * that still sees what the seat owes an answer to.
 */
export function inbox({ room, agent, advance = true, limit = 20, respectQuiet = true }) {
  const cursors = readJson(CURSORS, {})
  const key = `${room}::${agent}`
  const base = seatBase(agent)
  // Read ONCE for the whole call: `wakes` needs to know what this seat asked, and re-reading
  // its own file per entry would turn a linear pass into a quadratic one on a busy room. The
  // same argument applies to the seat's declared presence, so it is read here and passed down.
  const mine = ownTimestamps(room, agent)
  const quiet = respectQuiet && seatPresence(agent).quiet
  // A seat with no cursor of its own (nobody registered it) falls back to the base seat's —
  // erring towards "unread" rather than swallowing the first message.
  const seen = cursors[key] || (agent === base ? {} : { ...(cursors[`${room}::${base}`] || {}) })
  const fresh = []
  for (const path of busFiles(room)) {
    const writer = writerOf(path)
    if (writer === agent) continue
    for (const e of parse(path, writer)) {
      // By time, not by string — the same trap as with sorting.
      if (!seen[writer] || t(e.ts) > t(seen[writer]))
        fresh.push({ ...e, forMe: isForMe(e, agent), wakes: wakes(e, agent, mine, quiet),
                     ...(seatBase(writer) === base && { sibling: true }) })
    }
  }
  fresh.sort(byTime)
  const shown = fresh.slice(-limit).map(clip)
  if (advance && fresh.length) {
    for (const e of fresh) seen[e.from] = seen[e.from] && t(seen[e.from]) > t(e.ts) ? seen[e.from] : e.ts
    cursors[key] = seen
    writeJson(CURSORS, cursors)
  }
  // Counted over ALL fresh entries, not just the page shown — the wake-up paths (`sac wait`,
  // the Stop hook) decide on these numbers, and deciding on a truncated count is how a message
  // addressed to you would fail to wake you.
  //
  // THREE counts, because they answer three different questions and the middle one used to
  // stand in for the last: `unread` is what is in the room for you to read, `unreadForMe` what
  // is not aimed past you, and `unreadWaking` what is entitled to interrupt you. Only the third
  // may ever start a turn (see `wakes`).
  return {
    room, agent,
    unread: fresh.length,
    unreadForMe: fresh.filter(e => e.forMe).length,
    unreadWaking: fresh.filter(e => e.wakes).length,
    truncated: fresh.length - shown.length,
    messages: shown,
  }
}

/**
 * REWIND the cursor — the last `count` messages become unread again.
 *
 * A measured need (2026-08-03, the day it went live): an `inbox` call made for a demo
 * swallowed the only message in the room, and there was no way to bring it back. `inbox`
 * advancing is deliberate — being irreversible is not: otherwise "I have read it" and
 * "it was lost" are indistinguishable. (The entries themselves are never lost; only the
 * mark is restored.)
 */
export function unread({ room, agent, count = 1 }) {
  const cursors = readJson(CURSORS, {})
  const key = `${room}::${agent}`
  const all = []
  for (const path of busFiles(room)) {
    const writer = writerOf(path)
    if (writer !== agent) all.push(...parse(path, writer))
  }
  all.sort(byTime)
  const back = new Set(all.slice(-count))
  const seen = {}
  for (const e of all) {
    if (back.has(e)) continue
    if (!seen[e.from] || t(e.ts) > t(seen[e.from])) seen[e.from] = e.ts
  }
  cursors[key] = seen
  writeJson(CURSORS, cursors)
  return { room, agent, restored: Math.min(count, all.length) }
}

/**
 * Reading back — does NOT move the cursor.
 *
 * `from` may name a project (`consumer-a`) or one seat of it (`consumer-a#968f89d7`). The project name
 * returns ALL its sessions: "what did consumer-a say" is a question about the project, and
 * answering it with one session's half of the thread would be a silent half-truth.
 */
export function history({ room, from, limit = 20 }) {
  const files = from
    ? busFiles(room).filter(p => writerOf(p) === from || seatBase(writerOf(p)) === from)
    : busFiles(room)
  const all = files.flatMap(p => parse(p, writerOf(p)))
  all.sort(byTime)
  return { room, total: all.length, messages: all.slice(-limit) }
}

// ── nudging ───────────────────────────────────────────────────────────────────

/**
 * "Have we already told this seat about this entry?" — true means it is NEW and worth saying.
 *
 * This is what makes a `Stop` hook safe. Claude Code's Stop hook may block the end of a turn
 * (`decision: "block"`), and there is NO `stop_hook_active` field to break the cycle: if the
 * hook blocked every time it saw an unread message, an agent that does not read it — because
 * it has no MCP tool, or is doing something else — would be stuck in a loop forever.
 *
 * So we nudge ONCE per entry. If the agent reads it, good; if it does not, it is not held
 * hostage. The message is not lost either way: it stays unread until the cursor advances.
 * A nudge is not a delivery — it never touches the cursor.
 *
 * ⚠ IT LIVES ON DISK, and that is the whole point — measured 2026-08-06 in session
 * `consumer-a#6cd8f60e`. `sac wait` kept its own ledger in a variable, so every restart of the
 * monitor process re-announced the entire backlog: the same three notifications, byte for byte,
 * 32 seconds apart, one of them reading "48 unread FOR YOU". Nineteen wake-ups in one session,
 * on a day when nobody had written a single new entry. A ledger that does not survive the
 * process that keeps it is not a ledger.
 *
 * @param via which watcher is asking. The Stop hook and the monitor keep SEPARATE ledgers: they
 *   catch different states (working / idle), and one having spoken is no reason for the other to
 *   stay silent. `stop` keeps the un-suffixed key, so ledgers written before this existed stand.
 */
export function shouldNudge({ room, agent, ts, via = "stop" }) {
  const all = readJson(NUDGES, {})
  const key = `${room}::${agent}${via === "stop" ? "" : `::${via}`}`
  if (all[key] && t(all[key]) >= t(ts)) return false
  all[key] = ts
  writeJson(NUDGES, all)
  return true
}

/**
 * True exactly ONCE per key, ever — on the same on-disk ledger the nudges use.
 *
 * For the things that are worth saying to a session once and are noise the second time. It has to
 * be on disk for the same reason `shouldNudge` does: a hook is a fresh process every time, so
 * anything remembered in memory is remembered for the length of one invocation.
 */
export function firstTime(key) {
  const all = readJson(NUDGES, {})
  if (all[key]) return false
  all[key] = now()
  writeJson(NUDGES, all)
  return true
}

// ── focus: what each seat is working on ───────────────────────────────────────

/**
 * A seat's DECLARED SCOPE, in one sentence, plus the paths it is in.
 *
 * Two jobs, and it was built for both at once:
 *
 *  1. It is what the letterbox reasons about (see `triage.mjs`). A cheap model cannot tell
 *     whether an entry concerns this agent without knowing what this agent is doing; without a
 *     focus it has only the room's history to guess from.
 *
 *  2. It REPLACES a conversation. Measured over the first two days: 46 entries in `consumer-a-atlas`
 *     carried scope-negotiation ("hatókör", "ki mit csinál", "ne ütközzünk") — agents spending
 *     turns, in a broadcast that woke everyone, to establish who was touching what. That is a
 *     lookup, not a discussion: `agents` now reports it, so the answer costs one tool call and
 *     wakes nobody.
 *
 * Kept per SEAT, not per project: two sessions of one project are exactly the pair that needs to
 * know they are in different files.
 */
const FOCUS_STALE_MS = 4 * 60 * 60_000

/**
 * ⚠ THE PHASE IS DECLARED, NEVER INFERRED — added 2026-08-17 on a measurement from `set-core`,
 * which asked for it while building a screen of every running agent (FleetView).
 *
 * They tried to READ the phase out of the session log first, and published the number: in a
 * session that spent its whole life on OpenSpec work, the obvious signal — an `/opsx:` slash
 * command in the log — matched **0 times**. Most work does not start from a slash command. A
 * guessed phase is therefore wrong exactly when the situation is unusual, and the unusual
 * situation is the only reason anybody looks at such a screen.
 *
 * So it lives here, next to `focus`, because it is the same act: a thing the agent says ABOUT
 * ITSELF. It gets the same writer, the same staleness rule, and the same fate when it ages out.
 *
 * A CLOSED, TINY VOCABULARY, and an unknown word is an ERROR rather than a pass-through. Free
 * text is what `focus.text` already is; the point of this field is that a program can branch on
 * it, and a field that admits anything is one a program must go back to guessing about.
 *
 * ⚠ THE AXIS IS WHAT AN INTERRUPTION COSTS — not what methodology anybody follows. That is what
 * makes the list reusable by a project that works differently, and it is why the field belongs in
 * THIS store at all: whether to spend somebody's turn is the question this project exists to answer.
 *
 *   explore  cheap to interrupt, and the direction is still open
 *   plan     cheap — and this is the moment when influencing it is worth anything
 *   apply    expensive: a turn spent here costs work in progress
 *   verify   expensive, and nearly done — whatever you say arrives after the fact
 *   blocked  PLEASE interrupt: it cannot proceed, and `focus.text` says on what
 *
 * A project whose stages are named differently maps onto this by asking "what would interrupting
 * me right now cost", never "which step of my methodology is this".
 *
 * ⚠ THE LIST IS CLOSED ON PURPOSE — recorded 2026-08-17 because `set-core` asked whether it was,
 * which is the right question to ask before building on it. They proposed a closed core plus a
 * free-text label beside it. Declined, on their own argument: a label only a person reads is
 * `focus.text` again, and a label that programs group by is a vocabulary that grows without
 * anybody deciding to grow it — "the bad case is when it grows quietly", in their words. The
 * escape hatch is the sentence, which every reader already shows.
 *
 * They also asked for a sixth word, `review`, for a long gate-and-code-review stretch. Declined
 * for the same reason: on the axis above it answers exactly what `verify` answers, so no reader
 * branches differently on it — and a word that changes no decision turns the list into a taxonomy
 * of how one project works. That stretch is a sentence: "gates running, 19 minutes in".
 *
 * ⚠ IT DOES NOT SURVIVE A RE-DECLARATION. Restate the sentence without `phase` and the phase is
 * GONE, not carried over. A sentence and a phase declared at different moments is precisely the
 * lie this field exists to avoid — and "we do not know" is this project's honest default
 * everywhere else (`seatState`, `silentMinutes`). One word is cheap to say again.
 *
 * ⚠ AND IT DOES NOT WAKE ANYBODY. `wakes()` reads `quiet` and nothing else; routing a turn on a
 * phase would be a delivery change with no measurement behind it. This is for readers.
 */
export const PHASES = ["explore", "plan", "apply", "verify", "blocked"]

export function setFocus({ agent, text, files, phase }) {
  if (!agent) throw new Error("focus: `agent` is required")
  if (phase != null && !PHASES.includes(phase)) {
    throw new Error(`focus: unknown phase '${phase}' — one of: ${PHASES.join(", ")}`)
  }
  const all = readJson(FOCUS, {})
  // `text: undefined` is NOT a clear — the MCP face has drawn that line since the field existed
  // ("no `text` at all is a QUERY"), and the phase inherits it: naming only the phase re-declares
  // the standing sentence, which is the common case (the phase turns over, the sentence does not).
  // The timestamp moves with it, because saying "I am verifying now" IS a fresh declaration of
  // the whole thing. `text: ""` still clears, as before.
  if (text === undefined && phase != null) {
    const prev = all[agent]
    if (!prev) throw new Error("focus: say what you are working on first — a phase on its own declares nothing")
    all[agent] = { ...prev, phase, ts: now() }
    writeJson(FOCUS, all)
    return { agent, ...all[agent] }
  }
  if (!text?.trim()) { delete all[agent]; writeJson(FOCUS, all); return { agent, cleared: true } }
  all[agent] = {
    text: text.trim(),
    files: [...new Set((Array.isArray(files) ? files : String(files ?? "").split(","))
      .map(s => String(s).trim()).filter(Boolean))],
    ...(phase != null && { phase }),
    ts: now(),
  }
  writeJson(FOCUS, all)
  return { agent, ...all[agent] }
}

/**
 * What a seat said it was doing — with `stale: true` once it is old enough to be a lie.
 * A four-hour-old focus is reported, never silently dropped: "they said X, four hours ago" is
 * usable, "we know nothing" is not, and pretending the two are the same throws away the only
 * fact we have.
 */
export function getFocus(agent) {
  const f = readJson(FOCUS, {})[agent]
  if (!f) return null
  const ageMs = Date.now() - (Date.parse(f.ts) || 0)
  return { ...f, ageMinutes: Math.round(ageMs / 60000), stale: ageMs > FOCUS_STALE_MS }
}

/** Existing rooms. */
export function rooms() {
  try { return readdirSync(CHANNELS).filter(d => !d.startsWith(".")).sort() } catch { return [] }
}

// ── declared state: rooms, membership, presence ───────────────────────────────
//
// ⚠ EVERYTHING ELSE ON THIS BUS IS DERIVED, and 2026-08-10 found the edge of that. A room was
// derived from somebody writing into it, membership from `SET_AGENT_ROOM` read at session start,
// presence from a heartbeat. Derivation is why this core has no dependencies — but there is
// nowhere to put a fact that CONTRADICTS the derivation, and three of those turned up in eight
// days of live use: a session that wants to leave the conversation (indistinguishable from a
// dead one), a fourth session that belongs in a different room from its three siblings, and a
// mistyped room name that becomes a new silent room instead of an error.
//
// ⚠ THREE SMALL FILES, NOT THREE MORE KEYS IN `registry.json`. The registry is rewritten whole
// on every `register()`, and the heartbeat work already measured that as a lost-update race
// between concurrent sessions — which is why the heartbeat rate-limits to 60 s. Membership and
// presence change at moments a PERSON chose, and must not be lost to somebody else's check-in.

/**
 * Does this room exist?
 *
 * ⚠ THE CHANNEL DIRECTORY IS THE FALLBACK, and that is the whole migration: every room in every
 * existing store keeps existing, with no migration step and no dated file to write. A migration
 * that rewrote a shared file from a directory listing, triggered by whichever process happened
 * to run first, would have to be right the first time on a store we cannot see.
 */
export function roomExists(room) {
  if (!room) return false
  if (readJson(ROOMS_FILE, {})[room]) return true
  try { return statSync(join(CHANNELS, room)).isDirectory() } catch { return false }
}

/** Create a room on purpose. Idempotent: an existing room keeps its original creator. */
export function createRoom(room, by) {
  const all = readJson(ROOMS_FILE, {})
  if (all[room]) return { room, created: false, ...all[room] }
  const rec = { by: by || null, at: now() }
  all[room] = rec
  writeJson(ROOMS_FILE, all)
  ensureDir(join(CHANNELS, room))
  return { room, created: true, ...rec }
}

/** Every room this store knows about — declared or merely written into. */
export function knownRooms() {
  return [...new Set([...Object.keys(readJson(ROOMS_FILE, {})), ...rooms()])].sort()
}

/**
 * The rooms this SEAT is in. `null` means "this seat has never been seeded", which is different
 * from "this seat is in no rooms" (`[]`) — the first takes the configured default, the second is
 * a person's decision to leave, and collapsing them would silently undo `part` on the next hook.
 */
export function members(seat) {
  const rec = readJson(MEMBERS, {})[seat]
  if (Array.isArray(rec)) return rec                       // the first shape this file had
  return Array.isArray(rec?.rooms) ? rec.rooms : null
}

/**
 * ⚠ LEAVING IS REMEMBERED, not merely applied. The SessionStart hook calls `register` once per
 * configured room on EVERY start, so a membership that only recorded what a seat is in would
 * have `part` undone by the next hook run — with nothing to show for it. Recording the rooms a
 * seat has explicitly left is what makes the decision stick, and it is the smallest thing that
 * can: two lists instead of one.
 */
const leftRooms = seat => {
  const rec = readJson(MEMBERS, {})[seat]
  return Array.isArray(rec?.left) ? rec.left : []
}

export function setMembers(seat, list, left = null) {
  const all = readJson(MEMBERS, {})
  const prev = all[seat]
  all[seat] = {
    rooms: [...new Set(list.filter(Boolean))].sort(),
    left: [...new Set((left ?? (Array.isArray(prev?.left) ? prev.left : [])).filter(Boolean))].sort(),
  }
  writeJson(MEMBERS, all)
  return all[seat].rooms
}

/**
 * Seed a seat's membership from a configured room — on first check-in, and for a room it has
 * not deliberately left.
 *
 * ⚠ The environment may ADD, but it may never restore what somebody removed. That asymmetry is
 * the whole point: changing a project's configured rooms no longer moves the seats that already
 * exist against their will, which is what lets a fourth session live somewhere else.
 */
export function seedMembers(seat, configured) {
  const have = members(seat)
  const left = leftRooms(seat)
  const add = (configured || []).filter(r => !left.includes(r))
  if (have === null) return setMembers(seat, add)
  const missing = add.filter(r => !have.includes(r))
  return missing.length ? setMembers(seat, [...have, ...missing]) : have
}

export function joinRoom(seat, room) {
  const rooms = setMembers(seat, [...(members(seat) || []), room], leftRooms(seat).filter(r => r !== room))
  // Both halves, always — see `unregisterRoom`. A membership only the member can see is not one.
  registerRoom(seat, room)
  return rooms
}

/**
 * Put a room on this SEAT's registry record — the roster half of `join`, and the exact inverse of
 * `unregisterRoom`. It only ever EXTENDS a record that already exists: naming a seat is
 * `claimSeat`'s job, and inventing one here would let a stray join conjure a session that never
 * ran. A `sac join` from a live session goes through `register` as well, which does create it.
 */
export function registerRoom(seat, room) {
  const reg = readJson(REGISTRY, { agents: {} })
  let changed = false
  for (const a of Object.values(reg.agents)) {
    const s = (a.seats || {})[seat]
    if (!s || (s.rooms || []).includes(room)) continue
    s.rooms = [...(s.rooms || []), room]
    changed = true
  }
  if (changed) writeJson(REGISTRY, reg)
  return changed
}

export function partRoom(seat, room) {
  const rooms = setMembers(seat, (members(seat) || []).filter(r => r !== room), [...leftRooms(seat), room])
  unregisterRoom(seat, room)
  return rooms
}

/**
 * Take a room off this SEAT's registry record — the half of `part` everybody else can see.
 *
 * ⚠ Membership lives in two files, and only one of them is read by the others. `members.json` is
 * the seat's own book; the ROSTER (`liveSeats`, `roomSeats`, and so `send`'s wake report) is the
 * registry. Measured 2026-08-12: after `sac part uj`, `members` no longer had the room and
 * `liveSeats("uj")` still named the seat — the leaving was invisible to every other session,
 * which is the same defect as a `join` nobody could see, in the other direction.
 *
 * The AGENT-level `rooms` list is deliberately left alone: the project stays addressable in the
 * room (that is what `participants` answers), and another seat of it may well still be in there.
 */
export function unregisterRoom(seat, room) {
  const reg = readJson(REGISTRY, { agents: {} })
  let changed = false
  for (const a of Object.values(reg.agents)) {
    const s = (a.seats || {})[seat]
    if (!s || !(s.rooms || []).includes(room)) continue
    s.rooms = s.rooms.filter(r => r !== room)
    changed = true
  }
  if (changed) writeJson(REGISTRY, reg)
  return changed
}

/**
 * A seat's DECLARED presence — the fourth state, and the only one of the four that somebody
 * chose rather than something derived.
 *
 * ⚠ THIS IS NOT A FOURTH VALUE OF `seatState`. That function keeps answering `true` / `null` /
 * `false`, where `null` means "we do not know"; every consumer treats those three distinctly and
 * correctly, and a fourth value would silently reclassify a quiet seat inside every one of them.
 *
 * ⚠ An expiry in the past is simply absent. Quiet is a timestamp on disk, not a timer: nothing
 * may depend on a process being alive to end it, because the session that set it is often not
 * the one that outlives it.
 */
export function seatPresence(seat) {
  const rec = readJson(PRESENCE, {})[seat]
  if (!rec?.quiet) return { quiet: false, until: null }
  if (rec.until && Date.parse(rec.until) <= Date.now()) return { quiet: false, until: null, expired: true }
  return { quiet: true, until: rec.until || null, since: rec.since || null }
}

/** Declare (or clear) quiet for a seat. `until` is an ISO stamp, or null for open-ended. */
export function setQuiet(seat, { quiet = true, until = null } = {}) {
  const all = readJson(PRESENCE, {})
  if (!quiet) delete all[seat]
  else all[seat] = { quiet: true, since: now(), ...(until ? { until } : {}) }
  writeJson(PRESENCE, all)
  return seatPresence(seat)
}

// ── the ledger: what an entry actually cost ───────────────────────────────────
//
// ⚠ THIS PROJECT'S THESIS IS THAT BEING READ IS CHEAP AND BEING WOKEN IS EXPENSIVE, and until
// now there was no number for either: `wakes` was computed and thrown away, the letterbox's
// verdicts were never kept, and every figure in the field notes is therefore a proxy. A tool
// whose whole argument is a cost cannot demonstrate that cost.
//
// ⚠ ONE FILE PER SEAT, APPEND-ONLY — the same invariant as the channel, for the same reason. A
// shared ledger would be the lost update the channel design exists to avoid, and would need the
// lockfile this project refuses to have. It is also the only shape a hook can append to on the
// hot path without reading anything first.
//
// ⚠ IT NEVER BLOCKS, NEVER THROWS, NEVER PRINTS. Same rule as the heartbeat: this sits on the
// PostToolUse path and inside the long poll, and a measurement that can break the thing it
// measures is worse than no measurement. Every failure here is a dropped line.
const STATS = join(ROOT, "stats")
const STATS_MAX_BYTES = 512 * 1024

const statsFile = seat => join(STATS, `${String(seat).replace(/[/\\]/g, "_")}.jsonl`)

/** Append one record. Silent on every failure, including a store that is not writable at all. */
function ledgerAppend(seat, rec) {
  try {
    ensureDir(STATS)
    const path = statsFile(seat)
    // Bounded here rather than by a command someone has to remember to run. Checked before the
    // append because a `statSync` is cheap and a runaway ledger is not: the measured shape of
    // this store is one project minting ~27 seats an hour, which no time window bounds.
    try {
      if (statSync(path).size > STATS_MAX_BYTES) {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
        writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n")
      }
    } catch { /* not there yet, or unreadable — the append below decides */ }
    appendFileSync(path, JSON.stringify({ at: now(), ...rec }) + "\n")
  } catch { /* a dropped measurement is not a reason to fail a turn */ }
}

/**
 * One waking DECISION, recorded where it was made.
 *
 * `by` is what decided: `rule` · `letterbox` · `net` · `quiet` · `letterbox-failed`. The last is
 * deliberately distinct from a letterbox that answered yes — an entry that woke somebody because
 * the classifier timed out is not the same fact as one it judged, and collapsing them would hide
 * exactly the number that says whether the letterbox is worth its cost.
 */
export function recordDecision({ room, seat, entry, by, woke }) {
  ledgerAppend(seat, { k: "decision", room, entry, by, woke: !!woke })
}

/**
 * A wake-up that actually reached a session — recorded where it was DELIVERED, which is a
 * different fact from the decision above. A decision with no matching delivery is a seat that was
 * judged worth waking and had no watcher armed: the README calls that the weakest link in the
 * chain, and this is the first time it produces a number.
 */
export function recordWake({ room, seat, entry, how }) {
  ledgerAppend(seat, { k: "wake", room, entry, how })       // how: "announced" | "blocked"
}

/** Everything the ledger holds, oldest first. Unparseable lines are skipped, never fatal. */
export function readLedger({ since = null } = {}) {
  const out = []
  let files = []
  try { files = readdirSync(STATS).filter(f => f.endsWith(".jsonl")) } catch { return out }
  for (const f of files) {
    const seat = f.slice(0, -6)
    let text = ""
    try { text = readFileSync(join(STATS, f), "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (since && t(rec.at) < t(since)) continue
        out.push({ seat, ...rec })
      } catch { /* a corrupt line is skipped, and the rest of the file still counts */ }
    }
  }
  return out.sort((a, b) => t(a.at) - t(b.at))
}

/**
 * What the bus cost, per room. READ-ONLY: it moves no cursor and marks nothing read, like the
 * admin view — and it reports the window it actually covers, because the ledger is bounded and a
 * number whose window is unstated is a number that will be misread.
 */
export function stats({ rooms: only = null, since = null } = {}) {
  const recs = readLedger({ since })
  const perRoom = {}
  const bump = (room) => (perRoom[room] ??= {
    room, entries: 0, chars: 0, clipped: 0,
    decisions: { rule: 0, letterbox: 0, net: 0, quiet: 0, "letterbox-failed": 0 },
    woke: 0, announced: 0, blocked: 0, seats: {},
  })
  for (const r of recs) {
    if (only?.length && !only.includes(r.room)) continue
    const room = bump(r.room || "(unknown)")
    room.seats[r.seat] ??= { decisions: 0, woke: 0, announced: 0, blocked: 0 }
    if (r.k === "decision") {
      room.decisions[r.by] = (room.decisions[r.by] || 0) + 1
      room.seats[r.seat].decisions++
      if (r.woke) { room.woke++; room.seats[r.seat].woke++ }
    } else if (r.k === "wake") {
      if (r.how === "blocked") { room.blocked++; room.seats[r.seat].blocked++ }
      else { room.announced++; room.seats[r.seat].announced++ }
    }
  }
  // Entries and characters come from the channel itself — the ledger records decisions, never
  // what was said. Keeping the two apart is what lets `stats` stay something you can run on
  // somebody else's room without reading their traffic.
  for (const room of (only?.length ? only : knownRooms())) {
    const h = history({ room, limit: 100000 })
    const r = bump(room)
    for (const m of h.messages) {
      if (since && t(m.ts) < t(since)) continue
      r.entries++
      r.chars += (m.text || "").length
      if ((m.text || "").length > INBOX_CHARS && INBOX_CHARS) r.clipped++
    }
  }
  return {
    window: recs.length ? { from: recs[0].at, to: recs[recs.length - 1].at } : null,
    records: recs.length,
    rooms: Object.values(perRoom).sort((a, b) => a.room.localeCompare(b.room)),
  }
}
