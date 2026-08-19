#!/usr/bin/env node
/**
 * Streamable-HTTP entry point — one daemon, any number of clients. Modelled on
 * set-designer/mcp/src/http.ts (transport map keyed by `mcp-session-id`, bound to 127.0.0.1).
 *
 * ⚠ IDENTITY COMES FROM THE URL PATH, not from the tool call:
 *
 *   claude mcp add --transport http agent-comm http://127.0.0.1:7510/mcp/web-app
 *                                                                    ^^^^^^^ this is the agent
 *
 * That way the agent's name lives in the project's MCP config, not in a parameter the model
 * could choose per call — meaning an agent cannot write a message in someone else's name.
 * `?room=` is an optional default room.
 *
 * The stdio mode (src/stdio.mjs) is stricter still (identity comes from the cwd) — this HTTP
 * mode is for when you need a daemon, or a non-Claude-Code client connects too.
 */
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer } from "./tools.mjs"
import * as store from "./store.mjs"

const PORT = parseInt(process.env.MCP_PORT || "7510", 10)
const HOST = process.env.MCP_HOST || "127.0.0.1"

const transports = new Map()

const readBody = req => new Promise(resolve => {
  let data = ""
  req.on("data", c => { data += c })
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : undefined) } catch { resolve(undefined) } })
  req.on("error", () => resolve(undefined))
})

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host ?? HOST}`)
  const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9._-]+)$/)
  if (!m) {
    return send(res, 404, {
      error: "The path must look like /mcp/<agent-name> — the agent's name is in the URL.",
    })
  }
  const agent = m[1]

  /**
   * ⚠ THE DOOR. Measured 2026-08-19: a process that was not that project at all connected to
   * `/mcp/api-service` and wrote as `api-service`, presenting nothing. On stdio that cannot
   * happen — identity is the cwd. This transport had no equivalent, and the gap was written down
   * nowhere.
   *
   * The rule is deliberately all-or-nothing, and it is checked on EVERY request rather than only
   * on `initialize`: a session id is not a credential, and a daemon that authenticated the
   * handshake alone would be a daemon anyone could continue.
   *
   *   tokens exist  → every connection must present a matching `Authorization: Bearer <token>`
   *                   for the agent named in its path. An unknown agent is refused, not admitted.
   *   no tokens     → the old behaviour, plus a warning at startup that says so. A defensive
   *                   measure that evaporates in silence is worse than not having taken it.
   *
   * Minted by `sac http-token <agent>`, whose intended caller is a FRAMEWORK that writes an
   * agent's MCP config: it knows the name and the secret at the moment it creates the agent, so
   * neither has to survive a `${VAR}` substitution that (measured, the same day) does not happen
   * in a window a person opened by hand. For that window, stdio remains the only unforgeable route.
   */
  if (Object.keys(store.httpTokens()).length) {
    const auth = req.headers.authorization || ""
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers["x-agent-token"] || "")
    if (!store.httpTokenOk(agent, Array.isArray(presented) ? presented[0] : presented)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
      return res.end(JSON.stringify({ error:
        `Not authorised as '${agent}'. This daemon has client tokens configured, so every ` +
        `connection must send 'Authorization: Bearer <token>' — mint one with ` +
        `\`sac http-token ${agent}\`.` }))
    }
  }

  const room = url.searchParams.get("room") || process.env.SET_AGENT_ROOM || null

  const sid = req.headers["mcp-session-id"]
  const sessionId = Array.isArray(sid) ? sid[0] : sid

  try {
    if (req.method === "POST") {
      const body = await readBody(req)
      let transport = sessionId ? transports.get(sessionId) : undefined

      if (!transport) {
        if (!isInitializeRequest(body)) {
          return send(res, 400, {
            jsonrpc: "2.0", id: null,
            error: { code: -32000, message: "No valid session id; initialize first" },
          })
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => transports.set(id, created),
        })
        created.onclose = () => { if (created.sessionId) transports.delete(created.sessionId) }
        // Identity is bound to the CONNECTION (the URL it came in on), not to the calls.
        // ⚠ `rooms` BELONGS HERE TOO. Without it the room rules (`store.resolveRoom` — which
        // room an addressed entry goes into, and which refusal you get) had nothing to work
        // with over HTTP, so the two transports answered the same question differently.
        // Resolved per call, like stdio's: a room joined since the connection came up counts.
        const configured = store.parseRooms(url.searchParams.get("room") || process.env.SET_AGENT_ROOM)
        await createMcpServer(() => {
          const mine = store.wakingRooms(agent, configured)
          return { agent, room: mine.length === 1 ? mine[0] : room, rooms: mine }
        }).connect(created)
        transport = created
      }
      return void await transport.handleRequest(req, res, body)
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) { res.writeHead(400); return res.end("Missing or unknown session id") }
      return void await transport.handleRequest(req, res)
    }

    res.writeHead(405); res.end()
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
})

server.listen(PORT, HOST, () => {
  const n = Object.keys(store.httpTokens()).length
  console.log(`[set-agent-comm] Streamable HTTP: http://${HOST}:${PORT}/mcp/<agent>`)
  console.log(n
    ? `[set-agent-comm] ${n} client token(s) configured — every connection must present one.`
    : `[set-agent-comm] ⚠ NO client tokens: any local process can connect as ANY agent and write ` +
      `in its name. That is not true of the stdio transport, where identity is the cwd. ` +
      `Mint one per agent with \`sac http-token <agent>\` and this daemon starts refusing the rest.`)
})
server.on("error", e => console.error("[set-agent-comm] http error:", e?.message ?? e))
