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
        await createMcpServer(() => ({ agent, room })).connect(created)
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
  console.log(`[set-agent-comm] Streamable HTTP: http://${HOST}:${PORT}/mcp/<agent>`)
})
server.on("error", e => console.error("[set-agent-comm] http error:", e?.message ?? e))
