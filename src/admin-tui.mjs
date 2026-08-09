/**
 * `sac admin` — the operator's view of the bus: channels, who is on them, and how the
 * communication actually flows.
 *
 * Everything here is DERIVED, never a new record. The registry, the cursors and the channel
 * files are the truth; this only reads them, so a crash or a stale terminal can never cost a
 * message. That is why it is safe to leave running on a second screen all day.
 *
 * The three questions it exists to answer, in the order an operator asks them:
 *
 *   1. **Which channels exist, and is anything happening on them?**
 *   2. **Who is subscribed — and are they READING?** This is the one the JSON tools cannot
 *      show. A seat can be alive, working, and 40 entries behind; the cursor knows, and
 *      nothing surfaced it.
 *   3. **What is flowing right now**, with who woke whom — the distinction the whole bus is
 *      built on (an addressed entry claims attention; a broadcast FACT costs nobody a turn).
 *
 * Two honesty rules, both from measurement:
 *
 * - **`live` is three-state and `null` means "we do not know", not "dead".** Measured
 *   2026-08-09: a seat showed `lastSeen` 86 minutes old while it was working the whole time —
 *   the signal exists, nobody feeds it. So an unknown state is drawn as `?`, never as an empty
 *   circle, and the age is shown next to it. A view that renders "we do not know" as "dead"
 *   makes an operator hand work to someone else for no reason.
 * - **Nothing here writes.** No cursor moves, nothing is marked read, no heartbeat is sent.
 *   Watching a room must never change what the seats in it will see.
 *
 * Zero dependencies on purpose: the package ships with exactly one (the MCP SDK), and a TUI
 * is not a good reason to add a second.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import * as store from "./store.mjs"

// ── terminal ──────────────────────────────────────────────────────────────────

const ESC = "\x1b["
const alt = on => (on ? `${ESC}?1049h` : `${ESC}?1049l`)
const cursorVisible = on => (on ? `${ESC}?25h` : `${ESC}?25l`)
const clear = `${ESC}2J${ESC}H`
const home = `${ESC}H`

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  rev: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
}

/** Visible width, ignoring the escape sequences we injected ourselves. */
const width = s => s.replace(/\x1b\[[0-9;]*m/g, "").length

/** Truncate to `n` visible columns, ellipsis included, keeping any colour intact. */
function trunc(s, n) {
  if (n <= 0) return ""
  if (width(s) <= n) return s
  let out = "", seen = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i)
      if (end !== -1) { out += s.slice(i, end + 1); i = end; continue }
    }
    if (seen >= n - 1) break
    out += s[i]; seen++
  }
  return out + "…" + C.reset
}

const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)))

// ── reading the bus ───────────────────────────────────────────────────────────

const HOME = process.env.SET_AGENT_COMM_DIR
  || join(process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local", "share"), "set-agent-comm")

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return fallback }
}

/**
 * One snapshot of everything drawn. Taken whole so the three panes can never disagree with
 * each other — a room counted in one pane and missing from another is the kind of thing that
 * makes an operator distrust the whole screen.
 */
function snapshot() {
  const cursors = readJson(join(HOME, "cursors.json"), {})
  const focus = readJson(join(HOME, "focus.json"), {})
  const agents = store.agents()

  /** seat → its registry row, flattened out of the per-agent nesting. */
  const seats = new Map()
  for (const a of agents) {
    for (const s of a.seats || []) {
      seats.set(s.writer, { ...s, agent: a.agent, project: a.project, host: a.host, remote: !!a.remote })
    }
  }

  const rooms = store.rooms().map(room => {
    const { messages, total } = store.history({ room, limit: 400 })
    const writers = [...new Set(messages.map(m => m.from))]
    // Who could be reading here: anyone with a file, plus anyone the registry places in the
    // room. A seat that has never written is still a subscriber — and is exactly the one worth
    // knowing about, because it is invisible in the channel files.
    const registered = agents.flatMap(a =>
      (a.rooms || []).includes(room) ? (a.seats || []).map(s => s.writer) : [])
    const members = [...new Set([...writers, ...registered])].sort()

    const subs = members.map(seat => {
      const cur = cursors[`${room}::${seat}`] || {}
      // "Behind" is per WRITER: an entry counts as unread for a reader when it is newer than
      // that reader's cursor against its author. Own entries never count — nobody reads
      // themselves.
      let behind = 0, waking = 0
      for (const m of messages) {
        if (m.from === seat) continue
        const at = cur[m.from] || cur[store.seatBase(m.from)]
        if (at && m.ts <= at) continue
        behind++
        if (wakesSeat(m, seat)) waking++
      }
      const reg = seats.get(seat)
      return {
        seat,
        behind,
        waking,
        live: reg ? reg.live : undefined,
        lastSeen: reg?.lastSeen || null,
        lastWrote: reg?.lastWrote || null,
        remote: reg?.remote || false,
        focus: focus[seat]?.text || reg?.focus?.text || null,
      }
    })

    // A CLOSED seat is not "behind", it is gone: counting its backlog put 5959 unread on a
    // room where nobody live was behind at all, which is a number an operator learns to
    // ignore. Only a seat that could still read counts here — and `null` (we do not know)
    // counts, because assuming the unknown case is dead is the very mistake this view exists
    // to stop making.
    const reach = subs.filter(reachable)
    return {
      room,
      total,
      messages,
      subs,
      seats: subs.length,
      reachable: reach.length,
      last: messages.length ? messages[messages.length - 1].ts : null,
      behind: reach.reduce((n, s) => n + s.behind, 0),
      waking: reach.reduce((n, s) => n + s.waking, 0),
    }
  })

  return { rooms, at: new Date() }
}

