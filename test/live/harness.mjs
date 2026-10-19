// LIVE harness — real `claude -p` sessions on a throwaway bus. Spends real usage; never in `npm test`.
//
// A plain `claude -p` answers once and exits, so it never sits IDLE — and idle is the state the
// doorbell exists for. Each session here is therefore kept alive on stream-json input: it answers
// its first prompt, then waits, exactly like a window at the prompt. Its inbox socket is a path we
// choose (`--messaging-socket-path`), its hooks and MCP server are this checkout's, and nothing of
// the person's own setup leaks in: `--setting-sources project` (the throwaway project has none),
// `--strict-mcp-config`. Measured with exactly this setup on 2026-10-19 (docs/native-messaging.md).
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const MODEL = process.env.LIVE_MODEL || "haiku"

export function bus() {
  const root = mkdtempSync(join(tmpdir(), "sac-live-"))
  const socks = join(root, "socks"); mkdirSync(socks, { mode: 0o700 })
  return { root, socks, roster: join(root, "fleet-roster.json"), sessions: [] }
}

/**
 * Start one session in project `name`. `mode` is the permission mode it runs in; the agent-comm
 * tools are pre-allowed so a default-mode session can use them without a prompt nobody answers.
 */
export function session(b, name, { mode = "default", room = "team", label = null } = {}) {
  const dir = join(b.root, "projects", name); mkdirSync(dir, { recursive: true })
  const socket = join(b.socks, `${name}.sock`)
  const env = `SET_AGENT_COMM_DIR=${b.root} SET_AGENT_ROOM=${room} SET_AGENT_NAME=${name} SET_AGENT_FLEET_ROSTER=${b.roster} SET_AGENT_TRIAGE=off`
  const hook = script => `${env} ${process.execPath} ${join(REPO, "hooks", script)}`
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: hook("session-start.mjs") }] }],
      Stop: [{ hooks: [{ type: "command", command: hook("stop.mjs") }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: hook("heartbeat.mjs") }] }],
      PreToolUse: [{ matcher: "Monitor", hooks: [{ type: "command", command: hook("watch-guard.mjs") }] }],
    },
  }
  const mcp = { mcpServers: { "agent-comm": { command: process.execPath, args: [join(REPO, "src", "stdio.mjs")],
    env: { SET_AGENT_COMM_DIR: b.root, SET_AGENT_ROOM: room, SET_AGENT_NAME: name, SET_AGENT_FLEET_ROSTER: b.roster,
           SET_AGENT_TRIAGE: "off" } } } }
  const modeArgs = mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode]
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", MODEL, "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
    "--settings", JSON.stringify(settings), "--messaging-socket-path", socket,
    "--allowedTools", "mcp__agent-comm__send,mcp__agent-comm__inbox,mcp__agent-comm__alias,mcp__agent-comm__agents,mcp__agent-comm__history,mcp__agent-comm__rooms,mcp__agent-comm__focus",
    ...modeArgs]
  const childEnv = { ...process.env }
  for (const k of ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID",
                   "SET_AGENT_COMM_DIR", "SET_AGENT_ROOM", "SET_AGENT_NAME", "SET_AGENT_OWNER_PID"]) delete childEnv[k]
  const child = spawn("claude", args, { cwd: dir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] })
  const s = { name, dir, socket, child, events: [], results: 0, sessionId: null, label, waiters: [], stderr: "" }
  let buf = ""
  child.stdout.on("data", d => {
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let e; try { e = JSON.parse(line) } catch { continue }
      s.events.push(e)
      if (e.session_id && !s.sessionId) {
        s.sessionId = e.session_id
        if (label) fleet(b, s)
      }
      if (e.type === "result") s.results++
      for (const w of [...s.waiters]) if (w.test()) { s.waiters.splice(s.waiters.indexOf(w), 1); w.resolve() }
    }
  })
  child.stderr.on("data", d => { s.stderr += d })
  b.sessions.push(s)
  return s
}

/** Write the session's Fleet label into the throwaway roster, the way set-core's Fleet would. */
function fleet(b, s) {
  const d = existsSync(b.roster) ? JSON.parse(readFileSync(b.roster, "utf8")) : { version: 1, projects: {} }
  ;(d.projects[s.name] ||= {})[s.sessionId] = { session_id: s.sessionId, label: s.label, project: s.name, cwd: s.dir,
    kind: "interactive", first_seen: Date.now() / 1000, last_seen: Date.now() / 1000 }
  writeFileSync(b.roster, JSON.stringify(d))
}

export function say(s, text) {
  s.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n")
}

/** Resolve when `test()` holds, or reject after `ms` with what the session did meanwhile. */
export function until(s, test, ms, what) {
  if (test()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const w = { test, resolve }
    s.waiters.push(w)
    setTimeout(() => {
      const i = s.waiters.indexOf(w)
      if (i === -1) return
      s.waiters.splice(i, 1)
      reject(new Error(`${s.name}: timed out after ${ms / 1000}s waiting for ${what}. Last events: ` +
        s.events.slice(-4).map(e => JSON.stringify(e).slice(0, 300)).join(" | ") + (s.stderr ? ` stderr: ${s.stderr.slice(-400)}` : "")))
    }, ms)
  })
}
export const results = (s, n, ms = 120_000) => until(s, () => s.results >= n, ms, `${n} result(s)`)

/** Tool calls the session made, by name suffix. */
export const toolCalls = (s, suffix) => s.events.filter(e => e.type === "assistant")
  .flatMap(e => e.message?.content || []).filter(c => c.type === "tool_use" && c.name.endsWith(suffix))

/** All entries on the bus, parsed from the channel files: { from, header, text }. */
export function entries(b, room = "team") {
  const dir = join(b.root, "channels", room)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith(".md")).flatMap(f => {
    const from = f.slice(0, -3)
    return readFileSync(join(dir, f), "utf8").split(/^(?=## )/m).filter(x => x.startsWith("## "))
      .map(x => ({ from, header: x.split("\n")[0], text: x.split("\n").slice(1).join("\n").trim() }))
  })
}

export const seatOf = (b, s) => {
  const reg = JSON.parse(readFileSync(join(b.root, "registry.json"), "utf8"))
  return Object.keys(reg.agents?.[s.name]?.seats || {}).find(w => reg.agents[s.name].seats[w].session === s.sessionId) || null
}

export function stopAll(b) { for (const s of b.sessions) { try { s.child.stdin.end() } catch { } ; setTimeout(() => s.child.kill(), 2000) } }
