#!/usr/bin/env node
// A CLI on top of the core — hooks, cron and humans call this.
// It uses the same core as the MCP server, so the two cannot drift apart.
//
//   sac agents                          who exists, who is alive
//   sac rooms                           rooms
//   sac admin                           full-screen view: channels, subscribers, live flow
//   sac send <room> <type> "text"       entry (append); --to <name>[,…] addresses it
//   sac inbox <room>                    new messages from others
//   sac peek <room>                     the same, but does not move the cursor
//   sac history <room> [n]              read back
//   sac watch-paths <room>              the files to watch (for the hook)
//   sac register <room>                 check in to the registry
//   sac prune [--days N] [--dry-run]    forget seats of windows long gone (registry only)

import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { watch, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import * as store from "../src/store.mjs"

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks")

/**
 * Upload, and never let a relay problem look like a send problem: the entry is already on disk
 * by the time this runs. The result is REPORTED (`relay: "queued (…)"`), not swallowed — a
 * silent upload failure is indistinguishable from a delivered message, which is the one thing
 * this project refuses to do.
 */
const relayPush = async room => (await import("../src/bridge.mjs")).pushReport(room)

const AGENT = process.env.SET_AGENT_NAME || basename(process.cwd())
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || null
const [cmd, ...rest] = process.argv.slice(2)

/**
 * ⚠ AN UNRECOGNISED `SET_AGENT_COMM_*` VARIABLE IS SAID OUT LOUD. Measured 2026-08-10: an agent
 * isolating a probe exported `SET_AGENT_COMM_HOME` — a variable that does not exist. Nothing
 * said so, the probe ran against the LIVE store, and left a room called `--help` behind it. The
 * defensive intent evaporated in silence, which is the worst way for a safety measure to fail.
 *
 * On stderr, so a caller parsing stdout is unaffected, and it never stops the command: the point
 * is to name the store actually in use, not to guess what was meant.
 */
const KNOWN_ENV = new Set(["SET_AGENT_COMM_DIR"])
for (const name of Object.keys(process.env)) {
  if (name.startsWith("SET_AGENT_COMM_") && !KNOWN_ENV.has(name)) {
    console.error(`sac: warning: '${name}' is not a variable this program reads ` +
      `(did you mean SET_AGENT_COMM_DIR?) — the store in use is ${store.ROOT}`)
  }
}

/**
 * ⚠ `--help` WORKS ON EVERY SUBCOMMAND, and a flag is NEVER a room name. Measured the same day:
 * `sac send --help FACT "proba"` took `--help` as the room, and join-on-write turned it into a
 * room in the live store. A help flag that is silently a positional argument is worse than none.
 */
const USAGE = {
  agents: "sac agents                          who exists, who is alive",
  rooms: "sac rooms                           the rooms — and how far each one reaches",
  admin: "sac admin                           the operator's live view (Tab panes · ↵ open · / search · ? keys)",
  send: 'sac send <room> <type> "text" [--to <seat|project>[,…]] [--re <ts>]',
  focus: 'sac focus ["what you are on"] [--files a,b]   · no args reads it back',
  inbox: "sac inbox <room>                    new messages from others (marks them read)",
  peek: "sac peek <room>                     the same, without moving the cursor",
  unread: "sac unread <room> [n]               make the last n messages unread again",
  history: "sac history <room> [n]              read back",
  install: "sac install <room>[,<room>…] [--dry-run]",
  wait: "sac wait [--once] [room…]           BLOCK until a message arrives (for a Monitor)",
  prune: "sac prune [--days N] [--dry-run]    forget seats whose window is long gone",
  "watch-paths": "sac watch-paths <room>              the files to watch (for the hook)",
  register: "sac register <room>                 check in to the registry",
  relay: "sac relay use <url> --secret <s>   |   sac relay status",
  invite: 'sac invite <room> --for "<device>" [--ttl <seconds>]',
  join: "sac join <room> [--create]   |   sac join sac-join:<code> [--as <device>]",
  part: "sac part <room>                     leave a room (this seat only; its entries stay)",
  quiet: "sac quiet [--for 2h|90m|1d] [--off]   stop being woken; delivery is unaffected",
  stats: "sac stats [room…] [--since 24h] [--seats]   what the bus cost: decisions, wake-ups, characters",
  sync: "sac sync [room…]                    push and pull once, without blocking",
}
if (cmd && (rest.includes("--help") || rest.includes("-h")) && USAGE[cmd]) {
  console.log(`usage: ${USAGE[cmd]}`)
  process.exit(0)
}

// …and where the FIRST argument is a room, a flag in that position is a usage error rather than
// a room called `--help`. Only these commands: `wait --once`, `prune --days` and `relay use`
// legitimately lead with a flag.
const ROOM_FIRST = new Set(["send", "inbox", "peek", "unread", "history", "watch-paths", "register", "install", "invite"])
if (ROOM_FIRST.has(cmd) && rest[0]?.startsWith("-")) {
  console.error(`sac: ${cmd}: '${rest[0]}' is a flag, not a room name.\nusage: ${USAGE[cmd]}`)
  process.exit(1)
}

// The same seat the MCP server and the hook use: `CLAUDE_CODE_SESSION_ID` is inherited by
// everything Claude Code starts, so a `sac` call from a session writes into that session's
// file. From a bare terminal (no session id) there is no seat — that is the base name, as
// before, and `send` then warns about the shared file.
//
// A seat is CLAIMED only by a command that writes or that keeps a read cursor. Measured: with
// an unconditional claim `sac agents` — a pure listing — invented a third session in a project
// that had two.
const CLAIMS = new Set(["send", "inbox", "peek", "unread", "register", "focus"])
const seat = { agent: AGENT, session: SESSION }
const ME = CLAIMS.has(cmd) ? store.claimSeat(seat) : store.seatOf(seat)
const json = v => console.log(JSON.stringify(v, null, 2))

// The addressee is shown where it stands in the file, and `(not for you)` is spelled out:
// reading an entry aimed at someone else and answering it as if asked is a real failure mode —
// it happened on the live bus before addressing existed.
const fmt = m => `## ${m.ts} — ${m.type}${m.to?.length ? ` → ${m.to.join(", ")}` : ""}` +
  `${m.re ? ` (re: ${m.re})` : ""}  [${m.from}]${m.forMe === false ? "  (not for you)" : ""}\n${m.text}\n`

/** Pull `--flag <value>` out of the argv, so it cannot end up inside the message text. */
const takeFlag = (argv, name) => {
  const i = argv.indexOf(name)
  if (i === -1) return { value: null, rest: argv }
  return { value: argv[i + 1], rest: [...argv.slice(0, i), ...argv.slice(i + 2)] }
}

try {
  switch (cmd) {
    case "admin": {
      // Read-only by construction: it derives everything from the registry, the cursors and
      // the channel files and writes nothing back, so watching a room can never change what
      // the seats in it will see.
      const { runAdminTui } = await import("../src/admin-tui.mjs")
      if (!process.stdout.isTTY) throw new Error("sac admin needs a terminal — pipe `sac agents`/`sac history` instead")
      // `break`, not `return`: the switch sits at ESM top level, where a return is a syntax
      // error that takes the WHOLE cli down — every subcommand, not just this one.
      runAdminTui()
      break
    }

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
        // The column is sized to the longest name present: a remote seat carries its machine
        // (`set-agent-comm@workstation`) and a fixed width ran the columns together.
        const w = Math.max(20, ...live.map(x => x.writer.length))
        live.forEach((x, i) => {
          console.log(
            `  ${i === live.length - 1 ? "└" : "├"} ${x.writer.padEnd(w)}  ${x.live === null ? "(?) " : "    "}` +
            (x.lastWrote ? `wrote ${x.lastWrote.slice(11, 16)}` : "never wrote"))
          // What that session says it is doing — the answer to "who is in these files", without
          // anyone having to ask it in the room. `(stale)` because a four-hour-old claim is worth
          // reporting and worth doubting, and silently dropping it would leave nothing at all.
          if (x.focus) console.log(`  ${i === live.length - 1 ? " " : "│"}   ↳ ${x.focus.text}` +
            (x.focus.files.length ? `  [${x.focus.files.join(", ")}]` : "") +
            (x.focus.stale ? `  (stale — ${x.focus.ageMinutes}m old)` : ""))
        })
      }
      break
    }
    case "rooms": {
      // Where each room REACHES, not just its name — a room you were invited to is listed
      // before its first message, and a local one says plainly that it stops at this machine.
      const { readConfig } = await import("../src/bridge.mjs")
      const remote = readConfig().rooms || {}
      const all = [...new Set([...store.knownRooms(), ...Object.keys(remote)])].sort()
      if (!all.length) { console.log("(no rooms yet)"); break }
      const mine = store.members(ME)
      // ⚠ MEMBERSHIP IS SHOWN FROM BOTH ENDS. Measured on the live bus 2026-08-08, and said in
      // as many words by a session that could not work out who it was talking to: *"room
      // membership is invisible from both ends"* — you could not see who was in a room, and you
      // could not see which rooms you were in beyond your own configuration.
      const liveOf = new Map()
      for (const a of store.agents()) for (const s of a.seats || []) liveOf.set(s.writer, s.live)
      for (const room of all) {
        const here = mine === null ? "" : mine.includes(room) ? "   ← you are in this one" : "   (you are not in it)"
        console.log((remote[room]
          ? `${room.padEnd(18)} relay   as ${AGENT}@${remote[room].namespace}   ${remote[room].url}`
          : `${room.padEnd(18)} local   (this machine only)`) + here)
        const others = store.participants(room).filter(p => p !== ME && p.includes("#"))
        if (!others.length) { console.log(`${" ".repeat(20)}nobody else is in this room`); continue }
        for (const seat of others) {
          const p = store.seatPresence(seat)
          const live = liveOf.get(seat)
          // Three-state liveness stays three-state here too: unknown is "unknown", never "gone".
          const state = p.quiet ? `quiet${p.until ? ` until ${p.until}` : ""}`
            : live === true ? "live" : live === false ? "closed" : "unknown"
          console.log(`${" ".repeat(20)}${seat.padEnd(38)} ${state}`)
        }
      }
      break
    }

    case "send": {
      const { value: to, rest: afterTo } = takeFlag(rest, "--to")
      const create = afterTo.includes("--create")
      const args = afterTo.filter(a => a !== "--create")
      const [room, type, ...text] = args
      if (!room || !text.length) throw new Error('usage: sac send <room> <type> "text" [--to <seat|project>[,…]]')
      // ⚠ A ROOM MUST EXIST. Measured 2026-08-10: join-on-write means a mistyped room name is not
      // an error but a new, silent room you are alone in — and `send` returns SUCCESS. The store
      // still carries a room called `--help` from exactly that. This is the same asymmetry the
      // mistyped ADDRESSEE already gets: fail at the writer, and name what could have been meant.
      if (!store.roomExists(room)) {
        if (!create) {
          const known = store.knownRooms()
          throw new Error(`send: there is no room called '${room}'` +
            (known.length ? ` — this store has: ${known.join(", ")}` : " and this store has none") +
            `. A room is opened on purpose: \`sac send ${room} … --create\` or \`sac install ${room}\`.`)
        }
        const made = store.createRoom(room, ME)
        if (made.created) console.error(`sac: opened a new room '${room}'`)
      }
      const out = store.send({ room, from: ME, type, text: text.join(" "), to })
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
    case "focus": {
      // `sac focus` alone reports; with text it declares. The declaration is what the letterbox
      // reasons about AND what `agents` shows the others — the scope negotiation that cost 46
      // broadcast entries in two days becomes a field they can read.
      const { value: files, rest: args } = takeFlag(rest, "--files")
      if (!args.length) { json(store.getFocus(ME) || { agent: ME, focus: null }); break }
      json(store.setFocus({ agent: ME, text: args.join(" "), files }))
      break
    }
    case "prune": {
      // Registry hygiene, and nothing else: the message files are the log and are never touched.
      // Measured 2026-08-06 — 32 seats remembered, 2 of them alive, 25 belonging to one project.
      const { value: days, rest: args } = takeFlag(rest, "--days")
      // ⚠ An unrecognised flag USED TO BE IGNORED, and on the one command where that is worst.
      // Measured 2026-08-08: `sac prune --dry` — the obvious spelling — silently ran the real
      // prune on the live registry and forgot 261 seats, then reported them as "would drop".
      // A rehearsal that performs the act is worse than no rehearsal, so an unknown flag stops
      // here rather than quietly meaning "yes, do it".
      const dry = args.includes("--dry-run") || args.includes("--dry")
      const unknown = args.find(a => a.startsWith("-") && a !== "--dry-run" && a !== "--dry")
      if (unknown) throw new Error(`prune: unknown flag '${unknown}' — did you mean --dry-run?`)
      const r = store.pruneSeats({ days: Number(days) || 7, dry })
      for (const d of r.dropped) console.log(`${dry ? "would drop" : "dropped  "} ${d.seat.padEnd(44)} last seen ${d.lastSeen || "never"}`)
      console.log(`${r.dropped.length} seat(s) ${dry ? "would be forgotten" : "forgotten"}, ${r.kept} kept` +
        ` — no message file is ever touched${dry ? " (dry run: nothing was written)" : ""}`)
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
        // HTTPS is checked HERE, at configuration time: a token that has already been sent in
        // clear cannot be un-sent, so the refusal has to come before the first call.
        cfg.relay = { url: bridge.assertSecureUrl(url), secret }
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
      // ⚠ THE ROOM MUST ALREADY EXIST, and this is the strictest of the three places that check.
      // An invite is the one act here that leaves the machine: a mistyped room name would send a
      // colleague a code that lands them, alone, in a room nobody else is in — and both sides
      // would believe they were talking. `--create` is deliberately NOT offered here.
      if (!store.roomExists(room)) {
        throw new Error(`invite: there is no room called '${room}' on this machine — ` +
          `${store.knownRooms().join(", ") || "this store has none"}. ` +
          `Open it first (\`sac install ${room}\`), so the person you invite arrives somewhere real.`)
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
      // The stated validity must be the REAL one: a `--ttl` that the printed text contradicts
      // is the kind of small lie that makes someone trust the next sentence less.
      const ttl = Number(rest[rest.indexOf("--ttl") + 1]) || 900
      const code = issue(cfg.relay.secret, { kind: "invite", room, device, jti: randomUUID() }, ttl)
      const payload = Buffer.from(JSON.stringify({ u: cfg.relay.url, r: room, c: code, k: key })).toString("base64url")
      console.log(`sac-join:${payload}\n`)
      const human = ttl % 3600 === 0 ? `${ttl / 3600} hour(s)` : `${Math.round(ttl / 60)} minutes`
      console.log(`Valid for ${human}, for "${device}". On the other machine:\n` +
        `  sac join sac-join:…\n\n` +
        `⚠ Hand it over OUT OF BAND (Signal, a call). It carries the room key, which is what\n` +
        `  keeps the relay unable to read the room — send it through the relay and that is gone.`)
      break
    }

    case "join": {
      const [code] = rest.filter(a => !a.startsWith("--"))
      const asName = rest.includes("--as") ? rest[rest.indexOf("--as") + 1] : null
      // ⚠ ONE VERB, TWO THINGS TO JOIN, and the prefix decides which. `sac join <room>` puts
      // THIS SEAT in a room on this machine; `sac join sac-join:<code>` redeems an invite from
      // another machine. Splitting them into two verbs was the alternative, and it makes the
      // common case (a room) carry the name of the rare one. What may not happen is a mistyped
      // invite silently opening a room called `sac-join`, so anything that looks like a code
      // and is not one fails here rather than falling through.
      if (!code?.startsWith("sac-join:")) {
        if (code?.includes(":")) {
          throw new Error(`join: '${code}' looks like an invite code but does not start with ` +
            `'sac-join:'. A room name may not contain ':'.`)
        }
        if (!code) throw new Error("usage: sac join <room> [--create]   |   sac join sac-join:<code> [--as <device>]")
        if (!store.roomExists(code)) {
          if (!rest.includes("--create")) {
            throw new Error(`join: there is no room called '${code}' — ` +
              `${store.knownRooms().join(", ") || "this store has none"}. Open one with \`--create\`.`)
          }
          store.createRoom(code, ME)
        }
        json({ agent: ME, rooms: store.joinRoom(ME, code) })
        break
      }
      const bridge = await import("../src/bridge.mjs")
      const { u, r, c, k } = JSON.parse(Buffer.from(code.slice("sac-join:".length), "base64url"))
      bridge.assertSecureUrl(u)      // an invite may not talk us into an unencrypted relay
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
      // ⚠ THE ROOM IS OPENED LOCALLY TOO. Redeeming an invite is the most explicit possible act
      // of joining a room, and without this the machine that just joined could not write into it
      // — `send` would refuse a room that exists on the relay and nowhere on this disk. Caught by
      // `relay.test.mjs` the moment rooms stopped being created by writing into them.
      if (!store.roomExists(r)) store.createRoom(r, ME)
      store.joinRoom(ME, r)
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

      // ⚠ THE PROJECT GETS AN ADDRESS ROOM, whether or not anyone asked. Measured 2026-08-04: an
      // agent INFERRED a room name from a naming convention and then spent a whole entry asking
      // whether it had guessed right — *"I did not get an explicit instruction; better one spare
      // empty room than two agents talking past each other."* A room whose name nobody has to
      // guess is one line of setup, and this is where the setup already happens.
      const opened = []
      if (!dry) {
        for (const r of [...rooms, AGENT]) {
          if (!store.roomExists(r)) { store.createRoom(r, ME); opened.push(r) }
        }
      }

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

      // ⚠ The INTERPRETER IS SPELLED OUT (`process.execPath`), never a bare `node`. Measured on
      // a Mac mini: node lived in `~/.local/node/bin`, which reaches the PATH from `~/.zshrc` —
      // and hooks do not run in an interactive shell. A bare `node` would have failed there
      // with "command not found", which from the outside is a hook that simply never fires.
      const env = `SET_AGENT_NAME=${AGENT} SET_AGENT_ROOM=${rooms.join(",")}`
      // PostToolUse carries the SIGN OF LIFE: the registry's liveness field only ever got
      // written at session start, so a working seat looked silent (measured: 86 minutes).
      // It is fed by the machine because an agent-sent heartbeat costs a whole turn, and rate-
      // limited inside the script because `register` rewrites the shared registry.
      const scripts = { SessionStart: "session-start.mjs", Stop: "stop.mjs", PostToolUse: "heartbeat.mjs" }
      const wanted = Object.fromEntries(Object.entries(scripts)
        .map(([event, script]) => [event, `${env} ${process.execPath} ${join(HOOKS, script)}`]))
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
        .replaceAll("{{SAC}}", `${process.execPath} ${sac}`)
        .replaceAll("{{WAIT_COMMAND}}", `SET_AGENT_NAME=${AGENT} ${process.execPath} ${sac} wait ${rooms.join(",")}`)
      const skillState = !existsSync(skillTo) ? "installed"
        : readFileSync(skillTo, "utf8") === skill ? "already current" : "updated"
      changes.push(`skill: ${skillState}`)

      console.log(`${dry ? "[dry run] " : ""}${file}`)
      if (opened.length) console.log(`  rooms opened: ${opened.join(", ")}` +
        (opened.includes(AGENT) ? `   (${AGENT} is this project's own address — anyone can write to it)` : ""))
      for (const c of changes) console.log(`  ${c}`)
      for (const [e, c] of Object.entries(wanted)) console.log(`  ${e} → ${c}`)
      console.log(`  skill  → ${skillTo}`)
      if (dry) break
      if (changes.every(c => c.endsWith("already wired") || c.endsWith("already current"))) break

      store.ensureDir(dirname(file))
      // A backup before every write. This file is not ours, and it is not reconstructible.
      if (existsSync(file)) {
        const bak = `${file}.bak.${store.now().replace(/[:.]/g, "-")}`
        copyFileSync(file, bak)
        console.log(`  backup: ${bak}`)
      }
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")

      if (skillState !== "already current") {
        store.ensureDir(dirname(skillTo))
        // The skill file is ours end to end, so it is overwritten — but a hand-edited copy is
        // still someone's work, so it is backed up first.
        if (skillState === "updated") copyFileSync(skillTo, `${skillTo}.bak.${store.now().replace(/[:.]/g, "-")}`)
        writeFileSync(skillTo, skill)
      }

      console.log(`\nRestart (or resume) the session for it to take effect.\n` +
        `The MCP server, separately:  claude mcp add agent-comm -e SET_AGENT_ROOM=${rooms.join(",")} -- ` +
        `${process.execPath} ${join(HOOKS, "..", "src", "stdio.mjs")}`)
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

      // ⚠ TWO GATES BEFORE A LINE IS PRINTED, because a printed line IS a turn of the main agent.
      //
      //  1. `wakes` (free, in the store): a broadcast FACT never wakes anyone. This is what the
      //     first two days of live traffic argued for — see the comment on `store.wakes`.
      //  2. the letterbox (a cheap model, see triage.mjs): of what survives gate 1, does THIS
      //     agent need to be the one to deal with it? A message addressed to a project with four
      //     open sessions passes gate 1 for all four; usually at most one of them is meant.
      //
      // Both gates fail towards waking. Neither ever touches the cursor: an entry we decline to
      // wake on stays unread and the next `inbox` hands it over.
      const QUIET_MS = Number(process.env.SET_AGENT_QUIET_MS) || 3000
      const triage = await import("../src/triage.mjs")

      // ⚠ THE THIRD GATE, pointed the other way — see `rescue` in triage.mjs. Gates 1 and 2 both
      // guard against a needless turn; nothing guarded against the expensive mistake, which is the
      // rule declining an entry that really was this seat's. Measured: six live sessions, five
      // broadcast FACTs, one of them a rename two other projects had to follow, nobody woken.
      // It runs ONLY where nothing else was announced, on the newest unjudged entry, once per
      // entry per seat, and it FAILS CLOSED — a net that guesses yes rebuilds the storm.
      const NET = process.env.SET_AGENT_SAFETY_NET !== "off"

      /**
       * The net, run only where nothing was announced. One entry — the newest the rule declined
       * and nobody has judged yet — because this is the layer that could quietly become a model
       * call per entry per seat per poll if it were let off the leash. The ledger is the leash.
       */
      const net = async (room, r) => {
        if (!NET) return
        const missed = r.messages.filter(m => !m.wakes).at(-1)
        if (!missed) return
        if (!store.shouldNudge({ room, agent: ME, ts: missed.ts, via: "net" })) return
        const v = await triage.rescue({ entry: missed, room, seat: ME })
        // The net fails CLOSED, so an unavailable one is a silence, not a decision — recorded as
        // the failure it is, for the same reason as the letterbox above.
        store.recordDecision({ room, seat: ME, entry: missed.ts,
          by: v.via === "unavailable" ? "net-failed" : "net", woke: !!v.wake })
        if (!v.wake) return
        store.recordWake({ room, seat: ME, entry: missed.ts, how: "announced" })
        const preview = missed.text.replace(/\s+/g, " ").slice(0, 240)
        // Said plainly: the rule declined this one, and the net overruled it. An agent that is
        // woken by something the protocol said was not urgent deserves to know which layer did it.
        console.log(`[set-agent-comm] ${missed.type} from ${missed.from} in "${room}" was NOT ` +
          `addressed to you, but looks like yours anyway (${v.why}): "${preview}" ` +
          `— read it with \`inbox\` (room: ${room}).`)
        if (once) process.exit(0)
      }

      const check = async () => {
        for (const room of watched) {
          const r = store.inbox({ room, agent: ME, advance: false })
          const waking = r.messages.filter(m => m.wakes)
          const last = waking.at(-1)
          if (!last) { await net(room, r); continue }
          // ⚠ THE LEDGER IS ON DISK (`shouldNudge`), not in a variable here. Measured 2026-08-06:
          // an in-memory ledger meant every restart of this process re-announced the whole
          // backlog — the same three notifications, 32 seconds apart, one of them "48 unread FOR
          // YOU", on a day when nobody had written anything. Marked BEFORE the letterbox runs:
          // having decided about an entry is what the ledger records, not having shouted about it.
          if (!store.shouldNudge({ room, agent: ME, ts: last.ts, via: "wait" })) { await net(room, r); continue }

          // At most the three newest, judged in parallel: one waking entry may hide behind
          // another, and three model calls is the point where the letterbox stops being cheap.
          const seat = store.agents().find(a => a.agent === store.seatBase(ME))
          const live = seat?.live || []
          const candidates = waking.slice(-3)
          const judged = await Promise.all(candidates.map(m =>
            triage.triage({ entry: m, room, seat: ME, live })))
          // ⚠ findLAST, not findFirst. The older entries are still unread — an agent that was
          // woken and did not answer keeps them — so the first approved one is routinely something
          // this seat has already been told about. Reporting it again is the storm in miniature.
          // ⚠ THE LETTERBOX'S VERDICT IS RECORDED, and a FAILURE is recorded as a failure rather
          // than as a "yes". The letterbox fails open, so an unreachable classifier and an
          // approving one produce the same wake-up — and collapsing them in the ledger would hide
          // the one number that says whether the letterbox is earning its cost.
          for (const [i, v] of judged.entries()) {
            // `via` says which layer answered: `direct` never reached the model (someone typed a
            // seat name and a classifier does not get to overrule that), `unavailable` is the
            // fail-open path, `model` is a real verdict.
            const by = v.via === "direct" ? "rule" : v.via === "unavailable" ? "letterbox-failed" : "letterbox"
            store.recordDecision({ room, seat: ME, entry: candidates[i].ts, by, woke: !!v.wake })
          }
          const yes = judged.findLastIndex(v => v.wake)
          if (yes === -1) { await net(room, r); continue }   // delivered, unread, not worth a turn

          const woke = candidates[yes]
          store.recordWake({ room, seat: ME, entry: woke.ts, how: "announced" })
          const preview = woke.text.replace(/\s+/g, " ").slice(0, 240)
          const rest = r.unread - 1
          // ⚠ The TEXT rides along, not just a count. The agent can often answer — or decide it
          // has nothing to add — without an `inbox` round trip at all, and a count on its own
          // ("48 unread") is what made these notifications unreadable in the first place.
          console.log(`[set-agent-comm] ${woke.type} from ${woke.from} in "${room}": "${preview}" ` +
            `— read it with \`inbox\` (room: ${room}) and answer.` +
            (rest > 0 ? ` (${rest} other unread ${rest === 1 ? "entry" : "entries"} here, none urgent.)` : ""))
          if (once) process.exit(0)
        }
      }

      // Coalesce a burst. Four seats answering each other inside a minute is one conversation,
      // not four interruptions — measured: 23 entries in 8 minutes across four seats.
      let quiet = null
      const soon = () => { clearTimeout(quiet); quiet = setTimeout(() => void check(), QUIET_MS) }

      await check()                              // what is ALREADY waiting counts as an event
      for (const room of watched) {
        const dir = store.channelDir(room)
        store.ensureDir(dir)
        // A new participant's file appearing is an event too, so we watch the DIRECTORY.
        try { watch(dir, soon) } catch { /* the poll below covers it */ }
      }
      // The safety net. `fs.watch` misses events on some file systems, and a watcher that
      // silently stops looks exactly like a quiet room — the most dangerous false negative here.
      setInterval(() => void check(), 5000)

      // ⚠ DIE WITH THE SESSION. Measured 2026-08-06: five `sac wait` processes were alive at once,
      // four of them for `consumer-a`, the oldest from the previous morning — a monitor outlives the
      // Claude Code session that armed it, and the next session arms another. Their notifications
      // still land, out of a dead session's context and off a cursor nobody advances.
      //
      // The parent is the shell the Monitor started us from; when the session goes, so does it,
      // and Linux reparents us to pid 1. That is the signal, and it costs one integer comparison.
      const PARENT = process.ppid
      setInterval(() => {
        if (process.ppid !== PARENT) {
          console.log(`[set-agent-comm] the session that started this watch is gone — stopping.`)
          process.exit(0)
        }
      }, 30_000).unref()

      // THE REMOTE LEG rides on this same watcher: for rooms that have a relay we long-poll it
      // in parallel, and what arrives is written into the local room — where the loop above
      // finds it and reports it like any other message. No second daemon, and nothing
      // downstream had to learn that a message can come from another machine.
      const bridge = await import("../src/bridge.mjs")
      for (const room of watched.filter(r => bridge.roomConfig(r))) {
        void (async () => {
          let backoff = 1000
          // What we print here WAKES someone (see `outageLog`), so a blip the loop absorbs by
          // itself is not news. An epoch change still speaks up immediately — that one is a
          // relay restart, and the pull's own `log` says so.
          const outage = bridge.outageLog({ report: m => console.log(`[set-agent-comm] ${m}`) })
          for (;;) {
            try {
              await bridge.push({ room })                        // whatever the outbox still owes
              await bridge.pull({ room, wait: 25, log: m => console.log(`[set-agent-comm] ${m}`) })
              check()
              backoff = 1000
              outage.recovered(`relay "${room}" is reachable again`)
            } catch (e) {
              // A relay outage may not kill the watch: local messages must keep flowing, and
              // the remote ones catch up when it returns. Backing off keeps a dead relay from
              // turning into a hot loop; the ceiling keeps recovery within a minute.
              outage.failed(`relay "${room}" unreachable (${e.message})`)
              await new Promise(r => setTimeout(r, backoff))
              backoff = Math.min(backoff * 2, 60_000)
            }
          }
        })()
      }
      await new Promise(() => {})                // runs until the monitor kills it
      break
    }
    case "quiet": {
      // ⚠ A DECLARED withdrawal from the conversation. Measured 2026-08-05 on the live bus, said
      // by a session that had just stopped its watcher: *"a stopped watcher and a silent agent
      // look the same from outside, so without saying it anyone would have waited for you in
      // vain."* The room already knew this had to be spoken; until now there was nothing but an
      // entry to speak it with, and an entry is a protocol, not a mechanism.
      if (rest.includes("--off")) { json({ agent: ME, ...store.setQuiet(ME, { quiet: false }) }); break }
      const { value: forSpec } = takeFlag(rest, "--for")
      let until = null
      if (forSpec) {
        const m = /^(\d+)\s*([mhd])?$/.exec(forSpec.trim())
        if (!m) throw new Error("usage: sac quiet [--for 2h|90m|1d] [--off]")
        const ms = Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3 }[m[2] || "m"])
        until = store.now(new Date(Date.now() + ms))
      }
      const p = store.setQuiet(ME, { quiet: true, until })
      json({ agent: ME, ...p, note: until
        ? `Quiet until ${until}. Entries are still DELIVERED and readable — only the wake-up is off.`
        : "Quiet with no expiry. Entries are still DELIVERED and readable — only the wake-up is off. `sac quiet --off` ends it." })
      break
    }
    case "stats": {
      // ⚠ READ-ONLY, like `sac admin`: it moves no cursor and marks nothing read. And it reports
      // the WINDOW it covers, because the ledger is bounded — a number whose window is unstated
      // is a number that will be misread, and this whole command exists because the project's
      // central claim (being read is cheap, being woken is expensive) had no number behind it.
      const { value: sinceSpec, rest: args } = takeFlag(rest, "--since")
      const seatsToo = args.includes("--seats")
      const roomsAsked = args.filter(a => !a.startsWith("-"))
      let since = null
      if (sinceSpec) {
        const m = /^(\d+)\s*([mhd])?$/.exec(sinceSpec.trim())
        if (!m) throw new Error("usage: sac stats [room…] [--since 24h] [--seats]")
        since = store.now(new Date(Date.now() - Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3 }[m[2] || "h"])))
      }
      const s = store.stats({ rooms: roomsAsked.length ? roomsAsked : null, since })
      if (!s.records) {
        // ⚠ "Nothing recorded yet" is NOT the same statement as a measured zero, and printing a
        // table of noughts would be the second one. The ledger starts when this version does.
        console.log("(nothing recorded yet — the ledger fills as entries are written and read)")
        if (!s.rooms.some(r => r.entries)) break
        console.log("The rooms below existed before the ledger did; their entry counts are read " +
          "from the channel itself.\n")
      } else {
        console.log(`window: ${s.window.from} … ${s.window.to}   (${s.records} records)\n`)
      }
      for (const r of s.rooms) {
        if (!r.entries && !Object.values(r.decisions).some(Boolean)) continue
        const d = r.decisions
        const decided = Object.values(d).reduce((a, b) => a + b, 0)
        console.log(`${r.room}`)
        console.log(`  entries ${r.entries}   ${r.chars} characters delivered for reading` +
          (r.clipped ? `   ${r.clipped} clipped by inbox` : ""))
        if (decided) {
          console.log(`  decisions ${decided}: rule ${d.rule} · letterbox ${d.letterbox} · ` +
            `net ${d.net || 0} · quiet ${d.quiet} · letterbox failed ${d["letterbox-failed"]}`)
          // The gap between these two is the point of the whole ledger: a wake-up that was
          // decided and never delivered is a seat with no watcher armed.
          console.log(`  wake-ups: ${r.woke} decided → ${r.announced} announced, ${r.blocked} turns held` +
            (r.woke > r.announced + r.blocked
              ? `   ⚠ ${r.woke - r.announced - r.blocked} reached no session (no watch armed?)` : ""))
        }
        if (seatsToo) {
          for (const [seat, v] of Object.entries(r.seats).sort()) {
            console.log(`    ${seat.padEnd(38)} ${String(v.decisions).padStart(5)} decisions, ` +
              `${v.woke} woke, ${v.announced} announced, ${v.blocked} held`)
          }
        }
        console.log("")
      }
      break
    }
    case "part": {
      // ⚠ Membership is per SEAT, not per project. Until 2026-08-11 the rooms came from
      // `SET_AGENT_ROOM` in the project's settings, so a fourth session could not live in a
      // different room from its three siblings without moving all four.
      const [room] = rest
      if (!room) throw new Error("usage: sac part <room>")
      const list = store.partRoom(ME, room)
      // Leaving never touches what was written: the seat's own file stays where it is, and
      // `history` still reads it back for everyone still in the room.
      json({ agent: ME, rooms: list, ...(!list.length
        ? { note: "This seat is now in NO room: it will receive nothing until it joins one. Its entries stay where they are." }
        : {}) })
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
  sac rooms                           rooms — and how far each one reaches
  sac admin                           full-screen: channels, WHO IS BEHIND on reading, live flow
  sac send <room> <type> "text"       entry (${store.TYPES.join(" | ")})
       [--to <seat|project>[,…]]      … addressed: this is what claims someone's ATTENTION
  sac focus ["what you are on"]       declare your scope [--files a,b] — read it back with no args
  sac inbox <room>                    new messages from others (marks them read)
  sac peek <room>                     the same, without moving the cursor
  sac unread <room> [n]               make the last n messages unread again
  sac history <room> [n]              read back
  sac install <room> [--dry-run]      wire both hooks into this project's settings.json
  sac wait [--once] [room…]           BLOCK until a message arrives (for a Monitor)
  sac watch-paths <room>              the files to watch (for the hook)
  sac register <room>                 check in to the registry
  sac prune [--days N] [--dry-run]    forget seats whose window is long gone (registry only)

across machines (optional — see the README):
  sac relay use <url> --secret <s>    point this machine at a relay
  sac relay status                    the relay, and the rooms bridged to it
  sac invite <room> --for <device>    mint an invite for ONE room  [--ttl <seconds>]
  sac join sac-join:<code>            accept one, on the other machine
  sac sync [room…]                    push and pull once, without blocking`)
      process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  console.error(`sac: ${e.message}`)
  process.exit(1)
}