/**
 * Live and unknown first, then the closed seats — and inside each group, the most behind
 * first. The pane is read top-down when something looks wrong, so whatever can still act has
 * to be at the top. Ordering is presentation, so it lives here and not in the snapshot.
 */
const bySeatUrgency = (a, b) =>
  reachable(b) - reachable(a) || b.waking - a.waking || b.behind - a.behind || a.seat.localeCompare(b.seat)

/** Could this seat still read? `undefined`/`null` counts — unknown is not dead. */
const reachable = s => s.live !== false

/** Would this entry interrupt that seat? The bus's whole cost model, in one predicate. */
function wakesSeat(m, seat) {
  const to = m.to || []
  if (to.length) {
    return to.some(t => t === seat || t === store.seatBase(seat) || t === store.seatBase(seat).split("@")[0])
  }
  return m.type === "QUESTION" || m.type === "REQUEST"
}

// ── formatting ────────────────────────────────────────────────────────────────

const ageMin = ts => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 60000) : null)

function ago(ts) {
  const m = ageMin(ts)
  if (m === null) return "—"
  if (m < 1) return "most"
  if (m < 60) return `${m}p`
  if (m < 1440) return `${Math.floor(m / 60)}ó`
  return `${Math.floor(m / 1440)}n`
}

/**
 * The liveness mark. Three states, drawn as three marks — `null` is `?`, not a dead circle:
 * the registry says "we do not know", and rendering that as "dead" is how an operator ends up
 * routing work away from a seat that is working.
 */
function liveMark(sub) {
  if (sub.live === true) return `${C.green}●${C.reset}`
  if (sub.live === false) return `${C.grey}○${C.reset}`
  return `${C.yellow}?${C.reset}`
}

const TYPE_COLOR = {
  QUESTION: C.yellow,
  REQUEST: C.magenta,
  ANSWER: C.cyan,
  FACT: C.blue,
}

const hhmm = ts => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

const oneLine = s => (s || "").replace(/\s+/g, " ").trim()

// ── rendering ─────────────────────────────────────────────────────────────────

/**
 * The no-wrap invariant, enforced in ONE place. A single line wider than the terminal wraps,
 * pushes every pane below it down by a row, and the layout stops lining up — so this is not
 * left to each `push` to remember.
 */
const fit = (lines, cols) => lines.map(l => trunc(l, cols)).join("\n")

