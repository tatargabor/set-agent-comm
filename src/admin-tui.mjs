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
 *   Watching a room must never change what the seats in it will see. This now holds under
 *   *every* navigation key, and a test exercises all of them against a byte-compared store.
 *
 * ⚠ NAVIGATION, added 2026-08-11. Until then the view had three keys (`↑`/`↓`/`q`) and three
 * things on screen were unreachable by any means: an entry's text (collapsed to one truncated
 * line — in the very tool an operator opens *because* `inbox` clips at 1200 characters), the
 * seats past `(rows-14)/2` (printed as `… és még N`; the live `consumer-a-atlas` has 18), and anything
 * older than the last screenful of flow. The fix is a focused pane plus scrolling; what did NOT
 * change is what the view reports.
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

/** Hard-wrap plain text to `n` columns, breaking on spaces where one is close enough. */
function wrap(text, n) {
  const out = []
  for (const para of String(text ?? "").split("\n")) {
    if (!para.length) { out.push(""); continue }
    let rest = para
    while (width(rest) > n) {
      let cut = rest.lastIndexOf(" ", n)
      if (cut < n * 0.6) cut = n            // a word longer than the line is broken, not orphaned
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^ /, "")
    }
    out.push(rest)
  }
  return out
}

// ── reading the bus ───────────────────────────────────────────────────────────

const HOME = process.env.SET_AGENT_COMM_DIR
  || join(process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local", "share"), "set-agent-comm")

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return fallback }
}

/** How many entries per room the snapshot loads. Grows when the operator scrolls off the top. */
export const DEFAULT_WINDOW = 400

/**
 * One snapshot of everything drawn. Taken whole so the three panes can never disagree with
 * each other — a room counted in one pane and missing from another is the kind of thing that
 * makes an operator distrust the whole screen.
 *
 * `window` is how far back the flow is loaded. `history` returns `slice(-limit)`, so a larger
 * window reaches further back and nothing else about it changes — which is why scrolling past
 * the loaded window needed no core change at all.
 */
