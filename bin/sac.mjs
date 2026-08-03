#!/usr/bin/env node
// CLI a mag fölé — a hookok, a cron és az ember ezt hívja.
// Az MCP-vel azonos magot használja, tehát nem tud elcsúszni tőle.
//
//   sac agents                          ki létezik, ki él
//   sac rooms                           szobák
//   sac send <szoba> <típus> "szöveg"   bejegyzés (append)
//   sac inbox <szoba>                   új üzenetek másoktól
//   sac peek <szoba>                    ugyanaz, de a kurzort nem mozgatja
//   sac history <szoba> [n]             visszaolvasás
//   sac watch-paths <szoba>             a figyelendő fájlok (hooknak)
//   sac register <szoba>                bejelentkezés a nyilvántartóba

import { basename } from "node:path"
import * as store from "../src/store.mjs"

const ME = process.env.SET_AGENT_NAME || basename(process.cwd())
const [cmd, ...rest] = process.argv.slice(2)
const json = v => console.log(JSON.stringify(v, null, 2))

const fmt = m => `## ${m.ts} — ${m.type}${m.re ? ` (re: ${m.re})` : ""}  [${m.from}]\n${m.text}\n`

try {
  switch (cmd) {
    case "agents": {
      const list = store.agents()
      if (!list.length) { console.log("(a nyilvántartó üres)"); break }
      for (const a of list) {
        const s = a.silentMinutes == null ? "?" : `${a.silentMinutes}p`
        console.log(`${a.agent.padEnd(18)} ${String(s).padStart(5)} néma   ${a.project || "-"}`)
      }
      break
    }
    case "rooms": console.log(store.rooms().join("\n") || "(egy szoba sincs)"); break

    case "send": {
      const [room, type, ...text] = rest
      if (!room || !text.length) throw new Error('használat: sac send <szoba> <típus> "szöveg"')
      json(store.send({ room, from: ME, type, text: text.join(" ") }))
      break
    }
    case "inbox":
    case "peek": {
      const [room] = rest
      if (!room) throw new Error(`használat: sac ${cmd} <szoba>`)
      const r = store.inbox({ room, agent: ME, advance: cmd === "inbox" })
      if (!r.unread) { console.log("(nincs új üzenet)"); break }
      if (r.truncated) console.log(`… ${r.truncated} régebbi kihagyva\n`)
      for (const m of r.messages) console.log(fmt(m))
      break
    }
    case "unread": {
      const [room, n] = rest
      if (!room) throw new Error("használat: sac unread <szoba> [n]   — az utolsó n üzenet újra olvasatlan")
      json(store.unread({ room, agent: ME, count: Number(n) || 1 }))
      break
    }
    case "history": {
      const [room, n] = rest
      if (!room) throw new Error("használat: sac history <szoba> [n]")
      const r = store.history({ room, limit: Number(n) || 20 })
      console.log(`(összesen ${r.total} bejegyzés)\n`)
      for (const m of r.messages) console.log(fmt(m))
      break
    }
    case "watch-paths": {
      const [room] = rest
      if (!room) throw new Error("használat: sac watch-paths <szoba>")
      // Csak a MÁSOK fájljait — a sajátunk változására nem akarunk ébredni.
      console.log(store.busFiles(room).filter(p => basename(p) !== `${ME}.md`).join("\n"))
      break
    }
    case "register": {
      const [room] = rest
      json(store.register({ agent: ME, project: process.cwd(), room }))
      break
    }
    default:
      console.log(`set-agent-comm — agentek közti üzenetváltás egy gépen.
agent: ${ME}   ·   tár: ${store.ROOT}

  sac agents                          ki létezik, ki él
  sac rooms                           szobák
  sac send <szoba> <típus> "szöveg"   bejegyzés (${store.TYPES.join(" | ")})
  sac inbox <szoba>                   új üzenetek másoktól (olvasottnak jelöl)
  sac peek <szoba>                    ugyanaz, kurzor-mozgatás nélkül
  sac unread <szoba> [n]              az utolsó n üzenet újra olvasatlan
  sac history <szoba> [n]             visszaolvasás
  sac watch-paths <szoba>             a figyelendő fájlok (hooknak)
  sac register <szoba>                bejelentkezés a nyilvántartóba`)
      process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  console.error(`sac: ${e.message}`)
  process.exit(1)
}
