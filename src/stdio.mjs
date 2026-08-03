#!/usr/bin/env node
/**
 * stdio belépő — EZ AZ ALAPÉRTELMEZETT MÓD.
 *
 * Regisztráció projektenként (a `-s user` itt szándékosan NEM jó — lásd lent):
 *   claude mcp add agent-comm -e SET_AGENT_ROOM=consumer-a-set -- node ~/code2/set-agent-comm/src/stdio.mjs
 *
 * MIÉRT stdio az alap, amikor a set-designer HTTP-t használ: ott EGY globális állapot van,
 * itt viszont tudni kell, KI ír. A stdio-processzt a kliens a saját cwd-jével indítja, tehát
 * az identitás a projekt-könyvtárból jön — az agent nem tudja elírni és nem tud más nevében
 * írni. HTTP-n minden kliens ugyanarra az URL-re jön, ott az identitás bemondásos lenne.
 */
import { basename } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer } from "./tools.mjs"

const agent = process.env.SET_AGENT_NAME || basename(process.cwd())
const room = process.env.SET_AGENT_ROOM || null

const server = createMcpServer(() => ({ agent, room }))
await server.connect(new StdioServerTransport())
