// Transzport-független MCP-mag — a stdio és a HTTP belépő is EZT használja.
// (set-designer/mcp minta: egy `tools`, két vékony transzport. Ha a két oldal külön
// tool-listát vezetne, egy mezőnév-változás némán elcsúsztatná őket egymástól.)

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import * as store from "./store.mjs"

const S = (props, required = []) =>
  ({ type: "object", properties: props, required, additionalProperties: false })

const ROOM = { type: "string", description: "Szoba neve; elhagyva az alapértelmezett" }

export const TOOL_DEFS = [
  {
    name: "agents",
    description:
      "Ki van regisztrálva a nyilvántartóban, és mikor adott utoljára életjelet. " +
      "A `silentMinutes: null` azt jelenti, hogy NEM TUDJUK — nem azt, hogy halott.",
    inputSchema: S({}),
  },
  { name: "rooms", description: "A létező csatornák (szobák) listája.", inputSchema: S({}) },
  {
    name: "send",
    description:
      "Bejegyzés hozzáfűzése a saját fájlodhoz a szobában (append, nem újraírás). " +
      "A feladó és az időbélyeg SZERVEROLDALON generálódik — ne írj magadnak nevet vagy dátumot a szövegbe.",
    inputSchema: S({
      room: ROOM,
      type: { type: "string", enum: store.TYPES, description: "A bejegyzés típusa" },
      text: { type: "string", description: "A bejegyzés szövege (markdown)" },
      re: { type: "string", description: "Melyik bejegyzésre válasz — annak időbélyege" },
    }, ["text"]),
  },
  {
    name: "inbox",
    description:
      "Új bejegyzések a TÖBBIEKTŐL, amiket még nem olvastál. Alapból elolvasottnak jelöli " +
      "őket; `advance: false`-szal csak belenézel. A saját üzeneteidet nem adja vissza.",
    inputSchema: S({
      room: ROOM,
      advance: { type: "boolean", description: "Lépjen-e előre az olvasottsági kurzor (alap: true)" },
      limit: { type: "number", description: "Legfeljebb ennyi bejegyzés (alap: 20)" },
    }),
  },
  {
    name: "history",
    description: "Visszaolvasás a szoba előzményeiből. A kurzort NEM mozgatja.",
    inputSchema: S({
      room: ROOM,
      from: { type: "string", description: "Csak ettől az agenttől" },
      limit: { type: "number", description: "Legfeljebb ennyi bejegyzés (alap: 20)" },
    }),
  },
]

/**
 * @param identify (request) => ({ agent, room }) — a transzport dolga megmondani, KI hív.
 *   stdio: a cwd-ből (hamisíthatatlan). http: session-id → `register` bemondás.
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
      const { agent, room: defaultRoom } = identify(req)
      const room = a.room || defaultRoom
      const needRoom = () => {
        if (room) return room
        throw new Error(
          `Nincs megadva szoba, és nincs alapértelmezett. Létező szobák: ${store.rooms().join(", ") || "(egy sincs)"}`)
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
        default: throw new Error(`ismeretlen tool: ${req.params.name}`)
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] }
    } catch (e) {
      // A hiba HANGOS. A némán elnyelt hiba megkülönböztethetetlen attól, hogy nem volt üzenet —
      // és pont a „nincs új üzenet" a legveszélyesebb hamis negatív ebben a rendszerben.
      return { isError: true, content: [{ type: "text", text: `set-agent-comm hiba: ${e.message}` }] }
    }
  })

  return server
}
