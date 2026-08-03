// A mag: nyilvántartó (ki létezik, ki él) + csatorna (ki mit mondott).
// Zéró futásidejű függőség — a hookok és a cron is hívják, ahol nincs node_modules.
//
// Protokoll (kiemelve a consumer-a ↔ set-core csatornából, 400 bejegyzésen bejáratva):
// EGY FÁJL, EGY ÍRÓ. Mindenki kizárólag a saját nevű fájljába appendel, a többiét olvassa.
// Így nincs lost update és nem kell lockfile — egy megszakadt session után a lock beragadna,
// és onnantól senki nem írna.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync,
         existsSync, renameSync, openSync, fsyncSync, closeSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, hostname } from "node:os"

export const ROOT = process.env.SET_AGENT_COMM_DIR
  || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "set-agent-comm")

const REGISTRY = join(ROOT, "registry.json")
const CHANNELS = join(ROOT, "channels")
const CURSORS = join(ROOT, "cursors.json")

export const TYPES = ["KÉRDÉS", "VÁLASZ", "TÉNY", "KÉRÉS"]

/**
 * ISO időbélyeg helyi eltolással, EZREDMÁSODPERCES felbontással.
 *
 * ⚠ Ez SOHA nem lehet fejből írt érték. Mérve 2026-07-24-én a régi, kézzel vezetett
 * csatornán: a valódi óra 10:50 volt, miközben az egyik fél `T16:50`-et állított (+6 óra),
 * a másik `T12:25`-öt (+1,5 óra) — *mindkét* agent találgatott. A hamis időbélyeg nem
 * kozmetika: az „a másik N perce néma" feltétel ezen áll, tehát vakká teszi a figyelőt.
 *
 * ⚠ A MÁSODPERC NEM ELÉG — mérve a saját füst-tesztünkön. Gépi tempónál a kérdés és a rá
 * adott válasz ugyanabba a másodpercbe esik; azonos időbélyegnél a rendezés a fájlnevek
 * ábécésorrendjére esik vissza, és a `history` a VÁLASZT adja vissza előbb. A szál némán
 * megfordul, és az azt olvasó agent félreérti. A régi, ms nélküli bejegyzések továbbra is
 * helyesen rendeződnek (ugyanabban a másodpercben a `.000` elé kerülnek).
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
 * Rendezési kulcs. VALÓDI idő szerint, nem string-összehasonlítással: a stringes rendezés
 * az óraátállításkor téved (`…T02:30+02:00` vs `…T02:30+01:00` ugyanaz a szöveg-előtag,
 * de egy óra különbség). Döntetlennél a hívó eredeti sorrendje marad (stabil sort).
 */
const t = ts => Date.parse(ts) || 0
const byTime = (a, b) => t(a.ts) - t(b.ts)

// ── atomikus JSON írás ────────────────────────────────────────────────────────
// tmp → fsync → rename. A `writeFileSync` a célfájlra crash esetén csonka JSON-t hagy,
// és onnantól a nyilvántartás elolvashatatlan — az AMQ-tól ellesett minta.
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

// ── nyilvántartó ──────────────────────────────────────────────────────────────

