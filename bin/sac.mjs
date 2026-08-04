#!/usr/bin/env node
// A CLI on top of the core — hooks, cron and humans call this.
// It uses the same core as the MCP server, so the two cannot drift apart.
//
//   sac agents                          who exists, who is alive
//   sac rooms                           rooms
//   sac send <room> <type> "text"       entry (append)
//   sac inbox <room>                    new messages from others
//   sac peek <room>                     the same, but does not move the cursor
//   sac history <room> [n]              read back
//   sac watch-paths <room>              the files to watch (for the hook)
//   sac register <room>                 check in to the registry

import { basename } from "node:path"
import * as store from "../src/store.mjs"

const AGENT = process.env.SET_AGENT_NAME || basename(process.cwd())
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || null
const [cmd, ...rest] = process.argv.slice(2)

// The same seat the MCP server and the hook use: `CLAUDE_CODE_SESSION_ID` is inherited by
// everything Claude Code starts, so a `sac` call from a session writes into that session's
// file. From a bare terminal (no session id) there is no seat — that is the base name, as
// before, and `send` then warns about the shared file.
//
// A seat is CLAIMED only by a command that writes or that keeps a read cursor. Measured: with
// an unconditional claim `sac agents` — a pure listing — invented a third session in a project
// that had two.
const CLAIMS = new Set(["send", "inbox", "peek", "unread", "register"])
const seat = { agent: AGENT, session: SESSION }
const ME = CLAIMS.has(cmd) ? store.claimSeat(seat) : store.seatOf(seat)
const json = v => console.log(JSON.stringify(v, null, 2))

const fmt = m => `## ${m.ts} — ${m.type}${m.re ? ` (re: ${m.re})` : ""}  [${m.from}]\n${m.text}\n`

try {
  switch (cmd) {
    case "agents": {
      const list = store.agents()
      if (!list.length) { console.log("(the registry is empty)"); break }
      for (const a of list) {
        const s = a.silentMinutes == null ? "?" : `${a.silentMinutes}m`
        // The live seats are shown: this is what says the project has TWO sessions right now,
        // and it names the one you can address.
        const live = a.live?.length > 1 ? `   [${a.live.join(", ")}]` : ""
        console.log(`${a.agent.padEnd(18)} ${String(s).padStart(5)} silent   ${a.project || "-"}${live}`)
      }
      break
    }
    case "rooms": console.log(store.rooms().join("\n") || "(no rooms yet)"); break

    case "send": {
      const [room, type, ...text] = rest
      if (!room || !text.length) throw new Error('usage: sac send <room> <type> "text"')
      json(store.send({ room, from: ME, type, text: text.join(" ") }))
      break
    }
    case "inbox":
    case "peek": {
      const [room] = rest
      if (!room) throw new Error(`usage: sac ${cmd} <room>`)
      const r = store.inbox({ room, agent: ME, advance: cmd === "inbox" })
      if (!r.unread) { console.log("(no new messages)"); break }
      if (r.truncated) console.log(`… ${r.truncated} older skipped\n`)
      for (const m of r.messages) console.log(fmt(m))
      break
    }
    case "unread": {
      const [room, n] = rest
      if (!room) throw new Error("usage: sac unread <room> [n]   — makes the last n messages unread again")
      json(store.unread({ room, agent: ME, count: Number(n) || 1 }))
      break
    }
    case "history": {
      const [room, n] = rest
      if (!room) throw new Error("usage: sac history <room> [n]")
      const r = store.history({ room, limit: Number(n) || 20 })
      console.log(`(${r.total} entries in total)\n`)
      for (const m of r.messages) console.log(fmt(m))
      break
    }
    case "watch-paths": {
      const [room] = rest
      if (!room) throw new Error("usage: sac watch-paths <room>")
      // Only the OTHERS' files — we do not want to wake up on our own file changing.
      console.log(store.busFiles(room).filter(p => basename(p) !== `${ME}.md`).join("\n"))
      break
    }
    case "register": {
      const [room] = rest
      json(store.register({ agent: AGENT, project: process.cwd(), room, writer: ME, session: SESSION }))
      break
    }
    default:
      console.log(`set-agent-comm — messaging between agents on one machine.
agent: ${AGENT}${ME !== AGENT ? `   ·   writer: ${ME} (this project's ${ME.split("#")[1]}. session)` : ""}   ·   store: ${store.ROOT}

  sac agents                          who exists, who is alive
  sac rooms                           rooms
  sac send <room> <type> "text"       entry (${store.TYPES.join(" | ")})
  sac inbox <room>                    new messages from others (marks them read)
  sac peek <room>                     the same, without moving the cursor
  sac unread <room> [n]               make the last n messages unread again
  sac history <room> [n]              read back
  sac watch-paths <room>              the files to watch (for the hook)
  sac register <room>                 check in to the registry`)
      process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  console.error(`sac: ${e.message}`)
  process.exit(1)
}
