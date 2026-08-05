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

import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { watch, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import * as store from "../src/store.mjs"

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks")

/**
 * Upload, and never let a relay problem look like a send problem: the entry is already on disk
 * by the time this runs. The result is REPORTED (`relay: "queued (…)"`), not swallowed — a
 * silent upload failure is indistinguishable from a delivered message, which is the one thing
 * this project refuses to do.
 */
const relayPush = async room => {
  const { push, roomConfig } = await import("../src/bridge.mjs")
  if (!roomConfig(room)) return {}
  try { const r = await push({ room }); return { relay: `pushed ${r.pushed ?? 0}` } }
  catch (e) { return { relay: `queued (relay unreachable: ${e.message})` } }
}

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
        console.log(`${a.agent.padEnd(18)} ${String(s).padStart(5)} silent   ${a.project || "-"}`)
        // The live seats under the project: this is what says which sessions are open right
        // now and what to address them by. The suffix of the name is the session id, so it can
        // be matched against the session a Claude Code window reports for itself.
        const live = (a.seats || []).filter(x => x.live !== false)
        // `wrote` is shown next to the seat, because "checked in" and "wrote" are different
        // facts and reading one as the other is how a live session gets called silent.
        live.forEach((x, i) => console.log(
          `  ${i === live.length - 1 ? "└" : "├"} ${x.writer.padEnd(26)}${x.live === null ? "(?) " : "    "}` +
          (x.lastWrote ? `wrote ${x.lastWrote.slice(11, 16)}` : "never wrote")))
      }
      break
    }
    case "rooms": console.log(store.rooms().join("\n") || "(no rooms yet)"); break

    case "send": {
      const [room, type, ...text] = rest
      if (!room || !text.length) throw new Error('usage: sac send <room> <type> "text"')
      const out = store.send({ room, from: ME, type, text: text.join(" ") })
      // LOCAL FIRST, then the wire. If the relay is down the entry is already safe on disk and
      // the outbox cursor will carry it next time — a dead relay is a delay, not a lost message.
      json({ ...out, ...(await relayPush(room)) })
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
    // ── the remote leg: handshake ─────────────────────────────────────────────
    case "relay": {
      // `sac relay use <url> --secret <s>` — the operator's machine remembers the relay.
      // `sac relay status`                 — what is configured, and is it reachable.
      const [sub, url] = rest
      const bridge = await import("../src/bridge.mjs")
      const cfg = bridge.readConfig()
      if (sub === "use") {
        const secret = rest[rest.indexOf("--secret") + 1]
        if (!url || !rest.includes("--secret") || !secret) {
          throw new Error("usage: sac relay use <url> --secret <RELAY_SECRET>")
        }
        // The secret is what mints invites, so it lives only on the machine that hands them
        // out. Devices that merely join never see it — they get a token instead.
        cfg.relay = { url: url.replace(/\/$/, ""), secret }
        cfg.rooms ||= {}
        bridge.writeConfig(cfg)
        console.log(`relay: ${cfg.relay.url}\nstored in ${store.ROOT}/relays.json (mode 600)`)
        break
      }
      if (sub === "status" || !sub) {
        console.log(`relay:  ${cfg.relay?.url || "(none configured)"}`)
        console.log(`device: ${bridge.deviceName()}`)
        for (const [room, r] of Object.entries(cfg.rooms || {}))
          console.log(`  ${room.padEnd(16)} ns=${r.namespace}  cursor=${r.cursor || 0}  ${r.url}`)
        if (cfg.relay?.url) {
          const res = await fetch(`${cfg.relay.url}/health`).then(r => r.json()).catch(e => ({ error: e.message }))
          console.log(res.error ? `\n⚠ unreachable: ${res.error}` : `\nreachable · epoch ${res.epoch}`)
        }
        break
      }
      throw new Error("usage: sac relay use <url> --secret <s>   |   sac relay status")
    }

    case "invite": {
      // Mints an invite LOCALLY with the relay secret, and puts the room key inside it. The
      // key therefore never reaches the relay: it forwards ciphertext it cannot read. That is
      // why the code must travel out of band — Signal, a phone call — and not through the relay
      // or a shared channel.
      const [room] = rest.filter(a => !a.startsWith("--"))
      const device = rest[rest.indexOf("--for") + 1]
      if (!room || !rest.includes("--for") || !device) {
        throw new Error('usage: sac invite <room> --for "<device-name>"')
      }
      const bridge = await import("../src/bridge.mjs")
      const { issue, newRoomKey } = await import("../src/crypto.mjs")
      const cfg = bridge.readConfig()
      if (!cfg.relay?.secret) throw new Error("no relay configured — run `sac relay use <url> --secret <s>` first")

      // One key per room, created on first use and kept: rotating it would make every entry
      // already on the relay undecryptable for whoever joins next.
      cfg.rooms ||= {}
      const key = cfg.rooms[room]?.roomKey || newRoomKey()
      if (!cfg.rooms[room]) {
        // The operator's own machine needs a device token too — it is a participant, not an
        // authority. Same token type, same rules, so there is only one code path to trust.
        cfg.rooms[room] = {
          url: cfg.relay.url, roomKey: key, namespace: bridge.deviceName(),
          token: issue(cfg.relay.secret, { kind: "device", room, ns: bridge.deviceName() }, 365 * 86400),
          cursor: 0, outbox: {},
        }
        bridge.writeConfig(cfg)
      }
      const code = issue(cfg.relay.secret, {
        kind: "invite", room, device, jti: randomUUID(),
      }, Number(rest[rest.indexOf("--ttl") + 1]) || 900)
      const payload = Buffer.from(JSON.stringify({ u: cfg.relay.url, r: room, c: code, k: key })).toString("base64url")
      console.log(`sac-join:${payload}\n`)
      console.log(`Valid for 15 minutes, for "${device}". On the other machine:\n` +
        `  sac join sac-join:…\n\n` +
        `⚠ Hand it over OUT OF BAND (Signal, a call). It carries the room key, which is what\n` +
        `  keeps the relay unable to read the room — send it through the relay and that is gone.`)
      break
    }

    case "join": {
      const [code] = rest.filter(a => !a.startsWith("--"))
      const asName = rest.includes("--as") ? rest[rest.indexOf("--as") + 1] : null
      if (!code?.startsWith("sac-join:")) throw new Error("usage: sac join sac-join:<code> [--as <device>]")
      const bridge = await import("../src/bridge.mjs")
      const { u, r, c, k } = JSON.parse(Buffer.from(code.slice("sac-join:".length), "base64url"))
      const device = asName || bridge.deviceName()
      const res = await fetch(`${u}/join`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: c, device }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`join refused: ${body.error || res.status}`)

      const cfg = bridge.readConfig()
      cfg.rooms ||= {}
      cfg.rooms[r] = { url: u, token: body.token, roomKey: k, namespace: body.namespace,
                       epoch: body.epoch, cursor: 0, outbox: {} }
      bridge.writeConfig(cfg)
      console.log(`joined "${r}" on ${u}\n` +
        `your name on the bus: <project>@${body.namespace}#<session>\n\n` +
        `Next:  sac install ${r}      (hooks + skill, so messages get noticed)`)
      break
    }

    case "install": {
      // Wires both hooks into THIS project's .claude/settings.json. It exists because the
      // alternative is hand-editing a settings file that already holds a dozen other hooks —
      // measured on the live `consumer-a` project, where the Stop hook was simply forgotten, and
      // from the outside a forgotten hook looks exactly like a quiet room.
      const dry = rest.includes("--dry-run")
      const asked = rest.filter(a => !a.startsWith("--")).flatMap(store.parseRooms)
      const rooms = asked.length ? asked : store.parseRooms(process.env.SET_AGENT_ROOM)
      if (!rooms.length) throw new Error("usage: sac install <room>[,<room>…] [--dry-run]")

      const file = join(process.cwd(), ".claude", "settings.json")
      let settings = {}
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf8")
        // A parse error is LOUD and stops here: this file is the project's, full of other
        // people's hooks. Half-understanding it is not a licence to rewrite it.
        try { settings = JSON.parse(raw) } catch (e) {
          throw new Error(`${file} is not valid JSON (${e.message}) — not touching it`)
        }
      }

      const env = `SET_AGENT_NAME=${AGENT} SET_AGENT_ROOM=${rooms.join(",")}`
      const scripts = { SessionStart: "session-start.mjs", Stop: "stop.mjs" }
      const wanted = Object.fromEntries(Object.entries(scripts)
        .map(([event, script]) => [event, `${env} node ${join(HOOKS, script)}`]))
      const changes = []
      settings.hooks ||= {}
      for (const [event, command] of Object.entries(wanted)) {
        const groups = (settings.hooks[event] ||= [])
        // Recognised by the SCRIPT NAME, not the full path — measured on the live `consumer-a`
        // project, where the hook was already wired in as `$HOME/code2/…`, and matching on the
        // absolute path did not see it. A re-run would then have added a second copy next to it.
        const ours = h => (h.command || "").includes("set-agent-comm") &&
          (h.command || "").includes(scripts[event])
        const mine = groups.flatMap(g => g.hooks || []).find(ours)
        if (!mine) { groups.push({ hooks: [{ type: "command", command }] }); changes.push(`${event}: added`) }
        else if (mine.command !== command) { mine.command = command; changes.push(`${event}: updated`) }
        else changes.push(`${event}: already wired`)
      }

      // The SKILL is the third piece, next to the two hooks: the hooks make sure a message is
      // NOTICED, the skill says what to do with it. The tools (`send`, `inbox`) are a capability
      // and need no skill; the protocol around them — answer even when it is not for you, agree
      // before touching shared files, arm the monitor — does not fit into a hook's one-liner.
      const sac = join(HOOKS, "..", "bin", "sac.mjs")
      const skillFrom = join(HOOKS, "..", "skills", "agent-comm", "SKILL.md")
      const skillTo = join(process.cwd(), ".claude", "skills", "agent-comm", "SKILL.md")
      // The commands are baked in at install time: the skill is a static file, and an agent
      // guessing at a path is an agent that silently does not watch.
      const skill = readFileSync(skillFrom, "utf8")
        .replaceAll("{{ROOMS}}", rooms.join(", "))
        .replaceAll("{{SAC}}", `node ${sac}`)
        .replaceAll("{{WAIT_COMMAND}}", `SET_AGENT_NAME=${AGENT} node ${sac} wait ${rooms.join(",")}`)
      const skillState = !existsSync(skillTo) ? "installed"
        : readFileSync(skillTo, "utf8") === skill ? "already current" : "updated"
      changes.push(`skill: ${skillState}`)

      console.log(`${dry ? "[dry run] " : ""}${file}`)
      for (const c of changes) console.log(`  ${c}`)
      for (const [e, c] of Object.entries(wanted)) console.log(`  ${e} → ${c}`)
      console.log(`  skill  → ${skillTo}`)
      if (dry) break
      if (changes.every(c => c.endsWith("already wired") || c.endsWith("already current"))) break

      mkdirSync(dirname(file), { recursive: true })
      // A backup before every write. This file is not ours, and it is not reconstructible.
      if (existsSync(file)) {
        const bak = `${file}.bak.${store.now().replace(/[:.]/g, "-")}`
        copyFileSync(file, bak)
        console.log(`  backup: ${bak}`)
      }
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")

      if (skillState !== "already current") {
        mkdirSync(dirname(skillTo), { recursive: true })
        // The skill file is ours end to end, so it is overwritten — but a hand-edited copy is
        // still someone's work, so it is backed up first.
        if (skillState === "updated") copyFileSync(skillTo, `${skillTo}.bak.${store.now().replace(/[:.]/g, "-")}`)
        writeFileSync(skillTo, skill)
      }

      console.log(`\nRestart (or resume) the session for it to take effect.\n` +
        `The MCP server, separately:  claude mcp add agent-comm -e SET_AGENT_ROOM=${rooms.join(",")} -- ` +
        `node ${join(HOOKS, "..", "src", "stdio.mjs")}`)
      break
    }
    case "sync": {
      // ONE round of push + pull, then exit. Two callers need exactly this and not a long poll:
      // the SessionStart hook (catch up on whatever arrived while no session was watching), and
      // anything scripted. `wait` is for staying, `sync` is for catching up.
      const bridge = await import("../src/bridge.mjs")
      const asked = rest.filter(a => !a.startsWith("--")).flatMap(store.parseRooms)
      const list = asked.length ? asked : bridge.remoteRooms()
      if (!list.length) { console.log("(no room has a relay configured)"); break }
      for (const room of list) {
        if (!bridge.roomConfig(room)) { console.log(`${room}: no relay configured`); continue }
        try {
          const up = await bridge.push({ room })
          const down = await bridge.pull({ room, wait: 0 })
          console.log(`${room}: pushed ${up.pushed ?? 0}, received ${down.received ?? 0}` +
            (down.reset ? " (relay restarted — resynced)" : ""))
        } catch (e) {
          // Reported, never swallowed: "could not reach the relay" and "nothing new" must not
          // look the same from the outside.
          console.log(`${room}: ⚠ relay unreachable (${e.message}) — local messages unaffected`)
        }
      }
      break
    }
    case "wait": {
      // LONG POLL — this is what a Claude Code `Monitor` runs, and it is the only thing that
      // starts a new turn in an IDLE session. Measured 2026-08-04: `watchPaths` + `FileChanged`
      // do fire while the session is idle, but they cannot wake it — they only leave context
      // for the next turn. So a message could sit in the room, correctly delivered and unread,
      // with nobody to read it. That is exactly what happened between two consumer-a sessions.
      //
      //   Monitor({ command: "sac wait", description: "agent-comm", persistent: true })
      //
      // Each line printed here becomes one notification, so the lines are few and specific.
      // It NEVER advances the cursor: a notification is not a delivery, the agent still has to
      // call `inbox`. Otherwise a monitor firing while the agent is busy would swallow the
      // message — the exact failure mode `sac unread` had to be invented for.
      const once = rest.includes("--once")
      const names = rest.filter(a => a !== "--once")
      const watched = (names.length ? names : [process.env.SET_AGENT_ROOM || ""])
        .flatMap(store.parseRooms)
      if (!watched.length) throw new Error("usage: sac wait [--once] <room> […]   (or set SET_AGENT_ROOM)")

      const reported = {}
      const check = () => {
        for (const room of watched) {
          const r = store.inbox({ room, agent: ME, advance: false })
          const last = r.messages.at(-1)
          if (!last) continue
          if (reported[room] && Date.parse(reported[room]) >= Date.parse(last.ts)) continue
          reported[room] = last.ts
          const who = [...new Set(r.messages.map(m => m.from))].join(", ")
          console.log(`[set-agent-comm] ${r.unread} unread in "${room}" from ${who} — ` +
            `call the \`inbox\` tool (room: ${room}) and answer.`)
          if (once) process.exit(0)
        }
      }

      check()                                    // what is ALREADY waiting counts as an event
      for (const room of watched) {
        const dir = store.channelDir(room)
        mkdirSync(dir, { recursive: true })
        // A new participant's file appearing is an event too, so we watch the DIRECTORY.
        try { watch(dir, () => setTimeout(check, 50)) } catch { /* the poll below covers it */ }
      }
      // The safety net. `fs.watch` misses events on some file systems, and a watcher that
      // silently stops looks exactly like a quiet room — the most dangerous false negative here.
      setInterval(check, 5000)

      // THE REMOTE LEG rides on this same watcher: for rooms that have a relay we long-poll it
      // in parallel, and what arrives is written into the local room — where the loop above
      // finds it and reports it like any other message. No second daemon, and nothing
      // downstream had to learn that a message can come from another machine.
      const bridge = await import("../src/bridge.mjs")
      for (const room of watched.filter(r => bridge.roomConfig(r))) {
        void (async () => {
          let backoff = 1000
          for (;;) {
            try {
              await bridge.push({ room })                        // whatever the outbox still owes
              await bridge.pull({ room, wait: 25, log: m => console.log(`[set-agent-comm] ${m}`) })
              check()
              backoff = 1000
            } catch (e) {
              // A relay outage may not kill the watch: local messages must keep flowing, and
              // the remote ones catch up when it returns. Backing off keeps a dead relay from
              // turning into a hot loop; the ceiling keeps recovery within a minute.
              console.log(`[set-agent-comm] relay "${room}" unreachable (${e.message}) — retrying`)
              await new Promise(r => setTimeout(r, backoff))
              backoff = Math.min(backoff * 2, 60_000)
            }
          }
        })()
      }
      await new Promise(() => {})                // runs until the monitor kills it
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
agent: ${AGENT}${ME !== AGENT ? `   ·   writer: ${ME} (this session)` : ""}   ·   store: ${store.ROOT}

  sac agents                          who exists, who is alive
  sac rooms                           rooms
  sac send <room> <type> "text"       entry (${store.TYPES.join(" | ")})
  sac inbox <room>                    new messages from others (marks them read)
  sac peek <room>                     the same, without moving the cursor
  sac unread <room> [n]               make the last n messages unread again
  sac history <room> [n]              read back
  sac install <room> [--dry-run]      wire both hooks into this project's settings.json
  sac wait [--once] [room…]           BLOCK until a message arrives (for a Monitor)
  sac watch-paths <room>              the files to watch (for the hook)
  sac register <room>                 check in to the registry`)
      process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  console.error(`sac: ${e.message}`)
  process.exit(1)
}
