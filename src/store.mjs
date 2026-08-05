// The core: registry (who exists, who is alive) + channel (who said what).
// Zero runtime dependencies — hooks and cron call this too, where there is no node_modules.
//
// Protocol (extracted from the consumer-a ↔ set-core channel, run in on 400 entries):
// ONE FILE, ONE WRITER. Everyone appends to their own file only, and reads the others'.
// That way there is no lost update and no lockfile is needed — after a session dies the
// lock would stay stuck, and from then on nobody would write.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync,
         existsSync, renameSync, openSync, fsyncSync, closeSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, hostname } from "node:os"

export const ROOT = process.env.SET_AGENT_COMM_DIR
  || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "set-agent-comm")

const REGISTRY = join(ROOT, "registry.json")
const CHANNELS = join(ROOT, "channels")
const CURSORS = join(ROOT, "cursors.json")
const NUDGES = join(ROOT, "nudges.json")

export const TYPES = ["QUESTION", "ANSWER", "FACT", "REQUEST"]

/**
 * The entry type lives ON DISK, so the pre-English keywords are still out there in existing
 * channels. Both directions accept them: `send` normalises them, `parse` maps them on read.
 * A rename is not a reason to make already written entries unreadable.
 */
const LEGACY_TYPES = { "KÉRDÉS": "QUESTION", "VÁLASZ": "ANSWER", "TÉNY": "FACT", "KÉRÉS": "REQUEST" }
export const normalizeType = type => LEGACY_TYPES[type] || type

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

// ── atomic JSON write ─────────────────────────────────────────────────────────
// tmp → fsync → rename. On a crash `writeFileSync` leaves truncated JSON in the target file,
// and from then on the registry is unreadable — a pattern borrowed from AMQ.
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
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

