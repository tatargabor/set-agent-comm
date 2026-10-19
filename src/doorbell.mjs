// The doorbell's I/O — posting one line into a session's own inbox socket.
//
// Kept OUT of the core on purpose: `store.mjs` is synchronous (hooks and cron import it where there
// is no event loop to wait on), and a socket connect is not. The core decides who may be rung
// (`ringPlan`, `ringable`) and records it (`markRung`); this file only talks to the socket.
// `node:net` is a builtin, so the zero-dependency rule holds.
//
// Wire format, from the binary's own help text and measured live 2026-10-19
// (docs/native-messaging.md): newline-delimited JSON, `{"type":"user","message":{"role":"user",
// "content":"…"}}`. `from_name` is honoured as a display label. NO `from` (reply address): the
// receiver must answer on the bus, where the record is, not by a native reply that bypasses it.
import net from "node:net"
import * as store from "./store.mjs"

/**
 * One line, then close. Resolves — never rejects — with `{ ok }` or `{ ok: false, error }`, because
 * the entry is already on disk when this runs: a failed ring is a report, never a failed send.
 */
export function ring({ socket, text, fromName, timeoutMs = 2000 }) {
  return new Promise(resolve => {
    let settled = false
    const done = r => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const frame = JSON.stringify({ type: "user", message: { role: "user", content: text },
                                   ...(fromName && { from_name: fromName }) }) + "\n"
    const s = net.createConnection(socket)
    const timer = setTimeout(() => { s.destroy(); done({ ok: false, error: "timeout" }) }, timeoutMs)
    // Connect only when the line is ready, and send it whole: the harness closes a connection that
    // sends no complete line within 30 s (measured in its own help text).
    s.on("connect", () => s.end(frame))
    s.on("error", e => done({ ok: false, error: e.code || e.message }))
    s.on("close", hadError => { if (!hadError) done({ ok: true }) })
  })
}

/**
 * After `store.send`: ring every seat the plan allows, and report per seat. Called by BOTH faces
 * (MCP `send` and `sac send`), so the two cannot drift — the same reason `pushReport` is shared.
 */
export async function ringReport({ room, out, text: body = "" }) {
  if (process.env.SET_AGENT_DOORBELL === "off") return {}
  const entry = { ts: out.ts, from: out.from, type: out.type, to: out.to, text: body }
  const plan = store.ringPlan({ entry, room, woke: out.wakes })
  if (!plan.length) return {}
  const text = store.ringText({ entry, room })
  const fromName = store.labelOf(entry.from) || entry.from
  const rang = [], notRung = []
  await Promise.all(plan.map(async p => {
    // A seat with NO doorbell on record is the world as it was before this change (a session whose
    // hooks predate it): nothing to report, and reporting it on every send would bury the cases
    // that do need the sender's attention.
    if (!p.ok && p.why === "no-socket") return
    if (!p.ok) { notRung.push({ seat: p.seat, why: p.why, fallback: store.ringFallback(p, entry.from) }); return }
    const r = await ring({ socket: p.socket, text, fromName })
    if (r.ok) {
      store.markRung({ room, seat: p.seat, ts: entry.ts, from: entry.from })
      rang.push(p.seat)
    } else {
      const why = r.error === "ENOENT" || r.error === "ECONNREFUSED" ? "stale" : `failed (${r.error})`
      notRung.push({ seat: p.seat, why, fallback: store.ringFallback({ ...p, why }, entry.from) })
    }
  }))
  return { ...(rang.length && { rang }), ...(notRung.length && { notRung }) }
}