function snapshot({ window = DEFAULT_WINDOW } = {}) {
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
    const { messages, total } = store.history({ room, limit: window })
    const writers = [...new Set(messages.map(m => m.from))]
    // Who could be reading here: anyone with a file, plus anyone the registry places in the
    // room. A seat that has never written is still a subscriber — and is exactly the one worth
    // knowing about, because it is invisible in the channel files.
    const registered = agents.flatMap(a =>
      (a.rooms || []).includes(room) ? (a.seats || []).map(s => s.writer) : [])
    const members = [...new Set([...writers, ...registered])].sort()

    const subs = members.map(seat => {
      const cur = cursors[`${room}::${seat}`] || {}
      // ⚠ A QUIET SEAT IS STILL BEHIND, and that number is real — it reads everything, it just
      // is not interrupted. What drops to zero is the WAKING count, because nothing here wakes
      // it. (The spec for this change first said the whole backlog should be reported apart, the
      // way a closed session's is. That was wrong and the distinction is why: a closed seat will
      // never read its backlog, a quiet one will.)
      const isQuiet = !!seats.get(seat)?.quiet
      // "Behind" is per WRITER: an entry counts as unread for a reader when it is newer than
      // that reader's cursor against its author. Own entries never count — nobody reads
      // themselves.
      let behind = 0, waking = 0
      const perWriter = {}
      for (const m of messages) {
        if (m.from === seat) continue
        const at = cur[m.from] || cur[store.seatBase(m.from)]
        if (at && m.ts <= at) continue
        behind++
        perWriter[m.from] = (perWriter[m.from] || 0) + 1
        if (!isQuiet && wakesSeat(m, seat)) waking++
      }
      const reg = seats.get(seat)
      return {
        seat,
        behind,
        waking,
        perWriter,
        live: reg ? reg.live : undefined,
        quiet: !!reg?.quiet,
        quietUntil: reg?.quietUntil || null,
        lastSeen: reg?.lastSeen || null,
        lastWrote: reg?.lastWrote || null,
        remote: reg?.remote || false,
        rooms: reg?.rooms || null,
        focus: focus[seat]?.text || reg?.focus?.text || null,
        focusFiles: focus[seat]?.files || reg?.focus?.files || null,
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

  return { rooms, at: new Date(), window }
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

/** Does this entry interrupt ANYBODY in the room? What the `waking` filter selects on. */
const wakesAnyone = (m, subs) =>
  (m.to || []).length ? subs.some(s => wakesSeat(m, s.seat)) : (m.type === "QUESTION" || m.type === "REQUEST")

// ── formatting ────────────────────────────────────────────────────────────────

const ageMin = ts => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 60000) : null)

function ago(ts) {
  const m = ageMin(ts)
  if (m === null) return "—"
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

/**
 * The liveness mark. Three states, drawn as three marks — `null` is `?`, not a dead circle:
 * the registry says "we do not know", and rendering that as "dead" is how an operator ends up
 * routing work away from a seat that is working.
 */
function liveMark(sub) {
  // ⚠ A FOURTH MARK for the fourth state. `quiet` is the only one of the four that somebody
  // DECLARED, and it is drawn apart from all three of the derived ones: a seat that asked not to
  // be interrupted is not dead, not unknown, and not simply live-and-ignoring-you.
  // An open-ended quiet is drawn LOUDER than one with an expiry: a declaration with no limit is
  // the one that turns into a lie without anybody noticing, and this view is where a person
  // notices it. Raised 2026-08-11 by set-agent-comm#f7195843; read-only, so it is free.
  if (sub.quiet) return sub.quietUntil ? `${C.cyan}◐${C.reset}` : `${C.red}◑${C.reset}`
  if (sub.live === true) return `${C.green}●${C.reset}`
  if (sub.live === false) return `${C.grey}○${C.reset}`
  return `${C.yellow}?${C.reset}`
}

const liveWord = sub =>
  sub.quiet ? (sub.quietUntil
      ? `quiet — until ${sub.quietUntil} (still receives everything, just is not woken)`
      : `quiet — NO EXPIRY, until someone clears it (still receives everything, just is not woken)`)
    : sub.live === true ? "live"
    : sub.live === false ? "closed session"
    : `unknown (NOT "dead")`

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

// ── keys ──────────────────────────────────────────────────────────────────────

/**
 * ONE table: the footer and the `?` overlay are both generated from it, so a binding cannot
 * exist without being documented. Escape sequences are decoded in exactly one place too —
 * a half-decoded sequence otherwise falls through as stray printable characters, which with a
 * search box on screen means the arrow keys start typing into it.
 */
const KEYS = [
  { keys: "Tab / ⇧Tab", what: "other pane" },
  { keys: "↑ ↓ / j k", what: "move in the active pane" },
  { keys: "PgUp PgDn", what: "page" },
  { keys: "Home End", what: "top / bottom (End follows again)" },
  { keys: "↵", what: "open (an entry's or a seat's whole text)" },
  { keys: "/", what: "search the active pane" },
  { keys: "f", what: "flow filter: all → waking only → type" },
  { keys: "Esc", what: "close overlay / search / filter" },
  { keys: "r", what: "refresh now" },
  { keys: "?", what: "this help" },
  { keys: "q", what: "quit" },
]

const PANES = ["channels", "subs", "flow"]
const PANE_TITLE = { channels: "CHANNELS", subs: "SUBSCRIBERS", flow: "FLOW" }
const FILTERS = ["all", "waking", "QUESTION", "REQUEST", "ANSWER", "FACT"]
const FILTER_LABEL = {
  all: null,
  waking: "waking only",
  QUESTION: "QUESTION only", REQUEST: "REQUEST only", ANSWER: "ANSWER only", FACT: "FACT only",
}

// ── ui state ──────────────────────────────────────────────────────────────────

/**
 * A partial `ui` is completed here, which is what keeps `render` callable from a test with
 * `{ selected: 0 }` — the shape it had before navigation existed.
 *
 * ⚠ SELECTION IS BY IDENTITY, NOT BY INDEX (`sel`). The view redraws every second and the
 * lists grow underneath it; an index would slide onto a different row the moment an entry
 * arrived above the cursor, and the operator would open the wrong message. The index is
 * recomputed from the id each frame, and a vanished id falls back to the nearest row.
 */
function normalizeUi(ui = {}) {
  const u = {
    pane: PANES.includes(ui.pane) ? ui.pane : "channels",
    sel: { channels: null, subs: null, flow: null, ...(ui.sel || {}) },
    scroll: { channels: 0, subs: 0, flow: 0, ...(ui.scroll || {}) },
    query: { channels: "", subs: "", flow: "", ...(ui.query || {}) },
    filter: FILTERS.includes(ui.filter) ? ui.filter : "all",
    overlay: ui.overlay || null,
    typing: ui.typing || false,
    follow: ui.follow !== false,
    window: ui.window || DEFAULT_WINDOW,
  }
  // The pre-navigation shape: `{ selected: <index> }` picked the room. Kept as an alias so
  // every existing caller and test keeps working unchanged.
  if (typeof ui.selected === "number") u.selectedIndex = ui.selected
  return u
}

/** The rows of one pane, after filter and search — the list the cursor indexes into. */
function paneRows(snap, ui, pane, room) {
  if (pane === "channels") {
    const q = ui.query.channels.toLowerCase()
    const all = snap.rooms.map(r => ({ id: r.room, r }))
    return { all, rows: q ? all.filter(x => x.id.toLowerCase().includes(q)) : all }
  }
  if (pane === "subs") {
    const q = ui.query.subs.toLowerCase()
    const all = (room?.subs || []).slice().sort(bySeatUrgency).map(s => ({ id: s.seat, s }))
    return {
      all,
      rows: q ? all.filter(x => (x.id + " " + (x.s.focus || "")).toLowerCase().includes(q)) : all,
    }
  }
  const q = ui.query.flow.toLowerCase()
  const subs = room?.subs || []
  let all = (room?.messages || []).map(m => ({ id: `${m.ts}|${m.from}`, m }))
  if (ui.filter === "waking") all = all.filter(x => wakesAnyone(x.m, subs))
  else if (ui.filter !== "all") all = all.filter(x => x.m.type === ui.filter)
  const rows = q
    ? all.filter(x => `${x.m.from} ${x.m.type} ${x.m.text || ""} ${(x.m.to || []).join(" ")}`.toLowerCase().includes(q))
    : all
  return { all, rows }
}

/** Where the cursor actually is: the id's index, or the nearest surviving row. */
function cursorOf(ui, pane, rows) {
  if (!rows.length) return 0
  if (pane === "channels" && ui.selectedIndex !== undefined && ui.sel.channels === null) {
    return Math.min(ui.selectedIndex, rows.length - 1)
  }
  const id = ui.sel[pane]
  if (id === null) return pane === "flow" ? rows.length - 1 : 0
  const i = rows.findIndex(r => r.id === id)
  return i === -1 ? Math.min(pane === "flow" ? rows.length - 1 : 0, rows.length - 1) : i
}

/** Scroll clamped at RENDER time, so a stale `ui` or a resize can never draw out of range. */
function windowOf(cursor, scroll, height, total) {
  if (height <= 0 || total === 0) return { start: 0, end: 0 }
  let start = Math.max(0, Math.min(scroll, Math.max(0, total - height)))
  if (cursor < start) start = cursor
  if (cursor >= start + height) start = cursor - height + 1
  start = Math.max(0, Math.min(start, Math.max(0, total - height)))
  return { start, end: Math.min(total, start + height) }
}

/**
 * How the body is split between the three panes. Every pane gets at least one row when there
 * is any room at all — a pane that silently gets zero rows is the `… és még N` problem again,
 * one level up.
 */
function layout(rows, counts) {
  const body = Math.max(0, rows - 2 /* header */ - 2 /* footer */ - 3 /* pane titles */ - 2 /* gaps */)
  if (body <= 0) return { channels: 0, subs: 0, flow: 0 }
  if (body <= 3) return { channels: 1, subs: 1, flow: Math.max(0, body - 2) }
  const ch = Math.max(1, Math.min(counts.channels, Math.round(body * 0.3)))
  const su = Math.max(1, Math.min(counts.subs, Math.round(body * 0.3)))
  return { channels: ch, subs: su, flow: Math.max(1, body - ch - su) }
}

// ── rendering ─────────────────────────────────────────────────────────────────

/**
 * The no-wrap invariant, enforced in ONE place. A single line wider than the terminal wraps,
 * pushes every pane below it down by a row, and the layout stops lining up — so this is not
 * left to each `push` to remember.
 */
const fit = (lines, cols) => lines.map(l => trunc(l, cols)).join("\n")

/** `3/18` when the pane is scrolled, plus what a filter or query is hiding. */
function paneMeta(pane, ui, cursor, rows, all, height) {
  const bits = []
  if (rows.length > height) bits.push(`${cursor + 1}/${rows.length}`)
  const q = ui.query[pane]
  if (q) bits.push(`${C.yellow}/${q}${C.reset}`)
  if (pane === "flow" && FILTER_LABEL[ui.filter]) bits.push(`${C.yellow}${FILTER_LABEL[ui.filter]}${C.reset}`)
  if (rows.length !== all.length) bits.push(`${C.dim}${rows.length}/${all.length} shown${C.reset}`)
  return bits.length ? `  ${C.dim}${bits.join(" · ")}${C.reset}` : ""
}

function renderOverlay(snap, ui, cols, rows) {
  const out = []
  const o = ui.overlay
  const body = Math.max(1, rows - 4)
  let lines = []
  let title = ""

  if (o.kind === "help") {
    title = "KEYS"
    lines = KEYS.map(k => `  ${C.bold}${pad(k.keys, 14)}${C.reset}${C.dim}${k.what}${C.reset}`)
    lines.push("")
    lines.push(`  ${C.dim}Under EVERY key this view only reads: it moves no cursor,${C.reset}`)
    lines.push(`  ${C.dim}marks nothing as read, and writes nothing to the store.${C.reset}`)
  } else if (o.kind === "entry") {
    const m = o.entry
    title = `ENTRY — ${o.room}`
    const to = (m.to || []).length ? m.to.join(", ") : "everyone (broadcast)"
    lines.push(`  ${C.dim}${m.ts}${C.reset}`)
    lines.push(`  ${(TYPE_COLOR[m.type] || "") + C.bold}${m.type}${C.reset}  ${C.dim}from${C.reset} ${m.from}  ${C.dim}→${C.reset} ${to}`)
    if (m.re) lines.push(`  ${C.dim}re: ${m.re}${C.reset}`)
    lines.push(`  ${C.dim}${(m.text || "").length} characters${C.reset}`)
    lines.push(C.grey + "─".repeat(Math.max(0, cols - 2)) + C.reset)
    // The whole text, never clipped. This is the reason the overlay exists: the one-line form
    // in the flow cannot show what was said, and this is the tool you open BECAUSE inbox clips.
    for (const l of wrap(m.text || "", Math.max(10, cols - 4))) lines.push("  " + l)
  } else {
    const s = o.seat
    title = `SESSION — ${s.seat}`
    lines.push(`  ${liveMark(s)} ${C.bold}${s.seat}${C.reset}${s.remote ? `  ${C.dim}⇄ remote${C.reset}` : ""}`)
    lines.push(`  ${C.dim}state:${C.reset} ${liveWord(s)}   ${C.dim}last seen:${C.reset} ${ago(s.lastSeen)}`)
    lines.push(`  ${C.dim}last wrote:${C.reset} ${ago(s.lastWrote)}`)
    if (s.rooms?.length) lines.push(`  ${C.dim}rooms:${C.reset} ${s.rooms.join(", ")}`)
    lines.push("")
    lines.push(`  ${C.dim}focus:${C.reset} ${oneLine(s.focus) || `${C.dim}(none declared)${C.reset}`}`)
    if (s.focusFiles?.length) lines.push(`  ${C.dim}paths:${C.reset} ${s.focusFiles.join(", ")}`)
    lines.push("")
    if (!reachable(s)) {
      lines.push(`  ${C.grey}${s.behind} unread — but this session is closed: not behind, gone.${C.reset}`)
    } else {
      lines.push(`  ${s.behind ? (s.waking ? C.red : C.yellow) : C.green}${s.behind} unread${s.waking ? `, ${s.waking} of them waking` : ""}${C.reset}`)
    }
    const per = Object.entries(s.perWriter || {}).sort((a, b) => b[1] - a[1])
    if (per.length) {
      lines.push("")
      lines.push(`  ${C.dim}per writer:${C.reset}`)
      for (const [w, n] of per) lines.push(`    ${pad(w, 40)}${C.dim}${n}${C.reset}`)
    }
  }

  const scroll = Math.max(0, Math.min(o.scroll || 0, Math.max(0, lines.length - body)))
  out.push(`${C.rev}${C.bold} ${pad(title, Math.max(0, cols - 1))}${C.reset}`)
  out.push("")
  for (const l of lines.slice(scroll, scroll + body)) out.push(l)
  for (let i = lines.slice(scroll, scroll + body).length; i < body; i++) out.push("")
  out.push(C.grey + "─".repeat(cols) + C.reset)
  const more = lines.length > body ? ` · ${scroll + 1}-${Math.min(lines.length, scroll + body)}/${lines.length}` : ""
  out.push(`${C.dim} Esc back · ↑↓ scroll${more}${C.reset}`)
  return fit(out, cols)
}

function render(snap, rawUi) {
  const cols = process.stdout.columns || 100
  const rows = process.stdout.rows || 30
  const ui = normalizeUi(rawUi)
  const out = []

  if (ui.overlay) return renderOverlay(snap, ui, cols, rows)

  const chan = paneRows(snap, ui, "channels")
  const chanCursor = cursorOf(ui, "channels", chan.rows)
  const room = chan.rows[chanCursor]?.r || snap.rooms[0]

  const subs = paneRows(snap, ui, "subs", room)
  const subsCursor = cursorOf(ui, "subs", subs.rows)
  const flow = paneRows(snap, ui, "flow", room)
  const flowCursor = cursorOf(ui, "flow", flow.rows)

  const h = layout(rows, { channels: chan.rows.length, subs: subs.rows.length, flow: flow.rows.length })

  // en-GB, not en-US: 24-hour, so the clock reads the same way as the timestamps in the flow.
  const stamp = snap.at.toLocaleTimeString("en-GB")
  const title = `${C.bold}set-agent-comm admin${C.reset}  ${C.dim}${HOME}${C.reset}`
  // The store path is long and the terminal may be narrow. A header that wraps pushes every
  // pane down by a line and the whole layout stops lining up, so it is truncated like any
  // other line — the clock is what has to survive, since it is how you tell a live view from
  // a frozen one.
  const titleRoom = Math.max(0, cols - width(stamp) - 1)
  out.push(trunc(title, titleRoom) + pad("", titleRoom - Math.min(titleRoom, width(title))) + ` ${C.dim}${stamp}${C.reset}`)
  out.push(C.grey + "─".repeat(cols) + C.reset)

  const head = (pane, cursor, p, height, extra = "") => {
    const active = ui.pane === pane
    const mark = active ? `${C.rev}${C.bold} ${PANE_TITLE[pane]} ${C.reset}` : `${C.bold}${PANE_TITLE[pane]}${C.reset}`
    return mark + extra + paneMeta(pane, ui, cursor, p.rows, p.all, height)
  }
  const rowMark = (active, sel) =>
    sel ? (active ? `${C.rev}▸${C.reset} ` : `${C.bold}▸${C.reset} `) : "  "

  // ── pane 1: channels ────────────────────────────────────────────────────────
  out.push(head("channels", chanCursor, chan, h.channels,
    `${C.dim}   room · reachable/total seats · entries · last · unread among the REACHABLE (waking)${C.reset}`))
  if (!snap.rooms.length) out.push(`  ${C.dim}(no rooms yet)${C.reset}`)
  else if (!chan.rows.length) out.push(`  ${C.dim}(no room matches "${ui.query.channels}")${C.reset}`)
  const chanWin = windowOf(chanCursor, ui.scroll.channels, h.channels, chan.rows.length)
  for (let i = chanWin.start; i < chanWin.end; i++) {
    const r = chan.rows[i].r
    const behind = r.behind
      ? `${r.waking ? C.red : C.yellow}${r.behind}${C.reset}${r.waking ? ` (${r.waking}!)` : ""}`
      : `${C.dim}0${C.reset}`
    const line =
      `${rowMark(ui.pane === "channels", i === chanCursor)}${pad(r.room, 22)}${C.reset} ` +
      `${pad(`${r.reachable}/${r.seats}`, 8)}` +
      `${pad(String(r.total), 7)}` +
      `${pad(ago(r.last), 7)}` +
      behind
    out.push(trunc(line, cols))
  }

  if (!room) return fit(out, cols)

  // ── pane 2: subscribers ─────────────────────────────────────────────────────
  out.push("")
  out.push(head("subs", subsCursor, subs, h.subs,
    ` ${C.dim}— ${room.room} · ● live  ○ no  ${C.yellow}?${C.reset}${C.dim} unknown (NOT "dead")  ` +
    `${C.cyan}◐${C.reset}${C.dim} quiet${C.reset}`))
  if (!subs.all.length) out.push(`  ${C.dim}(nobody)${C.reset}`)
  else if (!subs.rows.length) out.push(`  ${C.dim}(no session matches "${ui.query.subs}")${C.reset}`)
  const subsWin = windowOf(subsCursor, ui.scroll.subs, h.subs, subs.rows.length)
  for (let i = subsWin.start; i < subsWin.end; i++) {
    const s = subs.rows[i].s
    const behind = !s.behind
      ? `${C.green}  ✓ up to date${C.reset}`
      : !reachable(s)
        ? `${C.grey}${String(s.behind).padStart(3)} unread (closed session)${C.reset}`
        : `${s.waking ? C.red : C.yellow}${String(s.behind).padStart(3)} behind${s.waking ? ` (${s.waking} waking)` : ""}${C.reset}`
    const line =
      `${rowMark(ui.pane === "subs", i === subsCursor)}${liveMark(s)} ${pad(s.seat + (s.remote ? " ⇄" : ""), 34)}` +
      `${C.dim}${pad(ago(s.lastSeen), 6)}${C.reset}` +
      pad(behind, 34) +
      `${C.dim}${oneLine(s.focus) || "(no focus declared)"}${C.reset}`
    out.push(trunc(line, cols))
  }

  // ── pane 3: the flow ────────────────────────────────────────────────────────
  out.push("")
  out.push(head("flow", flowCursor, flow, h.flow,
    ` ${C.dim}— ${room.room} · → means it WAKES that seat; the rest is delivered, but interrupts nobody${C.reset}`))
  const flowWin = windowOf(flowCursor, ui.scroll.flow, h.flow, flow.rows.length)
  if (!flow.all.length) out.push(`  ${C.dim}(empty)${C.reset}`)
  else if (!flow.rows.length) out.push(`  ${C.dim}(no entry matches the filter)${C.reset}`)
  // ⚠ The top of the LOADED window is stated, never silent. Ending at entry 400 with no word
  // about it is the same mistake as the `… és még N` this change removed.
  if (flowWin.start === 0 && room.total > flow.all.length && ui.filter === "all" && !ui.query.flow) {
    out.push(`  ${C.dim}⟲ top of the loaded window — the room holds ${room.total} entries, ` +
      `${flow.all.length} loaded (scroll up for more)${C.reset}`)
  }
  for (let i = flowWin.start; i < flowWin.end; i++) {
    const m = flow.rows[i].m
    const color = TYPE_COLOR[m.type] || ""
    const to = (m.to || []).length
      ? `${C.bold}→ ${m.to.join(", ")}${C.reset}`
      : `${C.dim}→ everyone${wakesSeat(m, " ") ? "" : " (wakes nobody)"}${C.reset}`
    const line =
      `${rowMark(ui.pane === "flow", i === flowCursor)}${C.dim}${hhmm(m.ts)}${C.reset} ` +
      `${color}${pad(m.type, 9)}${C.reset}` +
      `${pad(m.from, 30)} ${to}  ${C.dim}${oneLine(m.text)}${C.reset}`
    out.push(trunc(line, cols))
  }
  if (flowWin.end < flow.rows.length) {
    out.push(`  ${C.yellow}↓ ${flow.rows.length - flowWin.end} newer below${C.reset}${C.dim} — End jumps to them${C.reset}`)
  }

  out.push(C.grey + "─".repeat(cols) + C.reset)
  const typing = ui.typing ? `${C.yellow}/${ui.query[ui.pane]}▌${C.reset}  ` : ""
  out.push(`${C.dim} ${typing}Tab pane · ↑↓ move · ↵ open · / search · f filter · ? help · q quit${C.reset}`)
  return fit(out, cols)
}

// ── key handling ──────────────────────────────────────────────────────────────

/**
 * PURE state transition, so every binding is testable without a terminal. Returns the next
 * `ui` (normalized) — never mutates, never touches the store.
 *
 * ⚠ While a query is being typed, only printable characters, backspace, Enter and Esc are
 * consumed. Everything else is IGNORED rather than interpreted: an arrow key arrives as three
 * bytes, and a partially-decoded sequence would otherwise type `[A` into the search box.
 */
function handleKey(snap, rawUi, key) {
  const ui = normalizeUi(rawUi)
  const chan = paneRows(snap, ui, "channels")
  const chanCursor = cursorOf(ui, "channels", chan.rows)
  const room = chan.rows[chanCursor]?.r || snap.rooms[0]
  const p = paneRows(snap, ui, ui.pane, room)
  const cursor = cursorOf(ui, ui.pane, p.rows)
  const rowsTall = process.stdout.rows || 30
  const h = layout(rowsTall, { channels: chan.rows.length, subs: p.rows.length, flow: p.rows.length })
  const page = Math.max(1, h[ui.pane] || 1)

  const withSel = (i) => {
    const j = Math.max(0, Math.min(i, p.rows.length - 1))
    const next = {
      ...ui,
      sel: { ...ui.sel, [ui.pane]: p.rows[j]?.id ?? null },
      scroll: { ...ui.scroll, [ui.pane]: ui.scroll[ui.pane] },
    }
    // The alias must move with it, or the channels pane would snap back to the old index.
    if (ui.pane === "channels") delete next.selectedIndex
    if (ui.pane === "flow") next.follow = j >= p.rows.length - 1
    return next
  }

  if (ui.typing) {
    if (key === "\x1b") return { ...ui, typing: false, query: { ...ui.query, [ui.pane]: "" } }
    if (key === "\r" || key === "\n") return { ...ui, typing: false }
    if (key === "\x7f" || key === "\b") {
      return { ...ui, query: { ...ui.query, [ui.pane]: ui.query[ui.pane].slice(0, -1) } }
    }
    if (key.length === 1 && key >= " " && key !== "\x7f") {
      return { ...ui, query: { ...ui.query, [ui.pane]: ui.query[ui.pane] + key } }
    }
    return ui                                  // every other key: ignored, never navigation
  }

  if (ui.overlay) {
    if (key === "\x1b" || key === "q" || key === "\r") return { ...ui, overlay: null }
    if (key === "\x1b[A" || key === "k") return { ...ui, overlay: { ...ui.overlay, scroll: Math.max(0, (ui.overlay.scroll || 0) - 1) } }
    if (key === "\x1b[B" || key === "j") return { ...ui, overlay: { ...ui.overlay, scroll: (ui.overlay.scroll || 0) + 1 } }
    if (key === "\x1b[5~") return { ...ui, overlay: { ...ui.overlay, scroll: Math.max(0, (ui.overlay.scroll || 0) - 10) } }
    if (key === "\x1b[6~") return { ...ui, overlay: { ...ui.overlay, scroll: (ui.overlay.scroll || 0) + 10 } }
    if (ui.overlay.kind === "help") return { ...ui, overlay: null }   // any key closes the help
    return ui
  }

  switch (key) {
    case "\t":
      return { ...ui, pane: PANES[(PANES.indexOf(ui.pane) + 1) % PANES.length] }
    case "\x1b[Z":
      return { ...ui, pane: PANES[(PANES.indexOf(ui.pane) + PANES.length - 1) % PANES.length] }
    case "\x1b[A": case "k": return withSel(cursor - 1)
    case "\x1b[B": case "j": return withSel(cursor + 1)
    case "\x1b[5~": return withSel(cursor - page)
    case "\x1b[6~": return withSel(cursor + page)
    case "\x1b[H": case "\x1b[1~": return withSel(0)
    case "\x1b[F": case "\x1b[4~": return withSel(p.rows.length - 1)
    case "/": return { ...ui, typing: true, query: { ...ui.query, [ui.pane]: "" } }
    case "f": {
      if (ui.pane !== "flow") return ui
      return { ...ui, filter: FILTERS[(FILTERS.indexOf(ui.filter) + 1) % FILTERS.length] }
    }
    case "?": return { ...ui, overlay: { kind: "help", scroll: 0 } }
    case "\x1b": {
      if (ui.query[ui.pane]) return { ...ui, query: { ...ui.query, [ui.pane]: "" } }
      if (ui.pane === "flow" && ui.filter !== "all") return { ...ui, filter: "all" }
      return ui
    }
    case "\r": case "\n": {
      const sel = p.rows[cursor]
      if (!sel) return ui
      if (ui.pane === "channels") return { ...ui, pane: "flow" }   // a room's detail IS the two panes below
      if (ui.pane === "subs") return { ...ui, overlay: { kind: "seat", seat: sel.s, scroll: 0 } }
      return { ...ui, overlay: { kind: "entry", entry: sel.m, room: room.room, scroll: 0 } }
    }
    default: return ui
  }
}

// ── the loop ──────────────────────────────────────────────────────────────────

/**
 * Redraw on a timer rather than on `fs.watch`: the derived state depends on three files AND on
 * elapsed time (every age on screen goes stale on its own), so a watcher would have to be
 * paired with a timer anyway. One second of latency on a wall-mounted view costs nothing.
 */
export function runAdminTui({ intervalMs = 1000 } = {}) {
  let ui = normalizeUi({})
  let stopped = false
  let snap = snapshot({ window: ui.window })

  const draw = (refresh = true) => {
    if (stopped) return
    if (refresh) {
      // Scrolled to the top of the loaded window and there is more behind it? Load further
      // back on the next pass. `history` is `slice(-limit)`, so this needs no core change.
      const chan = paneRows(snap, ui, "channels")
      const room = chan.rows[cursorOf(ui, "channels", chan.rows)]?.r
      const flow = paneRows(snap, ui, "flow", room)
      if (ui.pane === "flow" && room && cursorOf(ui, "flow", flow.rows) === 0 && room.total > flow.all.length) {
        ui = { ...ui, window: ui.window * 2 }
      }
      snap = snapshot({ window: ui.window })
    }
    // The flow follows new entries only while the cursor is on the newest one. A view that
    // jumps while you are reading older traffic is unusable exactly when there is traffic.
    if (ui.follow) ui = { ...ui, sel: { ...ui.sel, flow: null } }
    process.stdout.write(home + `${ESC}0J` + render(snap, ui) + `${ESC}0J`)
  }

  const quit = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    process.stdout.removeListener("resize", onResize)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(cursorVisible(true) + alt(false))
  }

  const onResize = () => draw(false)

  process.stdout.write(alt(true) + cursorVisible(false) + clear)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf-8")
  process.stdin.on("data", key => {
    // Ctrl-C arrives as a byte here, not as SIGINT, once the terminal is in raw mode — without
    // this the only way out would be closing the terminal, with the alternate screen left on.
    if (key === "\x03") { quit(); process.exit(0) }
    // `q` and Esc only quit at the top level: inside an overlay or a search box they mean
    // "close this", which `handleKey` decides.
    if (key === "q" && !ui.overlay && !ui.typing) { quit(); process.exit(0) }
    if (key === "r" && !ui.typing) { draw(); return }
    const next = handleKey(snap, ui, key)
    if (next !== ui) { ui = next; draw(false) }
  })
  process.stdout.on("resize", onResize)
  process.on("exit", quit)
  process.on("SIGINT", () => { quit(); process.exit(0) })
  process.on("SIGTERM", () => { quit(); process.exit(0) })

  const timer = setInterval(() => draw(), intervalMs)
  draw(false)
}

/** Exported for the tests: the pure half, with the filesystem already read. */
export { render, wakesSeat, snapshot, trunc, width, handleKey, normalizeUi, wrap, KEYS }
