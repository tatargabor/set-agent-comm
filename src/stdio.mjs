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
import { parseRooms, claimSeat, register, wakingRooms } from "./store.mjs"

const agent = process.env.SET_AGENT_NAME || basename(process.cwd())
const rooms = parseRooms(process.env.SET_AGENT_ROOM)
const room = rooms.length === 1 ? rooms[0] : null

/**
 * WHICH SESSION are we? `CLAUDE_CODE_SESSION_ID` is in this process's environment (Claude Code
 * starts the MCP server with it), and it is what NAMES a seat.
 *
 * ⚠ IT IS NOT WHAT IDENTIFIES THE WINDOW, and believing it was cost a live session on
 * 2026-08-06. Measured in `consumer-a`: this process was started by its window's own `claude` at
 * 10:46:15 and handed `CLAUDE_CODE_SESSION_ID=fef3e62f…`, an id with no transcript on disk,
 * while that same window was writing `8a31f74c….jsonl`. The SessionStart hook got the real id.
 * Two seats, two files, two cursors, one window — the hook announced "1 unread" and this server
 * answered "0", and the agent went round it with the CLI.
 *
 * So the window is identified by the `claude` process that owns us — our own parent (see
 * `ownerPid`) — and the session id only gets to name a seat nobody has claimed for it yet.
 */
const session = process.env.CLAUDE_CODE_SESSION_ID || null
const writer = claimSeat({ agent, session })

// Check in AT STARTUP, not at the first tool call: the seat is held by a live pid, and this
// process lives as long as the session does. That is what stops a newcomer from taking the
// seat of a session that is merely quiet.
if (rooms.length) for (const r of rooms) register({ agent, project: process.cwd(), session, room: r, writer })
else register({ agent, project: process.cwd(), session, writer })

// ⚠ RESOLVED PER CALL, not once at startup — and from the SEAT's book, not the environment.
// `SET_AGENT_ROOM` is what this project was installed with; a room this session joined afterwards
// (`sac join`, `sac dm`) exists only in `members.json`, and a server that read the environment
// once would go on believing the session is somewhere it no longer is — including keeping a
// DEFAULT room after the seat has two, which is how an entry meant for a room of two would land
// in front of everybody. See `store.wakingRooms`.
const server = createMcpServer(() => {
  const mine = wakingRooms(writer, rooms)
  return { agent: writer, room: mine.length === 1 ? mine[0] : null, rooms: mine }
})
await server.connect(new StdioServerTransport())
