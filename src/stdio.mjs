#!/usr/bin/env node
/**
 * stdio entry point — THIS IS THE DEFAULT MODE.
 *
 * Register it per project (`-s user` is deliberately NOT right here — see below):
 *   claude mcp add agent-comm -e SET_AGENT_ROOM=team -- node /path/to/set-agent-comm/src/stdio.mjs
 *
 * WHY stdio is the default while set-designer uses HTTP: there is ONE global state there,
 * while here we have to know WHO writes. The client starts the stdio process with its own
 * cwd, so identity comes from the project directory — the agent cannot mistype it and cannot
 * write in someone else's name. Over HTTP every client arrives at the same URL, where
 * identity would be self-declared.
 */
import { basename } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer } from "./tools.mjs"

const agent = process.env.SET_AGENT_NAME || basename(process.cwd())
const room = process.env.SET_AGENT_ROOM || null

const server = createMcpServer(() => ({ agent, room }))
await server.connect(new StdioServerTransport())