function render(snap, ui) {
  const cols = process.stdout.columns || 100
  const rows = process.stdout.rows || 30
  const out = []
  const room = snap.rooms[ui.selected]

  const stamp = snap.at.toLocaleTimeString("hu-HU")
  const title = `${C.bold}set-agent-comm admin${C.reset}  ${C.dim}${HOME}${C.reset}`
  // The store path is long and the terminal may be narrow. A header that wraps pushes every
  // pane down by a line and the whole layout stops lining up, so it is truncated like any
  // other line — the clock is what has to survive, since it is how you tell a live view from
  // a frozen one.
  const titleRoom = Math.max(0, cols - width(stamp) - 1)
  out.push(trunc(title, titleRoom) + pad("", titleRoom - Math.min(titleRoom, width(title))) + ` ${C.dim}${stamp}${C.reset}`)
  out.push(C.grey + "─".repeat(cols) + C.reset)

  // ── pane 1: channels ────────────────────────────────────────────────────────
  out.push(`${C.bold}CSATORNÁK${C.reset}${C.dim}   szoba · elérhető/összes ülés · bejegyzés · utolsó · olvasatlan az ELÉRHETŐKNÉL (ebből ébresztő)${C.reset}`)
  if (!snap.rooms.length) out.push(`  ${C.dim}(még nincs szoba)${C.reset}`)
  for (const [i, r] of snap.rooms.entries()) {
    const sel = i === ui.selected
    const marker = sel ? `${C.rev}▸ ` : "  "
    const behind = r.behind
      ? `${r.waking ? C.red : C.yellow}${r.behind}${C.reset}${r.waking ? ` (${r.waking}!)` : ""}`
      : `${C.dim}0${C.reset}`
    const line =
      `${marker}${pad(r.room, 22)}${C.reset} ` +
      `${pad(`${r.reachable}/${r.seats}`, 8)}` +
      `${pad(String(r.total), 7)}` +
      `${pad(ago(r.last), 7)}` +
      behind
    out.push(trunc(line + (sel ? C.reset : ""), cols))
  }

  if (!room) return fit(out, cols)

  // ── pane 2: subscribers ─────────────────────────────────────────────────────
  out.push("")
  out.push(`${C.bold}FELIRATKOZÓK${C.reset} ${C.dim}— ${room.room} · ● él  ○ nem  ${C.yellow}?${C.reset}${C.dim} nem tudjuk (nem „halott")${C.reset}`)
  if (!room.subs.length) out.push(`  ${C.dim}(senki)${C.reset}`)
  const subLimit = Math.max(3, Math.floor((rows - 14) / 2))
  for (const s of [...room.subs].sort(bySeatUrgency).slice(0, subLimit)) {
    const behind = !s.behind
      ? `${C.green}  ✓ naprakész${C.reset}`
      : !reachable(s)
        ? `${C.grey}${String(s.behind).padStart(3)} olvasatlan (lezárt ülés)${C.reset}`
        : `${s.waking ? C.red : C.yellow}${String(s.behind).padStart(3)} le van maradva${s.waking ? ` (${s.waking} ébresztő)` : ""}${C.reset}`
    const line =
      `  ${liveMark(s)} ${pad(s.seat + (s.remote ? " ⇄" : ""), 34)}` +
      `${C.dim}${pad(ago(s.lastSeen), 6)}${C.reset}` +
      pad(behind, 34) +
      `${C.dim}${oneLine(s.focus) || "(nincs bejelentett focus)"}${C.reset}`
    out.push(trunc(line, cols))
  }
  if (room.subs.length > subLimit) {
    out.push(`  ${C.dim}… és még ${room.subs.length - subLimit}${C.reset}`)
  }

  // ── pane 3: the flow ────────────────────────────────────────────────────────
  out.push("")
  out.push(`${C.bold}FOLYAM${C.reset} ${C.dim}— ${room.room} · a → azt jelenti: EZT A SEATET ébreszti; a többi olvasható, de nem szakít félbe${C.reset}`)
  const used = out.length + 2
  const flowLimit = Math.max(3, rows - used - 1)
  const flow = room.messages.slice(-flowLimit)
  if (!flow.length) out.push(`  ${C.dim}(üres)${C.reset}`)
  for (const m of flow) {
    const color = TYPE_COLOR[m.type] || ""
    const to = (m.to || []).length
      ? `${C.bold}→ ${m.to.join(", ")}${C.reset}`
      : `${C.dim}→ mindenki${wakesSeat(m, " ") ? "" : " (nem ébreszt)"}${C.reset}`
    const line =
      `  ${C.dim}${hhmm(m.ts)}${C.reset} ` +
      `${color}${pad(m.type, 9)}${C.reset}` +
      `${pad(m.from, 30)} ${to}  ${C.dim}${oneLine(m.text)}${C.reset}`
    out.push(trunc(line, cols))
  }

  out.push(C.grey + "─".repeat(cols) + C.reset)
  out.push(`${C.dim} ↑/↓ szoba · q kilép · r frissít${C.reset}`)
  return fit(out, cols)
}

// ── the loop ──────────────────────────────────────────────────────────────────

/**
 * Redraw on a timer rather than on `fs.watch`: the derived state depends on three files AND on
 * elapsed time (every age on screen goes stale on its own), so a watcher would have to be
 * paired with a timer anyway. One second of latency on a wall-mounted view costs nothing.
 */
export function runAdminTui({ intervalMs = 1000 } = {}) {
  const ui = { selected: 0 }
  let stopped = false

  const draw = () => {
    if (stopped) return
    const snap = snapshot()
    if (ui.selected >= snap.rooms.length) ui.selected = Math.max(0, snap.rooms.length - 1)
    process.stdout.write(home + `${ESC}0J` + render(snap, ui) + `${ESC}0J`)
  }

  const quit = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(cursorVisible(true) + alt(false))
  }

  process.stdout.write(alt(true) + cursorVisible(false) + clear)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf-8")
  process.stdin.on("data", key => {
    // Ctrl-C arrives as a byte here, not as SIGINT, once the terminal is in raw mode — without
    // this the only way out would be closing the terminal, with the alternate screen left on.
    if (key === "q" || key === "\x03" || key === "\x1b") { quit(); process.exit(0) }
    if (key === "\x1b[A" || key === "k") { ui.selected = Math.max(0, ui.selected - 1); draw() }
    if (key === "\x1b[B" || key === "j") { ui.selected = ui.selected + 1; draw() }
    if (key === "r") draw()
  })
  process.on("exit", quit)
  process.on("SIGINT", () => { quit(); process.exit(0) })
  process.on("SIGTERM", () => { quit(); process.exit(0) })

  const timer = setInterval(draw, intervalMs)
  draw()
}

/** Exported for the test: the pure half, with the filesystem already read. */
export { render, wakesSeat, snapshot, trunc, width }
