#!/usr/bin/env node
/**
 * A `claude` that costs nothing — so the HARNESS can be tested without buying six real sessions.
 *
 * It answers the same command line the harness gives the real binary (`-p … --output-format json
 * --resume …`), returns the same JSON shape, and does exactly what the prompt spells out:
 *
 *   @focus <text> [| <file>,<file>]      declare a focus
 *   @send <TYPE> [--to a,b] <text>       write to the room
 *   @inbox                               read (and move the cursor)
 *
 * It is deliberately dumb: it decides nothing. What it is here to prove is that the harness wires
 * up seats, resumes them, and reports on them correctly — never how a model behaves.
 *
 * ⚠ `SET_AGENT_OWNER_PID` is set, and it is not optional. Without it every simulated session walks
 *   its process tree up to the ONE real `claude` running the test and they all land on a single
 *   seat — the window-reconciliation rule working exactly as designed, and quietly destroying the
 *   thing being measured.
 *
 *   It is THIS PROCESS's pid, not something derived from the session id, because that is what the
 *   real binary gives: `claude --resume` is a new process on an unchanged session id, so the owner
 *   changes under a seat whose name must not. Deriving it from the id would make every round look
 *   like one long-lived window and hide the seat sprawl the smoke test is here to catch.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SAC = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sac.mjs")
const argv = process.argv.slice(2)
const val = flag => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] }

const session = val("--resume") || randomUUID()
const prompt = val("-p") || ""
const sac = (...args) => spawnSync(process.execPath, [SAC, ...args], {
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, SET_AGENT_OWNER_PID: String(process.pid) },
  encoding: "utf8",
})

const room = (process.env.SET_AGENT_ROOM || "team").split(",")[0]
const did = []

for (const raw of prompt.split("\n")) {
  const l = raw.trim()
  if (l.startsWith("@focus ")) {
    const [text, files] = l.slice(7).split("|").map(s => s.trim())
    sac("focus", text, ...(files ? ["--files", files] : []))
    did.push("focus")
  } else if (l.startsWith("@send ")) {
    const m = l.slice(6).match(/^(\S+)\s+(?:--to\s+(\S+)\s+)?([\s\S]+)$/)
    if (m) { sac("send", room, m[1], m[3], ...(m[2] ? ["--to", m[2]] : [])); did.push("send") }
  } else if (l === "@inbox") {
    // `sac sync` first, because the MCP `inbox` tool pulls before it reads and this stands in for
    // it. Without that a remote entry is on the relay, not on this machine, and "nothing arrived"
    // would be indistinguishable from "the remote leg is broken".
    sac("sync", room)
    sac("inbox", room)
    did.push("inbox")
  }
}

// register, so the seat exists in the roster even when the turn wrote nothing — a silent seat is
// still a seat, and the report's denominators depend on it being there.
sac("register", room)

process.stdout.write(JSON.stringify({
  type: "result", session_id: session, total_cost_usd: 0,
  result: did.length ? `fake: ${did.join(", ")}` : "fake: nothing to do",
}))
