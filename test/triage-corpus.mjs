#!/usr/bin/env node
// LIVE accuracy corpus for the letterbox and the safety net (src/triage.mjs). It spends real
// model calls (~0.0002 USD each lean), so it is NOT part of `npm test`:
//
//   node test/triage-corpus.mjs [runs=2] [lean|default|both]
//
// `default` is the start triage.mjs used before 2026-11-28 (MCP and hooks off, plan mode, the full
// Claude Code system prompt); `lean` is `askArgs` as shipped. Each case is one message the rule
// handed over, with the verdict a careful human gives it. Written from the wake / do-not-wake
// lists in the prompts, which come from measured traffic.
import { spawn } from "node:child_process"
import { prompt, netPrompt, askArgs } from "../src/triage.mjs"

const seat = "web-app#3f9c1a20"
const focus = { text: "moving the invoice export to the new store API", files: ["src/export.mjs", "src/store-api.mjs"] }
const e = (type, text, to = [], from = "api-server#77aa01bc") => ({ type, text, to, from })

const LETTERBOX = [
  [true, e("QUESTION", "web-app: does src/export.mjs still call the old getInvoices(), or did you move it to the store API already?", ["web-app"])],
  [true, e("FACT", "Heads-up: I am about to rewrite src/store-api.mjs in the next 10 minutes — the pagination signature changes.")],
  [true, e("ANSWER", "re your question about the store API: yes, listInvoices() takes a cursor now, not an offset.", ["web-app"])],
  [true, e("REQUEST", "web-app: please add a CSV column 'vatRate' to the invoice export before you merge.", ["web-app"])],
  [false, e("FACT", "Done here — the login page tests are green again. Thanks all.")],
  [false, e("FACT", "Received, well done.")],
  [false, e("QUESTION", "mobile-app: which iOS version do we target for the push notifications?", ["mobile-app"])],
  [false, e("FACT", "Status: the nightly backup ran in 4m12s, nothing changed.")],
]
const NET = [
  [true, e("FACT", "Renamed: store-api's listInvoices() is now fetchInvoices() as of this commit; the old name is removed, every caller must follow.")],
  [true, e("FACT", "I am reverting src/export.mjs to yesterday's version in 2 minutes — anything uncommitted in it will conflict.")],
  [false, e("FACT", "Deployed the docs site, no code change.")],
  [false, e("FACT", "Decision: we will use pnpm in the new mobile repo from next week.")],
  [false, e("FACT", "Weekly summary: 14 PRs merged, 2 open, CI median 6 min.")],
  [false, e("FACT", "mobile-app now builds on Node 24.")],
]

const DEFAULT_ARGS = text => [
  "-p", text, "--model", process.env.SET_AGENT_TRIAGE_MODEL || "claude-haiku-5-5",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--permission-mode", "plan", "--settings", '{"disableAllHooks":true}',
]

const run = args => new Promise(resolve => {
  const c = spawn("claude", [...args, "--output-format", "json"], { stdio: ["ignore", "pipe", "pipe"], cwd: "/" })
  let out = ""
  c.stdout.on("data", d => { out += d })
  c.on("close", () => {
    try {
      const j = JSON.parse(out)
      const m = String(j.result).match(/\{[^{}]*"wake"[^{}]*\}/s)
      const u = j.usage || {}
      resolve({
        wake: m ? JSON.parse(m[0]).wake : null,
        ctx: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        out: u.output_tokens || 0, usd: j.total_cost_usd || 0,
      })
    } catch { resolve({ wake: null, ctx: 0, out: 0, usd: 0 }) }
  })
})

const runs = Number(process.argv[2]) || 2
const which = process.argv[3] || "both"
const variants = { default: DEFAULT_ARGS, lean: askArgs }
for (const [name, build] of Object.entries(variants)) {
  if (which !== "both" && which !== name) continue
  const tally = { right: 0, wrong: 0, none: 0, ctx: 0, out: 0, usd: 0, n: 0 }
  const misses = []
  const jobs = []
  for (let r = 0; r < runs; r++) {
    for (const [want, entry] of LETTERBOX)
      jobs.push([want, "letterbox", entry, prompt({ seat, focus, entry, room: "team", live: [seat] })])
    for (const [want, entry] of NET)
      jobs.push([want, "net", entry, netPrompt({ seat, focus, entry, room: "team" })])
  }
  // A few at a time: the point is the verdict, not a load test.
  for (let i = 0; i < jobs.length; i += 4) {
    const batch = jobs.slice(i, i + 4)
    const got = await Promise.all(batch.map(([, , , text]) => run(build(text))))
    got.forEach((g, k) => {
      const [want, layer, entry] = batch[k]
      tally.n++; tally.ctx += g.ctx; tally.out += g.out; tally.usd += g.usd
      if (g.wake === null) { tally.none++; misses.push(`${layer} no verdict: ${entry.text.slice(0, 60)}`) }
      else if (g.wake === want) tally.right++
      else { tally.wrong++; misses.push(`${layer} said ${g.wake}, want ${want}: ${entry.text.slice(0, 60)}`) }
    })
  }
  console.log(`${name}: right ${tally.right}/${tally.n}, wrong ${tally.wrong}, no verdict ${tally.none}; ` +
    `avg context ${Math.round(tally.ctx / tally.n)} tok, avg output ${Math.round(tally.out / tally.n)} tok, ` +
    `avg ${(tally.usd / tally.n).toFixed(5)} USD/call`)
  for (const m of misses) console.log(`  - ${m}`)
}
