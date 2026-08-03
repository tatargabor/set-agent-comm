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
import { existsSync, mkdirSync, appendFileSync } from "node:fs"
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

  // HIDEGINDÍTÁS (mérve az élesítéskor). Két hézag, mindkettő némán nyelte volna el
  // az ELSŐ üzenetet — pont azt, amelyik a kapcsolatot nyitja:
  //
  //  1. üres szobában nincs egyetlen fájl sem → nincs mit a `watchPaths`-ba tenni;
  //  2. egy ÚJ résztvevő fájljáról a többiek csak a KÖVETKEZŐ session-indulásnál
  //     szereznének tudomást, mert a listát induláskor egyszer állítjuk össze.
  //
  // Ezért: (a) megjelenünk a szobában egy üres saját fájllal — ez a „itt vagyok, ide
  // írok" bejelentés —, és (b) magát a KÖNYVTÁRAT is figyeljük, hogy az új fájl
  // megjelenése is esemény legyen.
  const dir = store.channelDir(room)
  mkdirSync(dir, { recursive: true })
  const mine = store.busFile(room, agent)
  if (!existsSync(mine)) appendFileSync(mine, "")

  // Csak a MÁSOKÉT figyeljük — a saját írásunkra ébredni önébresztő hurok volna.
  const watch = store.busFiles(room).filter(p => basename(p) !== `${agent}.md` && existsSync(p))
  // ⚠ A könyvtár-figyelés támogatottsága ELLENŐRIZETLEN. Ha a Claude Code csak fájlt
  // fogad el, ez a bejegyzés legrosszabb esetben hatástalan — a fájlonkénti figyelés
  // tőle függetlenül él, tehát nem ronthat el semmit.
  out.hookSpecificOutput.watchPaths = [dir, ...watch]

  const { unread } = store.inbox({ room, agent, advance: false })
  if (unread) {
    out.hookSpecificOutput.additionalContext =
      `[set-agent-comm] ${unread} olvasatlan üzenet a(z) "${room}" szobában. ` +
      `Az \`inbox\` toollal (vagy \`sac inbox ${room}\`) olvasd el, mielőtt a közös munkához nyúlnál.`
  }
}

process.stdout.write(JSON.stringify(out))
