#!/usr/bin/env node
// FÜST-TESZT: két külön MCP-kliens (= két agent) tényleg beszél egymással a stdio szerveren.
// Nem a hívást méri, hanem az eredményt: amit az egyik küld, azt a másik MEGKAPJA — és
// magát nem kapja vissza. Eldobható tárral fut, az éleshez nem nyúl.
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
const ROOM = "consumer-a-set"
const ok = m => console.log(`  ✔ ${m}`)

async function connect(agent) {
  const client = new Client({ name: `smoke-${agent}`, version: "0" }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SET_AGENT_COMM_DIR: ROOT, SET_AGENT_NAME: agent, SET_AGENT_ROOM: ROOM },
  }))
  return client
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  assert.ok(!r.isError, `${name} hibát adott: ${r.content?.[0]?.text}`)
  return JSON.parse(r.content[0].text)
}

console.log(`\nset-agent-comm füst-teszt — tár: ${ROOT}\n`)
const consumer-a = await connect("consumer-a")
const promo = await connect("set-promo")

try {
  const tools = (await consumer-a.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(tools, ["agents", "history", "inbox", "rooms", "send"])
  ok(`mindkét szerver felállt, 5 tool: ${tools.join(", ")}`)

  await call(consumer-a, "send", { type: "KÉRÉS", text: "Kellene pár ötlet a WPC ajánlathoz." })
  ok("consumer-a küldött egy KÉRÉS-t")

  const inb = await call(promo, "inbox")
  assert.equal(inb.unread, 1, "a set-promo nem kapta meg az üzenetet")
  assert.equal(inb.messages[0].from, "consumer-a")
  assert.match(inb.messages[0].text, /ötlet/)
  ok(`set-promo megkapta: "${inb.messages[0].text}"`)

  assert.equal((await call(promo, "inbox")).unread, 0)
  ok("másodszorra már nincs olvasatlan — a kurzor lépett")

  await call(promo, "send", { type: "VÁLASZ", text: "Három ötlet…", re: inb.messages[0].ts })
  const back = await call(consumer-a, "inbox")
  assert.equal(back.unread, 1)
  assert.equal(back.messages[0].from, "set-promo")
  assert.equal(back.messages[0].re, inb.messages[0].ts)
  ok("set-promo válaszolt, consumer-a megkapta — a `re:` hivatkozás megmaradt")

  assert.equal((await call(consumer-a, "inbox")).unread, 0)
  ok("a saját üzenetét EGYIK sem kapta vissza")

  const reg = await call(consumer-a, "agents")
  assert.deepEqual(reg.map(a => a.agent).sort(), ["set-promo", "consumer-a"])
  assert.ok(reg.every(a => typeof a.silentMinutes === "number"))
  ok(`a nyilvántartó mindkettőt látja: ${reg.map(a => `${a.agent}(${a.silentMinutes}p)`).join(", ")}`)

  const h = await call(consumer-a, "history")
  assert.equal(h.total, 2)
  assert.deepEqual(h.messages.map(m => m.from), ["consumer-a", "set-promo"])
  ok("a history mindkét oldalt idősorrendben adja vissza")

  console.log("\n✅ FÜST-TESZT ZÖLD — két agent beszélt egymással MCP-n keresztül.\n")
} finally {
  await consumer-a.close().catch(() => {})
  await promo.close().catch(() => {})
  rmSync(ROOT, { recursive: true, force: true })
}
