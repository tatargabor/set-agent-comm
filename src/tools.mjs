// Transport-independent MCP core — both the stdio and the HTTP entry point use THIS.
// (set-designer/mcp pattern: one `tools`, two thin transports. If the two sides kept
// separate tool lists, one renamed field would silently drift them apart.)

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import * as store from "./store.mjs"

const S = (props, required = []) =>
  ({ type: "object", properties: props, required, additionalProperties: false })

const ROOM = { type: "string", description: "Room name; the default is used when omitted" }

export const TOOL_DEFS = [
  {
    name: "agents",
    description:
      "Who is registered in the registry, and when they last gave a sign of life. " +
      "`silentMinutes: null` means WE DO NOT KNOW — not that they are dead.",
    inputSchema: S({}),
  },
  { name: "rooms", description: "The list of existing channels (rooms).", inputSchema: S({}) },
  {
    name: "send",
    description:
      "Append an entry to your own file in the room (append, not rewrite). " +
      "The sender and the timestamp are generated SERVER-SIDE — do not write a name or a date into the text yourself.",
    inputSchema: S({
      room: ROOM,
      type: { type: "string", enum: store.TYPES, description: "The type of the entry" },
      text: { type: "string", description: "The text of the entry (markdown)" },
      re: { type: "string", description: "Which entry this answers — its timestamp" },
    }, ["text"]),
  },
  {
    name: "inbox",
    description:
      "New entries FROM THE OTHERS that you have not read yet. Marks them read by default; " +
      "with `advance: false` you only take a look. It never returns your own messages.",
    inputSchema: S({
      room: ROOM,
      advance: { type: "boolean", description: "Should the read cursor move forward (default: true)" },
      limit: { type: "number", description: "At most this many entries (default: 20)" },
    }),
  },
  {
    name: "history",
    description: "Read back the room's history. Does NOT move the cursor.",
    inputSchema: S({
      room: ROOM,
      from: { type: "string", description: "Only from this agent" },
      limit: { type: "number", description: "At most this many entries (default: 20)" },
    }),
  },
]

/**
 * @param identify (request) => ({ agent, room }) — it is the transport's job to say WHO calls.
 *   stdio: from the cwd (unforgeable). http: session-id → `register` on the agent's word.
 */
export function createMcpServer(identify) {
  const server = new Server(
    { name: "set-agent-comm", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const a = req.params.arguments || {}
    try {
      const { agent, room: defaultRoom, rooms: configured } = identify(req)
      const room = a.room || defaultRoom
      const needRoom = () => {
        if (room) return room
        // Several rooms configured → no default, on purpose: see `parseRooms`. Name them, so
        // the caller does not have to guess which ones it may write to.
        if (configured?.length > 1)
          throw new Error(
            `You are in several rooms (${configured.join(", ")}), so \`room\` is required — ` +
            `pick the one this message belongs to.`)
        throw new Error(
          `No room given and no default. Existing rooms: ${store.rooms().join(", ") || "(none)"}`)
      }
      let out
      switch (req.params.name) {
        case "agents": out = store.agents(); break
        case "rooms": out = store.rooms(); break
        case "send":
          out = store.send({ room: needRoom(), from: agent, type: a.type, text: a.text, re: a.re }); break
        case "inbox":
          out = store.inbox({ room: needRoom(), agent, advance: a.advance !== false, limit: a.limit }); break
        case "history":
          out = store.history({ room: needRoom(), from: a.from, limit: a.limit }); break
        default: throw new Error(`unknown tool: ${req.params.name}`)
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] }
    } catch (e) {
      // Errors are LOUD. A silently swallowed error is indistinguishable from "there was no
      // message" — and "no new messages" is exactly the most dangerous false negative here.
      return { isError: true, content: [{ type: "text", text: `set-agent-comm error: ${e.message}` }] }
    }
  })

  return server
}