/** Record this process on the seat, and forget the processes that have exited. */
function touchSeat(seats, name, { session = null, pid }) {
  const held = seats[name]
  // A seat held by ANOTHER session is not ours to inherit — start a fresh record. Without a
  // session id we do not overwrite the holder: the CLI must not evict a live session.
  const prev = held && (!session || !held.session || held.session === session) ? held : {}
  const writers = { ...(prev.writers || {}), [pid]: now() }
  for (const p of Object.keys(writers)) if (Number(p) !== pid && !alive(Number(p))) delete writers[p]
  seats[name] = {
    session: session ?? prev.session ?? null,
    writers,
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
export function claimSeat({ agent, session, pid = process.pid }) {
  if (!agent) throw new Error("claimSeat: `agent` is required")
  if (!session) return agent
  const reg = readJson(REGISTRY, { agents: {} })
  const rec = (reg.agents[agent] ||= { agent })
  const seats = (rec.seats ||= {})
  const name = seatFor(seats, agent, session)
  touchSeat(seats, name, { session, pid })
  writeJson(REGISTRY, reg)
  return name
}

/** The shortest form of the id that is not already held by a DIFFERENT session. */
function seatFor(seats, agent, session) {
  for (const len of SEAT_LENGTHS) {
    const name = seatName(agent, session, len)
    if (!seats[name] || seats[name].session === session) return name
  }
  return seatName(agent, session, session.length)
}

/**
 * Which seat is this session's — WITHOUT claiming one. For read-only callers.
 *
 * ⚠ Measured while it was being built: `sac agents`, a pure query, claimed itself a seat,
 * because the CLI inherits `CLAUDE_CODE_SESSION_ID` from whatever started it — a listing
 * therefore invented a third session in a project that had two. Reading may not change the
 * state it reports on.
 */
export function seatOf({ agent, session }) {
  if (!session) return agent
  const seats = readJson(REGISTRY, { agents: {} }).agents?.[agent]?.seats || {}
  return Object.keys(seats).find(n => seats[n].session === session) || seatFor(seats, agent, session)
}

/**
 * An agent checking in. Idempotent: the same name is updated, not duplicated.
 *
 * With a `session` the check-in claims a seat (see `claimSeat`); `writer` skips the claim for
 * a seat that is already known — `send` uses that, so writing a message never reshuffles seats.
 */
export function register({ agent, project, session, room, pid = process.pid, writer }) {
  if (!agent) throw new Error("register: `agent` is required")
  const seat = writer || (session ? claimSeat({ agent, session, pid }) : agent)
  const reg = readJson(REGISTRY, { agents: {} })
  const prev = reg.agents[agent] || {}
  const seats = { ...(prev.seats || {}) }
  const mine = touchSeat(seats, seat, { session, pid })

  reg.agents[agent] = {
    ...prev,
    agent,
    project: project ?? prev.project ?? null,
    session: session ?? prev.session ?? null,
    host: hostname(),
    rooms: [...new Set([...(prev.rooms || []), ...(room ? [room] : [])])],
    seats,
    firstSeen: prev.firstSeen || now(),
    lastSeen: now(),
  }
  writeJson(REGISTRY, reg)
  seedCursor(room, seat)
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
    const seats = Object.entries(a.seats || {}).map(([writer, s]) => ({
      writer, session: s.session ?? null, live: seatState(s), lastSeen: s.lastSeen ?? null,
      lastWrote: lastWrote(writer, a.rooms || []),
    }))
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

// ── channel ───────────────────────────────────────────────────────────────────

export const channelDir = room => join(CHANNELS, room)
export const busFile = (room, agent) => join(channelDir(room), `${agent}.md`)
const writerOf = path => path.split("/").pop().replace(/\.md$/, "")

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
  mkdirSync(dirname(path), { recursive: true })
  const ts = now()
  const head = `## ${ts} — ${type}${addressed.length ? ` → ${addressed.join(", ")}` : ""}${re ? ` (re: ${re})` : ""}`
  const body = text.trim()
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
  return { ts, room, from, type, to: addressed, path, ...(warning && { warning }) }
}

/**
 * Who can be addressed in this room — every writer file's seat, every seat of every agent
 * registered here, and the project names behind them.
 *
 * A remote seat carries its machine (`consumer-a@mac-mini#3f9c`); the bare project name is listed
 * too, because "I am talking to consumer-a" is a statement about the project, not about which of
 * its machines happens to hold the open window.
 */
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
  const path = busFile(room, writer)
  if (parse(path, writer).some(e => e.ts === ts)) return false
  mkdirSync(dirname(path), { recursive: true })
  // The addressee crosses the wire as written and is NOT validated here: the sender's room
  // membership is the sender's machine's business, and dropping an entry we cannot resolve
  // would turn an unknown name into a lost message.
  const addressed = parseTo(to)
  const head = `## ${ts} — ${normalizeType(type)}${addressed.length ? ` → ${addressed.join(", ")}` : ""}` +
    `${re ? ` (re: ${re})` : ""}`
  appendFileSync(path, `${existsSync(path) && statSync(path).size ? "\n" : ""}${head}\n${text.trim()}\n`)
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
    firstSeen: seats[writer]?.firstSeen || now(), lastSeen: now() }
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
  // `## <ts> — <TYPE> [→ <to>, <to>] [(re: <ts>)]`. The `→` group is OPTIONAL and was added
  // later: every entry written before addressing existed parses as a broadcast, which is what
  // it was. An entry may never become unreadable because the protocol grew.
  const re = /^## (\S+) — ([^\n(→]+?)(?:\s*→\s*([^\n(]+?))?(?:\s*\(re: ([^)]*)\))?\s*$/
  let cur = null
  for (const line of raw.split("\n")) {
    const m = line.match(re)
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
export function inbox({ room, agent, advance = true, limit = 20 }) {
  const cursors = readJson(CURSORS, {})
  const key = `${room}::${agent}`
  const base = seatBase(agent)
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
        fresh.push({ ...e, forMe: isForMe(e, agent), ...(seatBase(writer) === base && { sibling: true }) })
    }
  }
  fresh.sort(byTime)
  const shown = fresh.slice(-limit)
  if (advance && fresh.length) {
    for (const e of fresh) seen[e.from] = seen[e.from] && t(seen[e.from]) > t(e.ts) ? seen[e.from] : e.ts
    cursors[key] = seen
    writeJson(CURSORS, cursors)
  }
  // `unreadForMe` is counted over ALL fresh entries, not just the page shown — the wake-up
  // paths (`sac wait`, the Stop hook) decide on this number, and deciding on a truncated
  // count is how a message addressed to you would fail to wake you.
  return {
    room, agent,
    unread: fresh.length,
    unreadForMe: fresh.filter(e => e.forMe).length,
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
 */
export function shouldNudge({ room, agent, ts }) {
  const all = readJson(NUDGES, {})
  const key = `${room}::${agent}`
  if (all[key] && t(all[key]) >= t(ts)) return false
  all[key] = ts
  writeJson(NUDGES, all)
  return true
}

/** Existing rooms. */
export function rooms() {
  try { return readdirSync(CHANNELS).filter(d => !d.startsWith(".")).sort() } catch { return [] }
}
