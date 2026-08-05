#!/usr/bin/env node
/**
 * The RELAY — the only piece that runs on a machine none of the agents sit at.
 *
 *   node src/relay.mjs            (or: npm run relay)
 *   PORT=…  RELAY_SECRET=…
 *
 * Two environment variables, no database, no volume, no migration. That is a design goal, not
 * an accident: this repo is MIT and someone else has to be able to run it in five minutes —
 * on Railway, on a VPS, in Docker, behind Tailscale, or on localhost for a test.
 *
 * WHAT IT IS NOT:
 *  - not the source of truth. Every machine keeps its own append-only log; this is a letterbox
 *    that forwards. Lose it entirely and no message is lost — see EPOCH below.
 *  - not an archive. Entries are dropped after RELAY_RETENTION_HOURS (default 168 = 7 days).
 *    An archive would have to be operated, and operating it is what we are avoiding.
 *  - not a reader. Bodies are AES-GCM ciphertext whose key never leaves the participants'
 *    machines (see crypto.mjs). The relay decides WHO may post, never learns WHAT.
 *
 * EPOCH — the answer to ephemeral disks. The relay holds entries in memory, so a restart (a
 * redeploy, a crash, a platform moving the container) starts a fresh `epoch`. A client that
 * polls with a cursor from an older epoch is told `reset: true`, and re-uploads its recent
 * entries. Duplicates are harmless: every entry has a stable id, and the receiver drops what
 * it already has. So the failure mode of "the relay lost everything" is a few kilobytes of
 * re-upload — never a silently missing message.
 */
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { verify, issue, adminToken, equal } from "./crypto.mjs"

const PORT = parseInt(process.env.PORT || "7511", 10)
const HOST = process.env.RELAY_HOST || "0.0.0.0"
const SECRET = process.env.RELAY_SECRET || ""
const RETENTION_MS = parseFloat(process.env.RELAY_RETENTION_HOURS || "168") * 3600_000
const DEVICE_TTL = parseInt(process.env.RELAY_DEVICE_TTL_DAYS || "365", 10) * 86400
const MAX_ENTRY_BYTES = 256 * 1024
const POLL_MAX_MS = 30_000

if (!SECRET) {
  console.error("[relay] RELAY_SECRET is not set — refusing to start.\n" +
    "        Without it anyone could post into any room. Generate one:\n" +
    "          node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"")
  process.exit(1)
}

const EPOCH = randomUUID()
const rooms = new Map()          // room -> { seq, entries: [], waiters: [] }
const usedInvites = new Map()    // jti -> expiry (see /join)

// ── rate limiting ─────────────────────────────────────────────────────────────
/**
 * The endpoint is on the public internet the moment it is deployed, so the question is not
 * whether someone will knock, but what happens when they do.
 *
 * What it does NOT defend against, so that nobody reads more into it than it gives: forging an
 * entry (the room key does that — see crypto.mjs), and a determined distributed flood. What it
 * DOES: a stolen device token cannot fill the room in seconds, and `/join` cannot be hammered.
 * Guessing a token or an invite is hopeless anyway — both are HMAC-SHA256 — but "hopeless at
 * unlimited speed" is still a free bandwidth bill.
 *
 * In memory, per minute, keyed by token where there is one and by IP where there is not.
 * Nothing to configure, nothing to operate — the same rule as the rest of the relay.
 */
const LIMITS = {
  join: parseInt(process.env.RELAY_LIMIT_JOIN || "10", 10),       // per minute, per IP
  post: parseInt(process.env.RELAY_LIMIT_POST || "120", 10),      // per minute, per token
  poll: parseInt(process.env.RELAY_LIMIT_POLL || "60", 10),       // per minute, per token
}
const hits = new Map()

function overLimit(kind, key) {
  const now = Date.now()
  const slot = Math.floor(now / 60_000)
  const id = `${kind}:${key}:${slot}`
  // Sweep whenever the map grows: a leak on a public endpoint is a slow outage.
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(`:${slot}`)) hits.delete(k)
  const n = (hits.get(id) || 0) + 1
  hits.set(id, n)
  return n > LIMITS[kind]
}

const tooMany = (res, retryAfter = 60) => {
  res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfter) })
  res.end(JSON.stringify({ error: "rate limit exceeded — slow down" }))
}

