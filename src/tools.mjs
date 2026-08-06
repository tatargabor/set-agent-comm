// Transport-independent MCP core — both the stdio and the HTTP entry point use THIS.
// (set-designer/mcp pattern: one `tools`, two thin transports. If the two sides kept
// separate tool lists, one renamed field would silently drift them apart.)

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import * as store from "./store.mjs"
import { seatBase } from "./store.mjs"

const S = (props, required = []) =>
  ({ type: "object", properties: props, required, additionalProperties: false })

const ROOM = { type: "string", description: "Room name; the default is used when omitted" }

export const TOOL_DEFS = [
  {
    name: "agents",
    description:
      "Who is registered in the registry, when they last gave a sign of life, AND WHAT EACH IS " +
      "WORKING ON (`focus`). Read this before asking the room who is doing what — that is a " +
      "lookup, not a conversation. " +
      "`silentMinutes: null` means WE DO NOT KNOW — not that they are dead. " +
      "`seats` lists the project's sessions with their full session id, `live` the ones open " +
      "right now, and `lastWrote` when each last APPENDED anything — `lastSeen` is only a check-in, " +
      "so do not read it as 'went quiet'. More than one live name (`web-app#3f9c1a20`, `web-app#7b02e5d1`) means " +
      "several sessions are open in that project — address the one you mean.",
    inputSchema: S({}),
  },
  {
    name: "focus",
    description:
      "Declare in one sentence what you are working on, and which paths you are in. Two jobs: " +
      "the others read it with `agents` instead of asking you, and the watcher that decides " +
      "whether an incoming message should interrupt you measures it against this. " +
      "Set it when you start a piece of work and when you switch; call it with no arguments to " +
      "read back what you last declared. An empty `text` clears it.",
    inputSchema: S({
      text: { type: "string", description: "One sentence: what you are doing now" },
      files: {
        type: "array", items: { type: "string" },
        description: "The paths you are working in — this is what tells a sibling session to stay out",
      },
    }),
  },
  {
    name: "rooms",
    description:
      "Which rooms exist and how far each one reaches: `local` is on this machine only, " +
      "`relay` also reaches other machines (with the name you write under there). A room you " +
      "were invited to appears here even before its first message.",
    inputSchema: S({}),
  },
  {
    name: "send",
    description:
      "Append an entry to your own file in the room (append, not rewrite). " +
      "The sender and the timestamp are generated SERVER-SIDE — do not write a name or a date into the text yourself. " +
      "WHO IS INTERRUPTED FOLLOWS FROM WHAT YOU SEND: `to` claims that agent's attention; without " +
      "`to`, a QUESTION or REQUEST interrupts the whole room and a FACT or ANSWER interrupts " +
      "nobody — it is delivered and read when they next look. So address it when you need an " +
      "answer, and broadcast a FACT freely: it costs the others nothing. " +
      "BEFORE YOU SEND, ASK: does anyone have to DO something because of this? If not, broadcast a " +
      "FACT. If yes and you know who, make it a REQUEST or QUESTION addressed to that one seat. A " +
      "FACT with an errand hidden inside it wakes NOBODY and waits until someone happens to look — " +
      "measured: a six-session run in which all five entries were broadcast FACTs, two of them " +
      "carrying work for other projects. " +
      "Do not send acknowledgements ('received', 'agreed', 'closing this off') — silence after a " +
      "FACT is the correct response, and an ack is a message the others must still read. " +
      "THE RESULT TELLS YOU WHAT THE ENTRY DID: `wakes` lists the seats it will interrupt, and " +
      "`notice` appears when that list is empty or the text is long. If it woke nobody and " +
      "somebody did have to act, send it again addressed — do not wait for an answer.",
    inputSchema: S({
      room: ROOM,
      type: { type: "string", enum: store.TYPES, description: "The type of the entry" },
      text: {
        type: "string",
        description:
          "The text of the entry (markdown). A SHORT PARAGRAPH: the decision and what it changes " +
          "for someone else. Measured average on the live bus: 2168 characters, every one of them " +
          "read by every seat in the room. The reasoning and the code belong in the files — name " +
          "the file and the symbol instead of quoting them.",
      },
      re: { type: "string", description: "Which entry this answers — its timestamp" },
      to: {
        type: "array", items: { type: "string" },
        description:
          "Who it is addressed to: a SEAT (`consumer-a-atlas#3f9c1a20`) or a project name " +
          "(`consumer-a-atlas` — every session of it, on every machine). " +
          "PREFER THE SEAT: a project with four open sessions wakes all four, and three of them " +
          "will spend a turn working out it was not them. When you reply, the seat you want is " +
          "the `from` of the entry you are answering. " +
          "ONE NAME, NOT A LIST: naming one seat is never second-guessed, naming several is judged " +
          "as the broadcast it is. Two seats owing you two different things is TWO sends. " +
          "Everyone else still receives the entry, marked `forMe: false` — addressing restricts " +
          "who is interrupted, never who may read. " +
          "A name that is in no room is an ERROR, never a silent non-delivery — `agents` lists who is there.",
      },
    }, ["text"]),
  },
  {
    name: "inbox",
    description:
      "New entries FROM THE OTHERS that you have not read yet. Marks them read by default; " +
      "with `advance: false` you only take a look. It never returns your own messages. " +
      "An entry marked `sibling: true` comes from ANOTHER SESSION OF THIS SAME PROJECT — " +
      "it works in the same working directory as you do. " +
      "`forMe: false` means it was addressed to someone else — you are reading along, you were " +
      "not asked. `wakes: true` marks the ones that are a claim on your attention and are owed " +
      "an answer (`unreadWaking` counts them); everything else is yours to read and act on or " +
      "not, and needs no reply. " +
      "A long entry that does NOT wake you arrives as its opening, with `clipped: <full length>` " +
      "— use `history` if you need the whole thing. An entry that wakes you is never clipped.",
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
 *   `agent` here is a SEAT: the project directory plus the session id (`web-app#3f9c1a20`).
 *   stdio: cwd + `CLAUDE_CODE_SESSION_ID`, both unforgeable.
 *   http: session-id → `register` on the agent's word.
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
      // ⚠ THE REMOTE LEG BELONGS HERE TOO. Measured 2026-08-05 on a Mac mini: the relay push
      // lived only in the CLI, so an agent — which always works through MCP, never the CLI —
      // wrote locally, saw a successful `send`, and nothing ever left the machine. Its eight
      // messages were invisible to the other side. Loaded lazily so the local path stays
      // dependency-free and pays nothing when no relay is configured.
      const bridge = async () => await import("./bridge.mjs")
      let out
      switch (req.params.name) {
        case "agents": out = store.agents(); break
        case "focus":
          // No `text` at all is a QUERY, not a clear — clearing is `text: ""`. An agent calling
          // `focus` to see what it declared may not thereby erase it.
          out = a.text === undefined
            ? (store.getFocus(agent) || { agent, focus: null })
            : store.setFocus({ agent, text: a.text, files: a.files })
          break
        case "rooms": {
          // Local AND invited: a room you hold a token for must be listed before its first
          // message too, or an agent cannot tell that it may speak there at all.
          const cfg = (await bridge()).readConfig()
          const remote = cfg.rooms || {}
          out = [...new Set([...store.rooms(), ...Object.keys(remote)])].sort().map(room =>
            remote[room]
              ? { room, reach: "relay", writingAs: `${seatBase(agent).split("@")[0]}@${remote[room].namespace}`, relay: remote[room].url }
              : { room, reach: "local" })
          break
        }
        case "send": {
          const r = needRoom()
          out = store.send({ room: r, from: agent, type: a.type, text: a.text, re: a.re, to: a.to })
          out = { ...out, ...(await (await bridge()).pushReport(r)) }
          break
        }
        case "inbox": {
          const r = needRoom()
          // Fetch first, then read: otherwise "no new messages" would be answered while the
          // message waits one HTTP call away.
          const fetched = await (await bridge()).pullReport(r)
          out = { ...store.inbox({ room: r, agent, advance: a.advance !== false, limit: a.limit }), ...fetched }
          break
        }
        case "history": {
          const r = needRoom()
          const fetched = await (await bridge()).pullReport(r)
          out = { ...store.history({ room: r, from: a.from, limit: a.limit }), ...fetched }
          break
        }
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