/** Egy agent bejelentkezése. Idempotens: ugyanaz a név frissül, nem duplázódik. */
export function register({ agent, project, session, room }) {
  if (!agent) throw new Error("register: `agent` kötelező")
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

/** Életjel — a `lastSeen` frissítése új session felvétele nélkül. */
export function heartbeat(agent) {
  const reg = readJson(REGISTRY, { agents: {} })
  if (!reg.agents[agent]) return null
  reg.agents[agent].lastSeen = now()
  writeJson(REGISTRY, reg)
  return reg.agents[agent]
}

/**
 * A nyilvántartott agentek. `silentMinutes`: mennyi ideje nem adott életjelet.
 *
 * ⚠ Az `alive` MINDIG null, ha nincs `lastSeen` — nem `false`. A „nem tudjuk" és a
 * „biztosan halott" két különböző állítás, és a hamis `false` a rossz irányba téved:
 * a hívó lemondana egy élő partnerről.
 */
export function agents() {
  const reg = readJson(REGISTRY, { agents: {} })
  return Object.values(reg.agents).map(a => {
    const ms = a.lastSeen ? Date.now() - new Date(a.lastSeen).getTime() : null
    return { ...a, silentMinutes: ms == null ? null : Math.round(ms / 60000) }
  }).sort((x, y) => (x.silentMinutes ?? 1e9) - (y.silentMinutes ?? 1e9))
}

// ── csatorna ──────────────────────────────────────────────────────────────────

export const channelDir = room => join(CHANNELS, room)
export const busFile = (room, agent) => join(channelDir(room), `${agent}.md`)

/** A szoba összes írófájlja — ezt regisztrálja a hook `watchPaths`-ként. */
export function busFiles(room) {
  try {
    return readdirSync(channelDir(room)).filter(f => f.endsWith(".md") && f !== "README.md")
      .map(f => join(channelDir(room), f)).sort()
  } catch { return [] }
}

/**
 * Bejegyzés hozzáfűzése a saját fájlhoz. APPEND, soha nem teljes újraírás.
 *
 * Ez a kiemelés legkonkrétabb nyeresége: a régi csatornán az agent `Write`/`Edit` toollal
 * írt, ami egy 555 KB-os fájl TELJES újraírása üzenetenként — a fájl a kontextusba kerül,
 * és két egyidejű írás közül az egyik némán elveszik.
 */
export function send({ room, from, type = "TÉNY", text, re }) {
  if (!room || !from) throw new Error("send: `room` és `from` kötelező")
  if (!text?.trim()) throw new Error("send: üres üzenet")
  if (!TYPES.includes(type)) throw new Error(`send: ismeretlen típus '${type}' (${TYPES.join(" | ")})`)
  const path = busFile(room, from)
  mkdirSync(dirname(path), { recursive: true })
  const ts = now()
  const head = `## ${ts} — ${type}${re ? ` (re: ${re})` : ""}`
  const body = text.trim()
  appendFileSync(path, `${existsSync(path) && statSync(path).size ? "\n" : ""}${head}\n${body}\n`)
  register({ agent: from, room })
  return { ts, room, from, type, path }
}

/** Egy fájl bejegyzései, legfrissebb alul (ahogy a fájlban állnak). */
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
      cur = { ts: m[1], type: m[2].trim(), re: m[3]?.trim() || null, from: agent, lines: [] }
    } else if (cur) cur.lines.push(line)
  }
  if (cur) out.push(cur)
  return out.map(e => ({ ...e, text: e.lines.join("\n").trim(), lines: undefined }))
}

/**
 * Új bejegyzések MÁSOKTÓL. A saját fájlt kihagyja — magunkat nem olvassuk vissza.
 * `advance: true` esetén a kurzor előre lép (elolvasottnak jelöl).
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
      // Idő szerint, nem stringesen — ugyanaz a buktató, mint a rendezésnél.
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
 * A kurzor VISSZAÁLLÍTÁSA — az utolsó `count` üzenet újra olvasatlan lesz.
 *
 * Mért igény (2026-08-03, az élesítés napján): egy `inbox` hívás a bemutatóhoz elnyelte az
 * egyetlen üzenetet a szobában, és nem volt mód visszahozni. Az `inbox` léptetése szándékos
 * — de visszavonhatatlannak lenni nem az: az „elolvastam" és az „elveszett" különben
 * megkülönböztethetetlen. (A bejegyzések maguk sosem vesznek el; csak a jelölés áll vissza.)
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

/** Visszaolvasás — a kurzort NEM mozgatja. */
export function history({ room, from, limit = 20 }) {
  const files = from ? [busFile(room, from)] : busFiles(room)
  const all = files.flatMap(p => parse(p, p.split("/").pop().replace(/\.md$/, "")))
  all.sort(byTime)
  return { room, total: all.length, messages: all.slice(-limit) }
}

/** Létező szobák. */
export function rooms() {
  try { return readdirSync(CHANNELS).filter(d => !d.startsWith(".")).sort() } catch { return [] }
}
