#!/usr/bin/env node
/**
 * Streamable-HTTP belépő — egy daemon, bármennyi kliens. A set-designer/mcp/src/http.ts
 * mintája (transport-map `mcp-session-id` szerint, 127.0.0.1-re kötve).
 *
 * ⚠ AZ IDENTITÁS AZ URL-ÚTVONALBÓL JÖN, nem a tool-hívásból:
 *
 *   claude mcp add --transport http agent-comm http://127.0.0.1:7510/mcp/consumer-a
 *                                                                    ^^^^^^^^ ez az agent
 *
 * Így az agent neve a projekt MCP-konfigjában él, nem egy paraméterben, amit a modell
 * hívásonként megválaszthatna — vagyis egy agent nem tud más nevében üzenetet írni.
 * A `?room=` opcionális alapértelmezett szoba.
 *
 * A stdio mód (src/stdio.mjs) ennél is szigorúbb (cwd-ből jön az identitás) — ez a HTTP mód
 * akkor való, ha egy daemon kell, vagy nem-Claude-Code kliens is csatlakozik.
 */
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer } from "./tools.mjs"

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
      error: "Az útvonal /mcp/<agent-név> alakú kell legyen — az agent neve az URL-ben van.",
    })
  }
  const agent = m[1]
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
            error: { code: -32000, message: "Nincs érvényes session id; előbb initialize kell" },
          })
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => transports.set(id, created),
        })
        created.onclose = () => { if (created.sessionId) transports.delete(created.sessionId) }
        // Az identitás a KAPCSOLATHOZ kötődik (az URL, amin bejött), nem a hívásokhoz.
        await createMcpServer(() => ({ agent, room })).connect(created)
        transport = created
      }
      return void await transport.handleRequest(req, res, body)
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) { res.writeHead(400); return res.end("Hiányzó vagy ismeretlen session id") }
      return void await transport.handleRequest(req, res)
    }

    res.writeHead(405); res.end()
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[set-agent-comm] Streamable HTTP: http://${HOST}:${PORT}/mcp/<agent>`)
})
server.on("error", e => console.error("[set-agent-comm] http hiba:", e?.message ?? e))
