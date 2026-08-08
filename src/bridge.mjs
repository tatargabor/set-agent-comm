// The BRIDGE — the client half of the remote leg. It has one job: make a message from another
// machine indistinguishable, once it lands, from one written next door.
//
// Incoming entries are appended to the remote writer's file IN THE LOCAL ROOM. From that moment
// `inbox`, the read cursor, `sibling`, the Stop hook and the skill all work on it without
// knowing it came over the wire. Nothing downstream had to learn about the network — which is
// why the remote leg is an addition and not a rewrite.
//
// The local log stays the source of truth. `send` writes locally first and uploads after, so a
// dead relay is a delay, never a lost message: the outbox cursor picks it up on the next push.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { hostname } from "node:os"
import { createHash } from "node:crypto"
import { ROOT, busFiles, busFile, history, ingest, parseRooms, parseTo } from "./store.mjs"
import { encrypt, decrypt, entryAad } from "./crypto.mjs"

const CONFIG = join(ROOT, "relays.json")

export const readConfig = () => {
  try { return JSON.parse(readFileSync(CONFIG, "utf8")) } catch { return { rooms: {} } }
}

export function writeConfig(cfg) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n")
  // It holds device tokens and room keys. Anyone who can read this file can post as us and
  // decrypt the room, so it is not world-readable — the store's other files are harmless.
  try { chmodSync(CONFIG, 0o600) } catch { /* best effort, e.g. on a filesystem without modes */ }
}

/**
 * A relay URL is only accepted over HTTPS — or over a link that is already encrypted end to
 * end anyway (loopback, a LAN, a Tailscale tailnet).
 *
 * The device token travels in a header on every single call. Over plain `http://` on the open
 * internet, anyone on the path reads it once and can post into the room from then on. They
 * still could not FORGE a message — that takes the room key, which never leaves these machines
 * — but they could flood it, and the fix is one line: refuse the URL.
 */
export function assertSecureUrl(url) {
  let u
  try { u = new URL(url) } catch { throw new Error(`not a URL: ${url}`) }
  if (u.protocol === "https:") return u.origin
  const h = u.hostname
  const parts = h.split(".")
  const isPrivate = h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" ||
    h.endsWith(".local") || h.endsWith(".ts.net") ||          // mDNS, Tailscale MagicDNS
    h.startsWith("192.168.") || h.startsWith("10.") ||         // RFC1918
    (parts[0] === "172" && +parts[1] >= 16 && +parts[1] <= 31) ||
    (parts[0] === "100" && +parts[1] >= 64 && +parts[1] <= 127) // Tailscale CGNAT range
  if (u.protocol === "http:" && isPrivate) return u.origin
  throw new Error(
    `refusing ${u.protocol}//${h}: the device token would travel unencrypted. ` +
    `Use https://, or plain http only on loopback, a LAN or a Tailscale address.`)
}

/** This machine's name in remote writer names (`web-app@macmini#3f9c1a20`). */
export const deviceName = () =>
  (process.env.SET_AGENT_DEVICE || hostname().split(".")[0]).replace(/[^A-Za-z0-9._-]/g, "-")

export const roomConfig = room => readConfig().rooms?.[room] || null
export const remoteRooms = () => Object.keys(readConfig().rooms || {})

/** A local writer never carries `@`; a remote one always does. That is the whole test. */
export const isRemote = writer => writer.includes("@")

/**
 * `web-app#3f9c1a20` + `macmini` → `web-app@macmini#3f9c1a20`.
 *
 * The device goes BEFORE the seat, not after, so that `seatBase` yields `web-app@macmini` —
 * "that project on that machine". Same project name on two machines is two participants, and
 * the grouping has to say so; appended at the end, the two would collapse into one.
 */
export const remoteName = (writer, ns) => {
  const i = writer.indexOf("#")
  return i === -1 ? `${writer}@${ns}` : `${writer.slice(0, i)}@${ns}${writer.slice(i)}`
}

/**
 * The inverse, applied to an ADDRESSEE on the way in: on `macmini`, `web-app@macmini` is
 * `web-app` and `web-app@macmini#3f9c1a20` is `web-app#3f9c1a20`. Anything naming another
 * machine is left exactly as written.
 *
 * ⚠ Measured on 2026-08-07, in the first cross-machine room with two participants: the name
 * the room SHOWS you for a remote seat was not an address that reached it. B addressed
 * `set-agent-comm@tgdesktop` — the only name it had ever seen for A — and on A the entry
 * arrived `(not for you)`, waking nobody. `addressForms` strips the machine off MY name, but A's
 * own seat is local (`set-agent-comm#99f6550b`) and carries no `@tgdesktop` to strip. So the
 * remote form matched nothing, and the sender had no way to know: on B that name is in the
 * roster, so `send`'s misspelt-addressee check passed. It is exactly the failure the asymmetry
 * in `parseTo` exists to prevent — a message nobody is woken for — reached by using the
 * CORRECT name, and it takes two machines to see it.
 *
 * The translation belongs here rather than in `addressForms`, for the reason this whole module
 * exists: the namespace is a property of the room's relay config, and `store.mjs` neither knows
 * nor should know that a network was involved. What crosses the wire is normalised at the wire.
 */
