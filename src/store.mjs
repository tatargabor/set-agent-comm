// The core: registry (who exists, who is alive) + channel (who said what).
// Zero runtime dependencies — hooks and cron call this too, where there is no node_modules.
//
// Protocol (extracted from the consumer-a ↔ set-core channel, run in on 400 entries):
// ONE FILE, ONE WRITER. Everyone appends to their own file only, and reads the others'.
// That way there is no lost update and no lockfile is needed — after a session dies the
// lock would stay stuck, and from then on nobody would write.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync,
         existsSync, renameSync, openSync, fsyncSync, closeSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, hostname } from "node:os"

export const ROOT = process.env.SET_AGENT_COMM_DIR
  || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "set-agent-comm")

const REGISTRY = join(ROOT, "registry.json")
const CHANNELS = join(ROOT, "channels")
const CURSORS = join(ROOT, "cursors.json")

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
 * The first session in a project sits in the base seat (`consumer-a`), the next ones get
 * `consumer-a#2`, `#3` …
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
 * nothing to make up. Without a session id there is no seat: the caller is the base name, as
 * before, and the co-writer warning of `send` still covers that case.
 */
export const seatBase = writer => String(writer).replace(/#\d+$/, "")
const seatName = (agent, i) => (i === 0 ? agent : `${agent}#${i + 1}`)

/**
 * How long a seat is held after its last sign of life, once no process of it is alive.
 *
 * A live pid alone is not enough: a session may run with the hook and the CLI only (no MCP
 * process), and both of those exit within a second. Handing their seat to a newcomer while
 * they still work would put two sessions back into one file — the very thing measured above.
 */
const SEAT_TTL_MS = 30 * 60_000

const seatLive = seat => !!seat && (
  Object.keys(seat.writers || {}).some(p => alive(Number(p))) ||
  Date.now() - (Date.parse(seat.lastSeen) || 0) < SEAT_TTL_MS)

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
 * Which seat is this session's? Idempotent: the SAME session id always gets its seat back —
 * that is what keeps a session's file and read cursor continuous across restarts.
 *
 * The registry is written with tmp→rename, so a concurrent claim cannot corrupt it, but the
 * read-modify-write is not atomic: two sessions starting at the same moment can pick the same
 * seat, and the later write wins. Hence the READ-BACK: the loser sees that the seat is not
 * its own and looks for the next one. If even that keeps failing, we fall back to a name that
 * cannot collide — an ugly name is better than two writers in one file.
 */
export function claimSeat({ agent, session, pid = process.pid }) {
  if (!agent) throw new Error("claimSeat: `agent` is required")
  if (!session) return agent
  for (let attempt = 0; attempt < 5; attempt++) {
    const reg = readJson(REGISTRY, { agents: {} })
    const rec = (reg.agents[agent] ||= { agent })
    const seats = (rec.seats ||= {})
    let name = Object.keys(seats).find(n => seats[n].session === session)
    for (let i = 0; !name; i++) if (!seatLive(seats[seatName(agent, i)])) name = seatName(agent, i)
    touchSeat(seats, name, { session, pid })
    writeJson(REGISTRY, reg)
    if (readJson(REGISTRY, { agents: {} }).agents?.[agent]?.seats?.[name]?.session === session) return name
  }
  return `${agent}#${session.slice(0, 8)}`
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
  return Object.keys(seats).find(n => seats[n].session === session) || agent
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
export function agents() {
  const reg = readJson(REGISTRY, { agents: {} })
  return Object.values(reg.agents).map(a => {
    const ms = a.lastSeen ? Date.now() - new Date(a.lastSeen).getTime() : null
    // The seats are shown as a LIST, and the live ones separately: this is what tells another
    // agent that this project currently has two sessions, and which names to address.
    const seats = Object.entries(a.seats || {}).map(([writer, s]) => ({
      writer, live: seatLive(s), lastSeen: s.lastSeen ?? null,
    }))
    return {
      ...a,
      seats,
      live: seats.filter(s => s.live).map(s => s.writer),
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
 * Append an entry to your own file. APPEND, never a full rewrite.
 *
 * This is the most concrete gain of the extraction: on the old channel the agent wrote with
 * the `Write`/`Edit` tool, which is a FULL rewrite of a 555 KB file per message — the file
 * lands in the context, and out of two concurrent writes one is silently lost.
 */
export function send({ room, from, type = "FACT", text, re }) {
  if (!room || !from) throw new Error("send: `room` and `from` are required")
  if (!text?.trim()) throw new Error("send: empty message")
  type = normalizeType(type)
  if (!TYPES.includes(type)) throw new Error(`send: unknown type '${type}' (${TYPES.join(" | ")})`)
  const path = busFile(room, from)
  mkdirSync(dirname(path), { recursive: true })
  const ts = now()
  const head = `## ${ts} — ${type}${re ? ` (re: ${re})` : ""}`
  const body = text.trim()
  appendFileSync(path, `${existsSync(path) && statSync(path).size ? "\n" : ""}${head}\n${body}\n`)
  // `from` is a SEAT, so the registry entry belongs to the project behind it. `writer` keeps
  // the seat as it is: sending a message may not reshuffle who sits where.
  const { coWriters } = register({ agent: seatBase(from), writer: from, room })
  // Told to the WRITER, at the moment of writing: by the time the reader notices that one
  // sender is contradicting itself, the wrong instruction has already been acted on. With a
  // session id every session has its own seat, so this can now only fire for a caller that
  // has none (cron, a bare terminal, a non-Claude-Code client).
  const warning = coWriters.length
    ? `⚠ ${coWriters.length} other live process(es) write into the SAME file as \`${from}\` ` +
      `(pid ${coWriters.join(", ")}) — they have no session id, so they got no seat of their own. ` +
      `The reader cannot tell your entries from theirs: say which thread you are, and do not ` +
      `assume an earlier entry under this name was yours.`
    : undefined
  return { ts, room, from, type, path, ...(warning && { warning }) }
}

/** The entries of one file, newest at the bottom (as they stand in the file). */
function parse(path, agent) {
  let raw
  try { raw = readFileSync(path, "utf8") } catch { return [] }
  const out = []
  const re = /^## (\S+) — ([^\n(]+?)(?:\s*\(re: ([^)]*)\))?\s*$/
  let cur = null
  for (const line of raw.split("\n")) {
    const m = line.match(re)
    if (m) {
      if (cur) out.push(cur)
      cur = { ts: m[1], type: normalizeType(m[2].trim()), re: m[3]?.trim() || null, from: agent, lines: [] }
    } else if (cur) cur.lines.push(line)
  }
  if (cur) out.push(cur)
  return out.map(e => ({ ...e, text: e.lines.join("\n").trim(), lines: undefined }))
}

/**
 * The read cursor of a NEWLY BORN seat. Called by `register`, once, when the second session
 * of a project takes its seat — at that point we know the room, which `claimSeat` does not.
 *
 * Two decisions in it:
 *  - it inherits the base seat's cursor: what the project has already read from the OTHERS is
 *    not unread for a session that just joined;
 *  - a sibling's earlier entries are marked read: they are the project's shared history (400
 *    entries in the live `consumer-a-atlas` room), not mail addressed to a session that did not yet
 *    exist. `history` still has all of them.
 * Everything a sibling writes FROM NOW ON is delivered — that is the point of the whole change.
 */
function seedCursor(room, writer) {
  const base = seatBase(writer)
  if (!room || writer === base) return               // the base seat starts from zero, as before
  const cursors = readJson(CURSORS, {})
  const key = `${room}::${writer}`
  if (cursors[key]) return                           // an existing seat keeps its own cursor
  const seen = { ...(cursors[`${room}::${base}`] || {}) }
  for (const path of busFiles(room)) {
    const w = writerOf(path)
    if (w === writer || seatBase(w) !== base) continue
    const last = parse(path, w).at(-1)
    if (last) seen[w] = last.ts
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
        fresh.push(seatBase(writer) === base ? { ...e, sibling: true } : e)
    }
  }
  fresh.sort(byTime)
  const shown = fresh.slice(-limit)
  if (advance && fresh.length) {
    for (const e of fresh) seen[e.from] = seen[e.from] && t(seen[e.from]) > t(e.ts) ? seen[e.from] : e.ts
    cursors[key] = seen
    writeJson(CURSORS, cursors)
  }
  return { room, agent, unread: fresh.length, truncated: fresh.length - shown.length, messages: shown }
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
 * `from` may name a project (`consumer-a`) or one seat of it (`consumer-a#2`). The project name
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

/** Existing rooms. */
export function rooms() {
  try { return readdirSync(CHANNELS).filter(d => !d.startsWith(".")).sort() } catch { return [] }
}
