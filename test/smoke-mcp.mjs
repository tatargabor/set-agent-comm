#!/usr/bin/env node
// SMOKE TEST: two separate MCP clients (= two agents) really do talk to each other over the
// stdio server. It does not measure the call but the result: what one sends, the other
// RECEIVES — and does not get its own message back. Runs against a throwaway store, it never
// touches the live one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, "..", "src", "stdio.mjs")
const ROOT = mkdtempSync(join(tmpdir(), "sac-smoke-"))
const ROOM = "team"
const ok = m => console.log(`  ✔ ${m}`)

async function connect(agent, room = ROOM) {
  const client = new Client({ name: `smoke-${agent}`, version: "0" }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: agent, SET_AGENT_ROOM: room },
  }))
  return client
}
const raw = (c, name, args = {}) => c.callTool({ name, arguments: args })
const call = async (c, name, args = {}) => {
  const r = await raw(c, name, args)
  assert.ok(!r.isError, `${name} returned an error: ${r.content?.[0]?.text}`)
  return JSON.parse(r.content[0].text)
}

console.log(`\nset-agent-comm smoke test — store: ${ROOT}\n`)
const web = await connect("web-app")
const api = await connect("api-service")

try {
  const tools = (await web.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(tools, ["agents", "history", "inbox", "rooms", "send"])
  ok(`both servers came up, 5 tools: ${tools.join(", ")}`)

  await call(web, "send", { type: "REQUEST", text: "Need the new field on the orders endpoint." })
  ok("web-app sent a REQUEST")

  const inb = await call(api, "inbox")
  assert.equal(inb.unread, 1, "api-service did not receive the message")
  assert.equal(inb.messages[0].from, "web-app")
  assert.match(inb.messages[0].text, /orders/)
  ok(`api-service received it: "${inb.messages[0].text}"`)

  assert.equal((await call(api, "inbox")).unread, 0)
  ok("nothing unread the second time — the cursor advanced")

  await call(api, "send", { type: "ANSWER", text: "Shipped, it is in the response now.", re: inb.messages[0].ts })
  const back = await call(web, "inbox")
  assert.equal(back.unread, 1)
  assert.equal(back.messages[0].from, "api-service")
  assert.equal(back.messages[0].re, inb.messages[0].ts)
  ok("api-service answered, web-app received it — the `re:` reference survived")

  assert.equal((await call(web, "inbox")).unread, 0)
  ok("NEITHER of them got its own message back")

  const reg = await call(web, "agents")
  assert.deepEqual(reg.map(a => a.agent).sort(), ["api-service", "web-app"])
  assert.ok(reg.every(a => typeof a.silentMinutes === "number"))
  ok(`the registry sees both: ${reg.map(a => `${a.agent}(${a.silentMinutes}m)`).join(", ")}`)

  const h = await call(web, "history")
  assert.equal(h.total, 2)
  assert.deepEqual(h.messages.map(m => m.from), ["web-app", "api-service"])
  ok("history returns both sides in chronological order")

  // An agent in two rooms: no default room, so an unrouted `send` must FAIL rather than
  // guess. A message delivered to the wrong audience cannot be taken back.
  const both = await connect("web-app", `${ROOM},design`)
  const refused = await raw(both, "send", { type: "FACT", text: "which room?" })
  assert.ok(refused.isError, "send without a room silently picked a room")
  assert.match(refused.content[0].text, /several rooms \(team, design\)/)
  ok("in two rooms an unrouted `send` fails loudly, naming both rooms")

  await call(both, "send", { room: "design", type: "FACT", text: "routed by hand" })
  assert.equal((await call(both, "history", { room: "design" })).total, 1)
  assert.equal((await call(web, "history")).total, 2, "the message leaked into the other room")
  ok("with an explicit room it goes through, and the other room stays untouched")
  await both.close().catch(() => {})

  console.log("\n✅ SMOKE TEST GREEN — two agents talked to each other over MCP.\n")
} finally {
  await web.close().catch(() => {})
  await api.close().catch(() => {})
  rmSync(ROOT, { recursive: true, force: true })
}
