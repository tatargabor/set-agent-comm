#!/usr/bin/env node
/**
 * SessionStart hook — bejelentkezés a nyilvántartóba + a TÖBBIEK busz-fájljainak
 * regisztrálása a Claude Code natív fájlfigyelőjébe (`hookSpecificOutput.watchPaths`).
 *
 * Bekötés a projekt .claude/settings.json-jébe:
 *   { "hooks": { "SessionStart": [ { "hooks": [ {
 *       "type": "command",
 *       "command": "SET_AGENT_ROOM=consumer-a-set node ~/code2/set-agent-comm/hooks/session-start.mjs" } ] } ] } }
 *
 * MIÉRT EZ A LÉNYEG: a consumer-a ↔ set-core csatornán a figyelést egy kézzel épített
 * apparátus végezte (Monitor long-poll + cron őrjárat + `pgrep`-es életben tartás), amit a
 * CLAUDE.md ~60 sorban ír le, három külön mérési tanulsággal arról, hogyan téved a
 * `TaskList` és a `pgrep` — MINDKÉT irányba (a `TaskList` „nincs figyelő"-t mond egy futó
 * figyelőre → vakon indítasz egy másodikat; a `pgrep` találatszáma viszont felfelé téved az
 * efemer gyerekfolyamatoktól → kilövöd az élőt). A keretrendszer ezt natívan tudja.
 *
 * ⚠ Nemlétező útvonalat NEM regisztrálunk: a néma no-op kívülről pontosan úgy néz ki,
 * mint a működő figyelés.
 */
import { basename } from "node:path"
import { existsSync } from "node:fs"
import * as store from "../src/store.mjs"

const chunks = []
for await (const c of process.stdin) chunks.push(c)      // a stdin JSON-t el kell fogyasztani
let payload = {}
try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* elnyeljük */ }

const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const agent = process.env.SET_AGENT_NAME || basename(cwd)
const room = process.env.SET_AGENT_ROOM

const out = { hookSpecificOutput: { hookEventName: "SessionStart" } }

if (room) {
  store.register({ agent, project: cwd, session: payload.session_id, room })

  // Csak a MÁSOKÉT figyeljük — a saját írásunkra ébredni önébresztő hurok volna.
  const watch = store.busFiles(room).filter(p => basename(p) !== `${agent}.md` && existsSync(p))
  if (watch.length) out.hookSpecificOutput.watchPaths = watch

  const { unread } = store.inbox({ room, agent, advance: false })
  if (unread) {
    out.hookSpecificOutput.additionalContext =
      `[set-agent-comm] ${unread} olvasatlan üzenet a(z) "${room}" szobában. ` +
      `Az \`inbox\` toollal (vagy \`sac inbox ${room}\`) olvasd el, mielőtt a közös munkához nyúlnál.`
  }
}

process.stdout.write(JSON.stringify(out))