export const localName = (name, ns) => {
  const i = String(name).indexOf("#")
  const base = i === -1 ? String(name) : String(name).slice(0, i)
  const seat = i === -1 ? "" : String(name).slice(i)
  return base.endsWith(`@${ns}`) ? base.slice(0, -(ns.length + 1)) + seat : name
}

/**
 * SAYING A RELAY IS DOWN COSTS A TURN. The watcher's stdout is not a log file — it is the event
 * stream that starts a session's turn, so a line printed there is an interruption in the same
 * sense a message is, and the one rule of this bus applies to our own housekeeping too.
 *
 * ⚠ Measured 2026-08-07, on this project's own room: the relay returned 502 three times in an
 * evening, each one a transient the retry loop absorbed within a second — and each one woke a
 * session, on this model, with this project's context behind it. Three of the five events that
 * watch produced all night were the watcher complaining about something it had already fixed.
 * Ten consecutive long polls measured straight afterwards all returned 200: nothing was wrong.
 *
 * So: silence while retrying is still plausibly working, one line when it stops being plausible,
 * one line when it comes back — and never a word about a blip nobody could have acted on.
 * `after` × the backoff means the first word lands about half a minute into a real outage.
 */
export function outageLog({ report, after = 5 }) {
  let failures = 0, announced = false
  return {
    failed(what) {
      if (++failures < after || announced) return
      announced = true
      report(`${what} — ${failures} attempts, still retrying; local messages are unaffected`)
    },
    recovered(what) {
      if (announced) report(what)
      failures = 0
      announced = false
    },
  }
}

const entryId = (writer, ts) => createHash("sha256").update(`${writer}|${ts}`).digest("base64url").slice(0, 22)