/** The caller's address. Behind a platform proxy the socket address is the proxy's. */
const clientIp = req => {
  const fwd = req.headers["x-forwarded-for"]
  return (Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim() ||
    req.socket.remoteAddress || "unknown"
}

/**
 * A name that must never become a path or a header line. The receiving machine turns `writer`
 * into a FILE NAME and writes `ts` verbatim into an entry's header — measured 2026-08-05, a
 * writer of `../../../../pwned@mac#1` landed a file four directories above the store, and the
 * relay's namespace check waved it through because it only ever looked at the `@ns` part.
 * The client refuses it too; a letterbox that hands out such a name to everyone in the room
 * is a bad letterbox.
 */
const unsafeName = v => {
  const s = String(v ?? "")
  return !s || s.length > 200 || /[\\/\u0000-\u001f]/.test(s) ||
    s.split(/[@#]/).some(p => p === "." || p === "..")
}

/** The device namespace inside a writer name: `web-app@macmini#3f9c1a20` → `macmini`. */
const nsOf = writer => (String(writer).split("@")[1] || "").split("#")[0]

const room = name => {
  if (!rooms.has(name)) rooms.set(name, { seq: 0, entries: [], waiters: [] })
  return rooms.get(name)
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

// ⚠ CHUNKS ARE BYTES, and they are kept as bytes until the end. `data += chunk` decodes each
// chunk on its own, so a multi-byte character split across a boundary becomes two replacement
// characters — an accented project name in a writer would corrupt at ~64 KB, intermittently.
const readBody = req => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on("data", c => {
    size += c.length
    if (size > 4 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return }
    chunks.push(c)
  })
  req.on("end", () => {
    const data = Buffer.concat(chunks).toString("utf8")
    try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
  })
  req.on("error", reject)
})

const bearer = req => (req.headers.authorization || "").replace(/^Bearer\s+/i, "")

/** Everyone waiting on this room gets what just arrived — this is the push half of the poll. */
function wake(r) {
  const waiters = r.waiters.splice(0)
  for (const w of waiters) w()
}

/**
 * Retention is a TIME limit, and time alone is not a ceiling: 4 MB per request, ~16 entries in
 * each, 120 posts a minute is half a gigabyte a minute — one valid token could take the relay
 * down in about that long, and it holds everything in memory. So a room also has a hard count
 * and a hard size, and the OLDEST go first: the local logs are the source of truth, and a
 * client that falls behind resyncs. Losing the tail of a letterbox is recoverable; losing the
 * process is not.
 */
const MAX_ROOM_ENTRIES = parseInt(process.env.RELAY_MAX_ROOM_ENTRIES || "5000", 10)
const MAX_ROOM_BYTES = parseInt(process.env.RELAY_MAX_ROOM_MB || "64", 10) * 1024 * 1024

function prune(r) {
  const cutoff = Date.now() - RETENTION_MS
  const keep = r.entries.findIndex(e => e.at >= cutoff)
  if (keep > 0) r.entries.splice(0, keep)
  if (r.entries.length > MAX_ROOM_ENTRIES) r.entries.splice(0, r.entries.length - MAX_ROOM_ENTRIES)
  let bytes = r.entries.reduce((n, e) => n + e.cipher.length, 0)
  while (bytes > MAX_ROOM_BYTES && r.entries.length > 1) bytes -= r.entries.shift().cipher.length
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const path = url.pathname

  try {
    // Liveness, for the platform's health check. Deliberately says nothing about rooms.
    if (req.method === "GET" && (path === "/" || path === "/health"))
      return json(res, 200, { ok: true, service: "set-agent-comm relay", epoch: EPOCH })

    // ── join: an invite code becomes a lasting device token ────────────────────
    if (req.method === "POST" && path === "/join") {
      // Per IP: an invite is HMAC-signed, so guessing is hopeless — but hopeless at unlimited
      // speed still costs bandwidth, and a public endpoint gets knocked on.
      if (overLimit("join", clientIp(req))) return tooMany(res)
      const { code, device } = await readBody(req)
      const claims = verify(SECRET, code)
      if (!claims || claims.kind !== "invite") return json(res, 401, { error: "invalid or expired invite" })
      // Single use is BEST EFFORT: the set lives in memory, so a restart forgets it and a code
      // could be replayed until it expires. Stated rather than hidden — the window is the
      // invite's TTL (15 minutes by default), and the fix if it matters is a shorter TTL.
      if (usedInvites.has(claims.jti)) return json(res, 409, { error: "invite already used" })
      // Kept only until the invite would expire anyway — beyond that the entry proves nothing,
      // and an unbounded set on a public endpoint is a slow leak.
      for (const [jti, exp] of usedInvites) if (exp < Date.now()) usedInvites.delete(jti)
      usedInvites.set(claims.jti, claims.exp * 1000)
      // ⚠ THE INVITE DECIDES THE NAME, not the joiner. Measured 2026-08-05: with the joiner's
      // wish first, whoever redeemed an invite could ask for a namespace ALREADY IN USE in that
      // room — and from then on write, legitimately signed, under another machine's writer
      // names. The joiner may only choose when the inviter left it open.
      const namespace = String(claims.device || device || "device").replace(/[^A-Za-z0-9._-]/g, "-")
      return json(res, 200, {
        token: issue(SECRET, { kind: "device", room: claims.room, ns: namespace }, DEVICE_TTL),
        room: claims.room,
        namespace,
        epoch: EPOCH,
      })
    }

    // ── invite: minted by whoever holds RELAY_SECRET ──────────────────────────
    // Normally the CLI mints invites locally (it has the secret), so this endpoint is for the
    // case where only the relay knows it. Same authority either way.
    if (req.method === "POST" && path === "/invite") {
      // Timing-safe, like every other secret comparison here: `!==` on a string leaks its
      // matching prefix, and this one mints invites.
      if (!equal(bearer(req), adminToken(SECRET))) return json(res, 401, { error: "admin token required" })
      const { room: roomName, device, ttl = 900 } = await readBody(req)
      if (!roomName) return json(res, 400, { error: "`room` is required" })
      return json(res, 200, {
        code: issue(SECRET, { kind: "invite", room: roomName, device, jti: randomUUID() }, ttl),
      })
    }

    const m = path.match(/^\/rooms\/([A-Za-z0-9._-]+)\/entries$/)
    if (m) {
      const claims = verify(SECRET, bearer(req))
      if (!claims || claims.kind !== "device") return json(res, 401, { error: "invalid or expired token" })
      if (claims.room !== m[1]) return json(res, 403, { error: `this token is for room '${claims.room}'` })
      // Per token, not per IP: a stolen token is the realistic threat here, and it may not be
      // able to fill the room faster than the participants can notice.
      if (overLimit(req.method === "POST" ? "post" : "poll", `${claims.ns}:${claims.room}`))
        return tooMany(res)
      const r = room(m[1])

      // ── post ────────────────────────────────────────────────────────────────
      if (req.method === "POST") {
        const body = await readBody(req)
        const incoming = Array.isArray(body.entries) ? body.entries : []
        const accepted = []
        for (const e of incoming) {
          if (!e?.id || !e?.writer || !e?.cipher) continue
          if (String(e.cipher).length > MAX_ENTRY_BYTES) continue
          // The namespace in the token is enforced, not trusted from the body: a device may
          // only write under the name it was issued for. This is the whole point of the token —
          // the local `cwd`-based identity cannot reach across the network, so THIS is what
          // stands in for it, and a name is only worth the token behind it.
          if (nsOf(e.writer) !== claims.ns) continue
          // A writer name becomes a FILE NAME on every receiving machine. The client checks it
          // too, but a name that could leave the room's directory has no business being stored
          // and handed to everyone else in the first place.
          if (unsafeName(e.writer) || unsafeName(e.ts)) continue
          // ⚠ DEDUP ON (writer, ts), DERIVED HERE — never on the client's `id`. The id is
          // `sha256(writer|ts)`, so it is PREDICTABLE: a member could post entries carrying the
          // ids another writer's future entries will have, and the real ones would then be
          // dropped here as duplicates. Silently. That is the failure mode this whole project
          // is built against, and it would have been reachable from inside the room.
          const key = `${e.writer}|${e.ts}`
          if (r.entries.some(x => x.key === key)) continue
          const stored = { key, id: e.id, writer: e.writer, ts: e.ts, cipher: e.cipher, seq: ++r.seq, at: Date.now() }
          r.entries.push(stored)
          accepted.push(e.id)
        }
        prune(r)
        if (accepted.length) wake(r)
        return json(res, 200, { epoch: EPOCH, seq: r.seq, accepted: accepted.length, rejected: incoming.length - accepted.length })
      }

      // ── long poll ───────────────────────────────────────────────────────────
      if (req.method === "GET") {
        const after = parseInt(url.searchParams.get("after") || "0", 10)
        const since = url.searchParams.get("epoch")
        // A cursor from a previous life of this relay cannot be compared with the current seq —
        // saying "nothing new" to it would be a lie that loses messages silently.
        if (since && since !== EPOCH)
          return json(res, 200, { epoch: EPOCH, reset: true, seq: r.seq, entries: [] })

        const mine = () => r.entries.filter(e => e.seq > after && nsOf(e.writer) !== claims.ns)
        const waitMs = Math.min(parseInt(url.searchParams.get("wait") || "25", 10) * 1000, POLL_MAX_MS)
        let batch = mine()
        if (!batch.length && waitMs > 0) {
          await new Promise(resolve => {
            const timer = setTimeout(() => {
              r.waiters = r.waiters.filter(w => w !== fire)
              resolve()
            }, waitMs)
            const fire = () => { clearTimeout(timer); resolve() }
            r.waiters.push(fire)
            // A client that hangs up must not leave a waiter (and a timer) behind for 25s.
            req.on("close", fire)
          })
          batch = mine()
        }
        return json(res, 200, { epoch: EPOCH, seq: r.seq, entries: batch })
      }
    }

    json(res, 404, { error: "not found" })
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e?.message || String(e) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[relay] set-agent-comm relay on ${HOST}:${PORT}  ·  epoch ${EPOCH}` +
    `  ·  retention ${Math.round(RETENTION_MS / 3600_000)}h` +
    `  ·  limits ${LIMITS.join}/min join, ${LIMITS.post}/min post, ${LIMITS.poll}/min poll` +
    `  ·  ceiling ${MAX_ROOM_ENTRIES} entries / ${Math.round(MAX_ROOM_BYTES / 1024 / 1024)} MB per room`)
})
server.on("error", e => { console.error("[relay]", e?.message ?? e); process.exit(1) })
