// LIVE: names and the doorbell, end to end, with real `claude -p` sessions (native-doorbell,
// seat-aliases). Run with `npm run live`; it spends real usage (LIVE_MODEL, default haiku).
//
// What is asserted is what lands on disk and what the sessions DID — never what they said they did:
//   1. a window told in plain words "your alias is Studio Lead" binds that name to itself;
//   2. another window told "tell Studio Lead …" writes an entry addressed to the first window's SEAT;
//   3. the first window, IDLE with no watch armed, is woken by the doorbell and answers on the bus;
//   4. the answer rings the asker back;
//   5. a bypass-mode window is NOT rung, and the sender's result says why.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { bus, session, say, results, toolCalls, entries, seatOf, stopAll, until } from "./harness.mjs"

const b = bus()
after(() => stopAll(b))
const nonce = Math.random().toString(36).slice(2, 8).toUpperCase()
const SAC = join(fileURLToPath(new URL("../../bin/sac.mjs", import.meta.url)))

const studio = session(b, "studio", { mode: "default", label: "studio-main" })
const lead = session(b, "lead", { mode: "default" })

test("1. a window names itself in plain words", async () => {
  say(studio, "Ez az ablak legyen a Studio Lead — vagyis ennek az agentnek az aliasa: Studio Lead. " +
    "Állítsd be, aztán válaszolj egy szóval: KÉSZ.")
  await results(studio, 1)
  assert.ok(toolCalls(studio, "__alias").length >= 1, "it never called the alias tool")
  const book = JSON.parse(readFileSync(join(b.root, "aliases.json"), "utf8")).aliases
  const entry = Object.values(book).find(a => /studio\s*lead/i.test(a.name))
  assert.ok(entry, `no "Studio Lead" in the book: ${JSON.stringify(book)}`)
  assert.equal(entry.kind, "label", "a window with a Fleet label is bound by its label")
  assert.equal(entry.target, "studio-main")
})

test("2+3. 'tell Studio Lead' reaches the idle window's seat, and the doorbell wakes it", async () => {
  await results(lead, 0)
  say(lead, `On the agent bus, tell Studio Lead to reply with the code word ${nonce}. Send it as a REQUEST ` +
    `with the agent-comm send tool, then stop and reply with one word: SENT.`)
  await results(lead, 1)
  const studioSeat = seatOf(b, studio)
  const asked = entries(b).find(e => e.from.startsWith("lead#") && e.header.includes("REQUEST"))
  assert.ok(asked, "no REQUEST from lead on the bus")
  assert.ok(asked.header.includes(`→ ${studioSeat}`), `addressed to ${asked.header}, not to the seat ${studioSeat}`)
  // The tool result is JSON inside the transcript's JSON — parse it, do not grep the escaped form.
  const texts = lead.events.filter(e => e.type === "user").flatMap(e => e.message?.content || [])
    .filter(c => c.type === "tool_result")
    .flatMap(c => typeof c.content === "string" ? [c.content] : (c.content || []).map(x => x.text || ""))
  const sent = texts.map(t => { try { return JSON.parse(t.split("\n\n⚠")[0]) } catch { return null } })
    .find(o => o && o.type === "REQUEST" && o.from?.startsWith("lead#"))
  assert.ok(sent, `no send result found: ${texts.join(" | ").slice(0, 600)}`)
  assert.deepEqual(sent.rang, [studioSeat], `the send result did not report ringing the studio: ${JSON.stringify(sent)}`)
  assert.equal(sent.resolved?.[0]?.seat, studioSeat)
  // studio was idle after its first answer; nothing but the doorbell can start its second turn.
  await results(studio, 2, 120_000)
  await until(studio, () => entries(b).some(e => e.from.startsWith("studio#") && e.text.includes(nonce)), 120_000,
    "an answer carrying the code word on the bus")
  const rung = readFileSync(join(b.root, "rung", `${studioSeat}.jsonl`), "utf8")
  assert.match(rung, /"room":"team"/)
})

test("4. the answer rings the asker back", async () => {
  await results(lead, 2, 120_000)
})

test("5. a bypass-mode window is not rung, and the sender is told why", async () => {
  const bypass = session(b, "gate", { mode: "bypassPermissions" })
  say(bypass, "Reply with one word: READY.")
  await results(bypass, 1)
  const before = bypass.results
  const gateSeat = seatOf(b, bypass)
  // The sender here is the CLI, on purpose: this step is about the receiver, not about a model's wording.
  const r = spawnSync(process.execPath, [SAC, "send", "team", "REQUEST", "are you there?", "--to", gateSeat], {
    encoding: "utf8", env: { ...process.env, SET_AGENT_COMM_DIR: b.root, SET_AGENT_NAME: "operator",
                             CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_MESSAGING_SOCKET: "", SET_AGENT_TRIAGE: "off" } })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.rang, undefined)
  assert.equal(out.notRung?.[0]?.why, "bypass-mode", r.stdout)
  await new Promise(res => setTimeout(res, 20_000))
  assert.equal(bypass.results, before, "a bypass window started a turn it should not have")
  assert.ok(!existsSync(join(b.root, "rung", `${gateSeat}.jsonl`)))
})