const api = async (cfg, path, init = {}) => {
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}`, ...init.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `relay ${res.status}`)
  return body
}

/**
 * Upload what this machine has written and the relay has not seen.
 *
 * The outbox cursor is per writer file, not a single global mark: files are independent logs,
 * and one file failing to upload may not hold back the others. Entries are re-sent freely after
 * a relay restart — the receiver drops what it already has by id, so re-sending is cheap and
 * safe, while NOT re-sending would silently lose a message.
 */
export async function push({ room, log = () => {} }) {
  const cfg = roomConfig(room)
  if (!cfg) return { skipped: "no relay configured for this room" }
  const ns = cfg.namespace || deviceName()
  const outbox = cfg.outbox || {}
  const entries = []

  for (const path of busFiles(room)) {
    const writer = path.split("/").pop().replace(/\.md$/, "")
    if (isRemote(writer)) continue                       // never bounce someone else's entries back
    const from = remoteName(writer, ns)
    const since = outbox[writer] ? Date.parse(outbox[writer]) : 0
    for (const e of history({ room, from: writer, limit: 10_000 }).messages) {
      if (Date.parse(e.ts) <= since) continue
      entries.push({
        id: entryId(from, e.ts),
        writer: from,
        ts: e.ts,
        // The addressee travels INSIDE the ciphertext, with the text: who a message is for is
        // as much the room's business as what it says, and the relay is not entitled to either.
        cipher: encrypt(cfg.roomKey, JSON.stringify({ type: e.type, re: e.re, text: e.text, to: e.to }),
                        entryAad(from, e.ts)),
        _writer: writer,
      })
    }
  }
  if (!entries.length) return { pushed: 0 }

  const out = await api(cfg, `/rooms/${room}/entries`, {
    method: "POST",
    body: JSON.stringify({ entries: entries.map(({ _writer, ...e }) => e) }),
  })
  if (cfg.epoch && out.epoch !== cfg.epoch) {
    // ⚠ Measured: without this the push SILENTLY HID the restart from the pull. It stored the
    // new epoch as a side effect, the pull then saw nothing to reset, and everything uploaded
    // before the restart — which the relay no longer had — was never sent again. The outbox is
    // a record of what the relay has; when the relay forgets, the record is void.
    save(room, { epoch: out.epoch, outbox: {}, cursor: 0 })
    log(`relay restarted — re-uploading "${room}"`)
    return push({ room, log })
  }
  // The cursor moves only after the relay has confirmed. A cursor that runs ahead of the
  // upload is the one bug that would lose a message permanently, with nothing left to retry.
  for (const e of entries) if (!outbox[e._writer] || Date.parse(outbox[e._writer]) < Date.parse(e.ts)) outbox[e._writer] = e.ts
  save(room, { outbox, epoch: out.epoch })
  log(`pushed ${entries.length} to ${room}`)
  return { pushed: entries.length, accepted: out.accepted }
}

/**
 * Fetch what the others wrote and write it into the local room.
 *
 * `wait` seconds is a long poll: the relay holds the request open until something arrives, so
 * a remote message shows up as fast as a local one — the same shape as `sac wait` itself.
 */
export async function pull({ room, wait = 25, log = () => {} }) {
  const cfg = roomConfig(room)
  if (!cfg) return { skipped: "no relay configured for this room" }
  const ns = cfg.namespace || deviceName()
  const q = `after=${cfg.cursor || 0}&wait=${wait}` + (cfg.epoch ? `&epoch=${encodeURIComponent(cfg.epoch)}` : "")
  const out = await api(cfg, `/rooms/${room}/entries?${q}`)

  if (out.reset) {
    // The relay was restarted (a redeploy, a crash): our cursor belongs to a previous life of
    // it. Start from zero and re-upload — duplicates are dropped by id, gaps would not be.
    //
    // ⚠ And then FETCH AGAIN in the same call. Measured: returning here made a `sync` right
    // after a restart report "nothing new" — it had only reset the cursor. Indistinguishable,
    // from the outside, from a quiet room, which is the failure this project keeps hunting.
    log(`relay restarted (new epoch) — resyncing "${room}"`)
    save(room, { cursor: 0, epoch: out.epoch, outbox: {} })
    return { ...(await pull({ room, wait: 0, log })), reset: true }
  }

  let written = 0
  for (const e of out.entries || []) {
    let body
    // The sender and the timestamp are AAD (see `entryAad`), so this decrypt is also the
    // authorship check: an entry served under a name other than the one it was written under
    // fails here, and no room key is needed to attempt that re-attribution — only the relay.
    try { body = JSON.parse(decrypt(cfg.roomKey, e.cipher, entryAad(e.writer, e.ts))) } catch {
      // Wrong key, tampered payload, or a forged sender. LOUD, and we move on: silently
      // skipping would look exactly like an empty room, and stopping would block every later
      // entry too.
      log(`⚠ refused an entry from ${e.writer} in "${room}" — wrong room key, ` +
        `a tampered payload, or a sender that does not match what was signed`)
      continue
    }
    // A writer name becomes a FILE NAME on this machine. `ingest` refuses one that would leave
    // the room's directory; that refusal must drop the entry, not the whole batch.
    try {
      // The addressee is translated into THIS machine's names before it is written: from here
      // on the entry is indistinguishable from a local one, which is the whole job (see
      // `localName`). Names on other machines pass through untouched — the room stays readable
      // to everyone, and only who gets WOKEN depends on this.
      if (ingest({ room, writer: e.writer, ts: e.ts, type: body.type, re: body.re, text: body.text,
                   to: parseTo(body.to).map(n => localName(n, ns)) })) written++
    } catch (err) {
      log(`⚠ refused an entry from ${e.writer} in "${room}": ${err.message}`)
    }
  }
  save(room, { cursor: out.seq, epoch: out.epoch })
  if (written) log(`received ${written} in ${room}`)
  return { received: written, seq: out.seq }
}

function save(room, patch) {
  const cfg = readConfig()
  cfg.rooms[room] = { ...cfg.rooms[room], ...patch }
  writeConfig(cfg)
}

/**
 * Push, and REPORT what happened — the shape every caller needs, so that "the relay is down"
 * can never be dressed up as a delivered message. Never throws: the entry is already on disk.
 */
export async function pushReport(room) {
  if (!roomConfig(room)) return {}
  try { const r = await push({ room }); return { relay: `pushed ${r.pushed ?? 0}` } }
  catch (e) { return { relay: `queued (relay unreachable: ${e.message})` } }
}

/**
 * Fetch anything waiting on the relay before a read. Same rule in reverse: "nothing new here"
 * must not be the answer when the message is sitting one HTTP call away.
 */
export async function pullReport(room) {
  if (!roomConfig(room)) return {}
  try { const r = await pull({ room, wait: 0 }); return r.received ? { relayReceived: r.received } : {} }
  catch (e) { return { relay: `not fetched (relay unreachable: ${e.message})` } }
}

/** Every room that has a relay AND is in this session's room list. */
export const bridgedRooms = value => {
  const configured = new Set(remoteRooms())
  return parseRooms(value).filter(r => configured.has(r))
}
