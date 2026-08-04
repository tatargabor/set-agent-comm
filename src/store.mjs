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

/** An agent checking in. Idempotent: the same name is updated, not duplicated. */
export function register({ agent, project, session, room }) {
  if (!agent) throw new Error("register: `agent` is required")
  const reg = readJson(REGISTRY, { agents: {} })
  const prev = reg.agents[agent] || {}
  reg.agents[agent] = {
    ...prev,
    agent,
    project: project ?? prev.project ?? null,
    session: session ?? prev.session ?? null,
    host: hostname(),
    rooms: [...new Set([...(prev.rooms || []), ...(room ? [room] : [])])],
    firstSeen: prev.firstSeen || now(),
    lastSeen: now(),
  }
  writeJson(REGISTRY, reg)
  return reg.agents[agent]
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
    return { ...a, silentMinutes: ms == null ? null : Math.round(ms / 60000) }
  }).sort((x, y) => (x.silentMinutes ?? 1e9) - (y.silentMinutes ?? 1e9))
}

// ── channel ───────────────────────────────────────────────────────────────────

export const channelDir = room => join(CHANNELS, room)
export const busFile = (room, agent) => join(channelDir(room), `${agent}.md`)

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
  register({ agent: from, room })
  return { ts, room, from, type, path }
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
 * New entries FROM OTHERS. Skips your own file — we do not read ourselves back.
 * With `advance: true` the cursor moves forward (marks them read).
 */
export function inbox({ room, agent, advance = true, limit = 20 }) {
  const cursors = readJson(CURSORS, {})
  const key = `${room}::${agent}`
  const seen = cursors[key] || {}
  const fresh = []
  for (const path of busFiles(room)) {
    const writer = path.split("/").pop().replace(/\.md$/, "")
    if (writer === agent) continue
    for (const e of parse(path, writer)) {
      // By time, not by string — the same trap as with sorting.
      if (!seen[writer] || t(e.ts) > t(seen[writer])) fresh.push(e)
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
    const writer = path.split("/").pop().replace(/\.md$/, "")
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

/** Reading back — does NOT move the cursor. */
export function history({ room, from, limit = 20 }) {
  const files = from ? [busFile(room, from)] : busFiles(room)
  const all = files.flatMap(p => parse(p, p.split("/").pop().replace(/\.md$/, "")))
  all.sort(byTime)
  return { room, total: all.length, messages: all.slice(-limit) }
}

/** Existing rooms. */
export function rooms() {
  try { return readdirSync(CHANNELS).filter(d => !d.startsWith(".")).sort() } catch { return [] }
}
