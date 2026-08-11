#!/usr/bin/env node
/**
 * A REPRODUCIBLE LIVE TEST — real `claude -p` sessions on a private bus.
 *
 *   node demo/harness.mjs demo/scenarios/<file>.json [--keep]
 *
 * Why this exists rather than another unit test: `store.test.mjs` proves what the code does, and
 * `nudge.test.mjs` proves what the watcher does. Neither can answer the question the first two
 * days of live use actually raised — WILL THE AGENTS USE IT THAT WAY? The `to` field was correct
 * code with a passing test suite and 190 consecutive entries that declined to use it. Protocol
 * adherence is a property of the prompt, the skill and the tool descriptions, and the only honest
 * way to measure it is to run real sessions and count what they wrote.
 *
 * Everything lands in a private store (`demo/run/store`), so a run can never touch the live bus.
 *
 * The seat of a session is its session id, so every round after the first RESUMES its session —
 * that is what makes a seat last longer than one turn, and what lets one project hold two of them.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs"
import { spawn, spawnSync, execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..")
// A run owns its directory outright — it wipes it on the way in. `DEMO_RUN_DIR` is what lets the
// harness's own smoke test (`demo/smoke.mjs`) run without deleting a real, paid run's measurement.
const RUN = process.env.DEMO_RUN_DIR || join(HERE, "run")
const STORE = join(RUN, "store")
const NODE = process.execPath

const scenarioPath = process.argv[2]
if (!scenarioPath) { console.error("usage: node demo/harness.mjs <scenario.json> [--keep]"); process.exit(1) }
// `extends` exists for exactly one reason: a remote variant must be the SAME scenario, not a copy
// of it that drifts. Comparing "the chain, local" with "the chain, across two machines" is only a
// measurement if the rounds are byte-for-byte the same rounds.
const load = p => {
  const s = JSON.parse(readFileSync(p, "utf8"))
  return s.extends ? { ...load(join(dirname(p), s.extends)), ...s } : s
}
const S = load(scenarioPath)
const MODEL = process.env.DEMO_MODEL || S.model || "claude-sonnet-5"
const ROOM = S.room || "team"

// ── which machine is each project on ──────────────────────────────────────────
// A scenario without `machines` is one machine, one store, exactly as before. With it, each named
// machine gets its OWN store directory — which is what a second computer is, as far as this code
// is concerned — and they can only reach each other through a real relay.
const MACHINES = S.machines || { local: Object.keys(S.projects) }
const HOME = {}
for (const [m, ps] of Object.entries(MACHINES)) for (const p of ps) HOME[p] = m
for (const p of Object.keys(S.projects)) if (!HOME[p]) HOME[p] = Object.keys(MACHINES)[0]
const REMOTE = Object.keys(MACHINES).length > 1
const OPERATOR = Object.keys(MACHINES)[0]          // the machine that holds the relay secret
const RELAY_PORT = Number(process.env.DEMO_RELAY_PORT) || 7599
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const RELAY_SECRET = "demo-relay-secret-not-a-real-one"
const storeDir = m => (REMOTE ? join(RUN, `store-${m}`) : STORE)
const stores = () => (REMOTE ? Object.keys(MACHINES).map(storeDir) : [STORE])

// ── setup ─────────────────────────────────────────────────────────────────────
if (!process.argv.includes("--keep")) rmSync(RUN, { recursive: true, force: true })
for (const d of stores()) mkdirSync(d, { recursive: true })
// The report imports `src/store.mjs` in THIS process to read the registry back. It resolves its
// paths from the environment at import time, so without this the report would answer from the
// live bus while every other number came from the run directory. With several machines it reads
// the OPERATOR's store — the one the report's roster and focus come from.
process.env.SET_AGENT_COMM_DIR = storeDir(OPERATOR)

const machineEnv = (machine, extra) => ({
  ...process.env,
  SET_AGENT_COMM_DIR: storeDir(machine),
  // What the other machines will see in front of the seat name (`invoicing@mini#7dad6e76`). On one
  // host every simulated machine would otherwise inherit the same hostname and collapse into one.
  ...(REMOTE && { SET_AGENT_DEVICE: machine }),
  SET_AGENT_ROOM: ROOM,
  // The letterbox costs a model call per candidate and is exercised by its own tests; what this
  // harness measures is what the AGENTS write, so it stays out of the way.
  SET_AGENT_TRIAGE: process.env.DEMO_TRIAGE || "off",
  ...extra,
})
const env = extra => machineEnv(OPERATOR, extra)
const envOf = (project, extra) => machineEnv(HOME[project], extra)

const sac = (machine, args, extra) =>
  spawnSync(NODE, [join(REPO, "bin", "sac.mjs"), ...args], { env: machineEnv(machine, extra), encoding: "utf8" })

// ── the relay, when the scenario asks for one ─────────────────────────────────
let relay = null
if (REMOTE) {
  relay = spawn(NODE, [join(REPO, "src", "relay.mjs")], {
    env: { ...process.env, RELAY_SECRET, PORT: String(RELAY_PORT), RELAY_HOST: "127.0.0.1" },
    stdio: "ignore",
  })
  const up = async () => {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${RELAY_URL}/health`)).ok) return true } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }
  if (!await up()) { console.error(`the relay did not come up on ${RELAY_URL}`); relay.kill(); process.exit(1) }

  // The handshake, run through the REAL CLI — `sac relay use`, `sac invite`, `sac join`. If the
  // handshake breaks, this breaks, which is the entire reason not to write the config files here.
  sac(OPERATOR, ["relay", "use", RELAY_URL, "--secret", RELAY_SECRET])
  // ⚠ The room has to exist on the operator's machine before anyone is invited into it. Since
  // 2026-08-11 a room is opened on purpose rather than by being written into, and `invite` is the
  // strictest of the checks — it is the one act that leaves the machine, and a mistyped name
  // would land the invitee alone in a room nobody else is in.
  sac(OPERATOR, ["register", ROOM])
  for (const m of Object.keys(MACHINES)) {
    if (m === OPERATOR) continue
    const out = sac(OPERATOR, ["invite", ROOM, "--for", m]).stdout || ""
    const code = (out.match(/sac-join:\S+/) || [])[0]
    if (!code) { console.error(`could not mint an invite for ${m}:\n${out}`); relay.kill(); process.exit(1) }
    const joined = sac(m, ["join", code, "--as", m])
    if (joined.status !== 0) { console.error(`${m} could not join:\n${joined.stdout}${joined.stderr}`); relay.kill(); process.exit(1) }
  }
  console.log(`▶ relay ${RELAY_URL} — gépek: ${Object.entries(MACHINES).map(([m, ps]) => `${m}(${ps.join(",")})`).join(" · ")}`)
}
process.on("exit", () => relay?.kill())

for (const project of Object.keys(S.projects)) {
  const dir = join(RUN, project)
  mkdirSync(join(dir, "src"), { recursive: true })
  for (const [f, body] of Object.entries(S.files?.[project] || { "src/config.mjs": "export const VAT = 0.27\n" })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })   // a scenario may name nested paths
    writeFileSync(join(dir, f), body)
  }
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { "agent-comm": { command: NODE, args: [join(REPO, "src", "stdio.mjs")], env: { SET_AGENT_ROOM: ROOM } } },
  }, null, 2) + "\n")
  // The real installer, not a hand-written settings file: if `sac install` breaks, this breaks.
  spawnSync(NODE, [join(REPO, "bin", "sac.mjs"), "install", ROOM], { cwd: dir, env: envOf(project), stdio: "ignore" })
}

// ── running one turn ──────────────────────────────────────────────────────────
// `Edit`/`Write` are named explicitly. `--allowedTools` PRE-APPROVES, it does not restrict — the
// seats were editing their files with it absent (verified on disk after the first handoff run), so
// leaving it out did not make them read-only, it only made the grant invisible. Say what is being
// handed out. Every path is inside `demo/run/<project>`, which the next run deletes.
const TOOLS = ["send", "inbox", "agents", "focus", "history", "rooms"]
  .map(t => `mcp__agent-comm__${t}`).concat(["Read", "Glob", "Grep", "Edit", "Write"]).join(",")

const seats = {}          // "project/n" → { session, project }
let spent = 0

// ⚠ Genuinely concurrent, because that is the case being measured. A round's seats used to be run
//   one after another, which quietly disarmed the round they exist for: two siblings reaching for
//   one file only collide if they are thinking AT THE SAME TIME. Sequentially, the second one
//   simply reads what the first already announced.
function turn(key, prompt) {
  const [project] = key.split("/")
  const held = seats[key]?.session
  const args = ["-p", prompt, "--model", MODEL, "--output-format", "json",
                "--mcp-config", ".mcp.json", "--strict-mcp-config", "--allowedTools", TOOLS]
  if (held) args.push("--resume", held)
  return new Promise(resolve => {
    const p = spawn("claude", args, { cwd: join(RUN, project), env: envOf(project), timeout: 600_000 })
    let stdout = "", stderr = ""
    p.stdout.on("data", d => stdout += d)
    p.stderr.on("data", d => stderr += d)
    p.on("close", () => {
      let out
      try { out = JSON.parse(stdout) } catch { return resolve({ key, error: (stdout || stderr).slice(0, 400) }) }
      seats[key] = { session: out.session_id, project }
      spent += out.total_cost_usd || 0
      resolve({ key, session: out.session_id, cost: out.total_cost_usd, text: String(out.result || "").trim() })
    })
  })
}

// ── the bus, read back ────────────────────────────────────────────────────────
const HEAD = /^## (\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2})?) — ([^\n(→]+?)(?:\s*→\s*([^\n(]+?))?(?:\s*\(re: ([^)]*)\))?\s*$/
// `catalog@mini#8ff87a3a` and `catalog#8ff87a3a` are ONE entry seen from two machines. The device
// tag is where it was read, not who wrote it, so it comes off before anything is counted.
const local = w => w.replace(/@[^#]+/, "")

function busEntries() {
  const out = []
  for (const store of stores()) {
    const dir = join(store, "channels", ROOM)
    let files
    try { files = readdirSync(dir).filter(f => f.endsWith(".md")) } catch { continue }
    for (const f of files) {
      const from = f.replace(/\.md$/, "")
      let cur = null
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        const m = line.match(HEAD)
        if (m) {
          if (cur) out.push(cur)
          cur = { from: local(from), remote: from !== local(from), ts: m[1], type: m[2].trim(),
                  re: m[4] || null, lines: [],
                  to: (m[3] || "").split(",").map(s => s.trim()).filter(Boolean) }
        } else if (cur) cur.lines.push(line)
      }
      if (cur) out.push(cur)
    }
  }
  // One entry per (writer, timestamp) — the copy that CROSSED is remembered, because "did this
  // reach the other machine at all" is the whole question a remote scenario is asking.
  const seen = new Map()
  for (const e of out.map(e => ({ ...e, text: e.lines.join("\n").trim() }))) {
    const k = `${e.from} ${e.ts}`
    const prev = seen.get(k)
    seen.set(k, prev ? { ...prev, crossed: prev.crossed || prev.remote || e.remote } : { ...e, crossed: e.remote })
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

// ── the report ────────────────────────────────────────────────────────────────
const ACK = /^(\*\*)?\s*(vettem|rendben|köszön|megkaptam|egyetért|nyugtáz|oké|ok\b|jogos|igazad|elfogadom|értem\b|received|agreed|thanks|noted)/i
const CLOSING = /(lezárom|kiszállok|nincs kérésem|részemről kész|zárás|closing this)/i

async function report() {
  const store = await import(join(REPO, "src", "store.mjs"))
  const all = busEntries()
  // ⚠ The roster is EVERY seat in the room, not just the ones that wrote. A silent seat is still
  //   interrupted by a broadcast, and it is still a seat that did or did not declare a focus —
  //   deriving the roster from the writers hid three of six seats and printed "4/3 declared".
  //   With several machines the registries are separate too — one per machine, by construction —
  //   so the roster is their union, with the device tag taken off.
  const readJson = p => { try { return JSON.parse(readFileSync(p, "utf8") || "{}") } catch { return {} } }
  const roster = [...new Set([
    ...stores().flatMap(s => Object.values(readJson(join(s, "registry.json")).agents || {})
      .filter(a => (a.rooms || []).includes(ROOM))
      .flatMap(a => Object.keys(a.seats || {}).map(local))),
    ...all.map(e => e.from),
  ])]
  const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`)

  console.log(`\n${"═".repeat(78)}\nMÉRÉS — ${S.name}   (${MODEL})\n${"═".repeat(78)}`)
  console.log(`\nBEJEGYZÉSEK (${all.length})`)
  for (const e of all) {
    const aim = e.to.length ? `→ ${e.to.join(",")}` : "(broadcast)"
    console.log(`  ${e.ts.slice(11, 19)} ${e.from.padEnd(22)} ${e.type.padEnd(8)} ${aim.padEnd(30)} ${String(e.text.length).padStart(5)}ch` +
      `${e.re ? " re:" + e.re.slice(11, 19) : ""}`)
    console.log(`         "${e.text.replace(/\s+/g, " ").slice(0, 120)}"`)
  }

  const bc = all.filter(e => !e.to.length)
  const seatAim = all.filter(e => e.to.some(t => t.includes("#")))
  const projAim = all.filter(e => e.to.length && !e.to.some(t => t.includes("#")))
  const acks = all.filter(e => ACK.test(e.text) || CLOSING.test(e.text))
  const chars = all.reduce((s, e) => s + e.text.length, 0)

  console.log(`\nCÍMZÉS`)
  line("broadcast", `${bc.length}/${all.length} (${pct(bc.length, all.length)})`)
  line("seatre címzett", `${seatAim.length}/${all.length} (${pct(seatAim.length, all.length)})`)
  line("projektre címzett", `${projAim.length}/${all.length} — ez minden ülését ébreszti`)
  line("több címzettet nevez meg", `${all.filter(e => e.to.length > 1).length}/${all.length}`)

  console.log(`\nTARTALOM`)
  line("átlagos hossz", `${all.length ? Math.round(chars / all.length) : 0} karakter (a mért régi átlag: 2168)`)
  line("leghosszabb", `${Math.max(0, ...all.map(e => e.text.length))} karakter`)
  line("nyugta-gyanús nyitás", `${acks.length}/${all.length}`)
  line("`re:`-láncolt", `${all.filter(e => e.re).length}/${all.length}`)
  line("típusok", Object.entries(all.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}))
    .map(([k, v]) => `${k}×${v}`).join(" · ") || "—")

  // The exact interruption count, computed from the rule rather than guessed: for every entry,
  // every OTHER seat in the room, does `wakes` say it buys a turn?
  let wakeNew = 0, wakeOld = 0
  const perSeat = {}
  for (const e of all) {
    const mine = new Set(all.filter(x => x.from === e.from).map(x => x.ts))
    for (const seat of roster) {
      if (seat === e.from) continue
      const own = new Set(all.filter(x => x.from === seat).map(x => x.ts))
      if (store.wakes(e, seat, own)) { wakeNew++; perSeat[seat] = (perSeat[seat] || 0) + 1 }
      if (store.isForMe(e, seat)) wakeOld++          // the pre-2026-08-06 rule
    }
    void mine
  }
  console.log(`\nMEGSZAKÍTÁSOK (a szabályból számolva, nem becsülve)`)
  line("a mostani szabállyal", `${wakeNew}`)
  line("a régivel (minden 'nekem szól')", `${wakeOld}`)
  // ⚠ "0%" was printed once for a run in which NOTHING was broadcast, and read as a regression.
  //   It was the opposite: with every entry addressed, the two rules agree by construction and
  //   every wake-up was earned. A ratio is only a measurement when there is something to save.
  line("megtakarítás", !all.length ? "—"
    : !bc.length ? "— (nem volt broadcast: a két szabály itt egybeesik, minden ébresztés jogos)"
    : pct(wakeOld - wakeNew, wakeOld))
  for (const [s, n] of Object.entries(perSeat).sort((a, b) => b[1] - a[1])) line(`  ébresztve: ${s}`, n)

  if (REMOTE) {
    // The one question a remote run asks that a local one cannot: did it get there at all. An
    // entry that never crossed is not slow, it is undelivered, and the two look identical from
    // the writing machine — which is exactly why this is counted rather than assumed.
    const crossed = all.filter(e => e.crossed)
    console.log(`\nGÉPEK KÖZÖTT (relay: ${RELAY_URL})`)
    for (const [m, ps] of Object.entries(MACHINES)) line(m, ps.join(", "))
    line("átért a másik gépre", `${crossed.length}/${all.length}`)
    for (const e of all.filter(e => !e.crossed))
      line(`  nem ért át`, `${e.ts.slice(11, 19)} ${e.from} ${e.type}`)
  }

  let focus = {}
  for (const s of stores()) focus = { ...focus, ...readJson(join(s, "focus.json")) }
  focus = Object.fromEntries(Object.entries(focus).map(([k, v]) => [local(k), v]))
  const declared = roster.filter(s => focus[s])
  console.log(`\nFÓKUSZ (${declared.length}/${roster.length} seat mondta ki)`)
  for (const s of declared) line(s, `${focus[s].text.slice(0, 70)}  [${(focus[s].files || []).join(", ").slice(0, 60)}]`)
  for (const s of roster.filter(s => !focus[s])) line(s, "— nem mondta ki")

  console.log(`\nKÖLTSÉG  $${spent.toFixed(4)}\n`)
}
const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : "—"

// ── the scenario ──────────────────────────────────────────────────────────────
console.log(`▶ ${S.name} — ${Object.keys(S.projects).length} projekt, ` +
  `${Object.values(S.projects).flat().length} ülés, modell: ${MODEL}`)

// Round zero: every seat introduces itself. This is also what CREATES the seats — a project with
// two of them is two sessions in one directory, which is the case the whole seat mechanism exists
// for and the one most likely to go wrong.
// The intros stay one at a time: this is the step that CREATES the seats, and a seat that failed to
// be created would take every later round down with it — setup should not also be a race test.
for (const [project, roles] of Object.entries(S.projects)) {
  for (const [i, role] of roles.entries()) {
    const r = await turn(`${project}/${i}`, S.intro.replace("{{ROLE}}", role).replace("{{PROJECT}}", project))
    console.log(`  · ${project}/${i}  seat=${r.session?.slice(0, 8) || "?"}  ${r.error ? "HIBA: " + r.error : ""}`)
  }
}

for (const [n, round] of (S.rounds || []).entries()) {
  const steps = round.parallel || [round]
  console.log(`\n▶ ${n + 1}. kör — ${round.title || steps.map(s => s.seat).join(", ")}`)
  const results = await Promise.all(steps.map(s => turn(s.seat, s.prompt)))
  for (const r of results)
    console.log(`  · ${r.key}: ${r.error ? "HIBA: " + r.error : r.text.replace(/\s+/g, " ").slice(0, 160)}`)
}

await report()
for (const d of stores()) if (existsSync(d)) console.log(`(a busz állapota: ${d})`)

// ⚠ EXIT EXPLICITLY. A spawned relay is a live child handle, and a live child handle keeps node's
// event loop referenced — so the harness printed its whole report and then sat there forever, and
// anything running it with `spawnSync` (its own smoke test, for one) waited with it. Measured: a
// run that had finished in 40 seconds looked like a hang until the relay was killed by hand.
relay?.kill()
process.exit(0)
