#!/usr/bin/env node
/**
 * stdio entry point — THIS IS THE DEFAULT MODE.
 *
 * Register it per project (`-s user` is deliberately NOT right here — see below):
 *   claude mcp add agent-comm -e SET_AGENT_ROOM=team -- node /path/to/set-agent-comm/src/stdio.mjs
 *
 * `SET_AGENT_ROOM` accepts several rooms, comma-separated. In that case there is no default
 * room: every call has to name one, otherwise it fails loudly.
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
import { parseRooms, claimSeat, register } from "./store.mjs"

const agent = process.env.SET_AGENT_NAME || basename(process.cwd())
const rooms = parseRooms(process.env.SET_AGENT_ROOM)
const room = rooms.length === 1 ? rooms[0] : null

/**
 * WHICH SESSION are we? Measured 2026-08-04: `CLAUDE_CODE_SESSION_ID` is present in this
 * process's environment (Claude Code starts the MCP server with it), and the SessionStart
 * hook and every `sac` call inherit the SAME value — so all three land on the same seat
 * without any configuration. Two sessions in one project therefore write into two files and
 * can hear each other; without the variable everything works exactly as before, on one seat.
 */
const session = process.env.CLAUDE_CODE_SESSION_ID || null
const writer = claimSeat({ agent, session })

// Check in AT STARTUP, not at the first tool call: the seat is held by a live pid, and this
// process lives as long as the session does. That is what stops a newcomer from taking the
// seat of a session that is merely quiet.
if (rooms.length) for (const r of rooms) register({ agent, project: process.cwd(), session, room: r, writer })
else register({ agent, project: process.cwd(), session, writer })

const server = createMcpServer(() => ({ agent: writer, room, rooms }))
await server.connect(new StdioServerTransport())
