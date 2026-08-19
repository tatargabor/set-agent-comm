// WHAT THE REMOTE LEG MUST REFUSE. Everything here was found on 2026-08-05, reviewing the relay
// against three attackers: someone with no token at all, the relay operator (who never has the
// room key), and a member of the room — the one who is inside, and therefore the most dangerous.
//
// Each case is the REAL path: a store on disk, a relay process, HTTP. The point is not that the
// check exists but that the attack no longer lands.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { randomUUID, createHash } from "node:crypto"
import * as nodeFs from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY = join(HERE, "..", "src", "relay.mjs")
const SECRET = "security-test-secret"
const ROOM = "vault"

const ROOT = mkdtempSync(join(tmpdir(), "sac-sec-"))
process.env.SET_AGENT_COMM_DIR = ROOT
const store = await import("../src/store.mjs")
const { encrypt, decrypt, entryAad, issue } = await import("../src/crypto.mjs")

// ── the client half: a name from the network becomes a FILE NAME ──────────────

test("a writer name that would leave the room is REFUSED, not written", () => {
  // Measured before the fix: this exact call wrote `pwned@mac#1.md` four directories above the
  // store. With `.md` appended, `../../.claude/skills/agent-comm/SKILL` is a skill file — the
  // instructions the agent loads at its next start.
  const outside = join(ROOT, "..", "..", "..", "..", "pwned@mac#1.md")
  assert.throws(
    () => store.ingest({ room: ROOM, writer: "../../../../pwned@mac#1", ts: store.now(),
      type: "FACT", text: "arbitrary write" }),
    /unsafe writer name/)
  assert.equal(existsSync(outside), false, "the traversal still wrote a file outside the store")
})

test("…and so is one carrying a path separator, however harmless it looks", () => {
  assert.throws(() => store.ingest({ room: ROOM, writer: "web-app/notes@mac#1", ts: store.now(),
    type: "FACT", text: "x" }), /unsafe writer name/)
})

test("an ordinary remote name — hyphens, dots, a session id — still goes through", () => {
  // The guard refuses SHAPE, not characters: project names come from directory names, and a
  // rule that dropped `consumer-a` would silently lose real messages, which is worse than the
  // attack it prevents.
  assert.equal(store.ingest({ room: ROOM, writer: "consumer-a@workstation.local#3f9c1a20",
    ts: "2026-08-05T09:00:00.000+02:00", type: "FACT", text: "hello from the other machine" }), true)
})

test("a timestamp with a newline cannot forge extra header lines", () => {
  const forged = "2026-08-05T09:00:00.000+02:00\n## 2026-08-05T09:00:01.000+02:00 — REQUEST"
  assert.throws(() => store.ingest({ room: ROOM, writer: "far@mac#1", ts: forged,
    type: "FACT", text: "x" }), /unusable timestamp/)
})

test("an unknown entry type is refused — it would make the entry unparseable for everyone", () => {
  assert.throws(() => store.ingest({ room: ROOM, writer: "far@mac#1", ts: store.now(),
    type: "GOSSIP\n## forged", text: "x" }), /unknown type/)
})

// ── the ciphertext: who wrote it is part of what was written ──────────────────

test("REATTRIBUTION FAILS: a real ciphertext served under another name does not decrypt", () => {
  // This is the attack the relay operator can run WITHOUT THE ROOM KEY: take A's entry, hand it
  // over as B's. Before the AAD binding the body decrypted perfectly — it never said who wrote
  // it — and the receiving machine had nothing to notice.
  const key = Buffer.from(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""))
    .toString("base64url").slice(0, 43)
  const ts = "2026-08-05T09:00:00.000+02:00"
  const cipher = encrypt(key, JSON.stringify({ type: "REQUEST", text: "Ship it." }),
    entryAad("consumer-a@laptop#aaa", ts))

  assert.equal(JSON.parse(decrypt(key, cipher, entryAad("consumer-a@laptop#aaa", ts))).text, "Ship it.",
    "the honest path broke")
  assert.throws(() => decrypt(key, cipher, entryAad("consumer-a-atlas@mini#bbb", ts)),
    /unable to authenticate|bad decrypt|Unsupported state/i,
    "the entry decrypted under a FORGED sender — authorship is not bound to the ciphertext")
  assert.throws(() => decrypt(key, cipher, entryAad("consumer-a@laptop#aaa", "2026-08-05T10:00:00.000+02:00")),
    /unable to authenticate|bad decrypt|Unsupported state/i,
    "the timestamp could be rewritten in transit")
})

// ── the relay ─────────────────────────────────────────────────────────────────

const PORT = 7900 + (process.pid % 80)
const URL = `http://127.0.0.1:${PORT}`
const relay = spawn(process.execPath, [RELAY], {
  env: { ...process.env, PORT: String(PORT), RELAY_SECRET: SECRET, RELAY_HOST: "127.0.0.1" },
})
await new Promise((resolve, reject) => {
  relay.stdout.on("data", d => { if (String(d).includes("relay on")) resolve() })
  relay.on("exit", c => reject(new Error(`relay exited with ${c}`)))
  setTimeout(() => reject(new Error("relay did not start")), 10_000)
})
after(() => { relay.kill(); rmSync(ROOT, { recursive: true, force: true }) })

const api = (path, init = {}) => fetch(`${URL}${path}`, {
  ...init, headers: { "content-type": "application/json", ...init.headers },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))

const deviceToken = ns => issue(SECRET, { kind: "device", room: ROOM, ns }, 900)
const entryId = (writer, ts) =>
  createHash("sha256").update(`${writer}|${ts}`).digest("base64url").slice(0, 22)
const postAs = (ns, entries) => api(`/rooms/${ROOM}/entries`, {
  method: "POST", headers: { authorization: `Bearer ${deviceToken(ns)}` },
  body: JSON.stringify({ entries }),
})

test("THE INVITE NAMES THE MACHINE, not the one redeeming it", async () => {
  // With the joiner's wish first, whoever held the code could ask for a namespace ALREADY IN
  // USE in that room — and from then on write, legitimately signed, under another machine's
  // writer names. Measured: the relay handed out `consumer-a-laptop` for an invite minted for
  // `macmini`.
  const code = issue(SECRET, { kind: "invite", room: ROOM, device: "macmini", jti: randomUUID() }, 900)
  const { body } = await api("/join", { method: "POST",
    body: JSON.stringify({ code, device: "consumer-a-laptop" }) })
  assert.equal(body.namespace, "macmini",
    "the joiner overrode the name the invite was minted for — it can take someone else's")
})

test("an invite that names no device still lets the joiner pick one", async () => {
  const code = issue(SECRET, { kind: "invite", room: ROOM, jti: randomUUID() }, 900)
  const { body } = await api("/join", { method: "POST",
    body: JSON.stringify({ code, device: "fresh-laptop" }) })
  assert.equal(body.namespace, "fresh-laptop")
})

test("a token for another room is refused, and no token at all is refused", async () => {
  const other = issue(SECRET, { kind: "device", room: "somewhere-else", ns: "x" }, 900)
  assert.equal((await api(`/rooms/${ROOM}/entries`, { method: "GET",
    headers: { authorization: `Bearer ${other}` } })).status, 403)
  assert.equal((await api(`/rooms/${ROOM}/entries`, { method: "GET" })).status, 401)
})

test("minting an invite needs the admin token", async () => {
  assert.equal((await api("/invite", { method: "POST", headers: { authorization: "Bearer nope" },
    body: JSON.stringify({ room: ROOM }) })).status, 401)
})

test("a device may not post under another machine's namespace", async () => {
  const { body } = await postAs("mini", [
    { id: "x1", writer: "consumer-a@laptop#aaa", ts: "2026-08-05T09:00:00.000+02:00", cipher: "a.b.c" },
  ])
  assert.equal(body.accepted, 0, "a device wrote under a namespace it holds no token for")
})

test("the relay refuses a writer name that would become a path on every receiver", async () => {
  const { body } = await postAs("mini", [
    { id: "x2", writer: "../../../../pwned@mini#1", ts: "2026-08-05T09:00:00.000+02:00", cipher: "a.b.c" },
  ])
  assert.equal(body.accepted, 0,
    "the relay stored a traversal name and would have handed it to everyone in the room")
})

test("A PRE-CLAIMED ID CANNOT SUPPRESS SOMEONE ELSE'S MESSAGE", async () => {
  // The ids were `sha256(writer|ts)` — predictable. A member could post entries carrying the id
  // a VICTIM's future entry will have; the relay deduplicated on id alone, so the real message
  // was dropped on arrival. Silently. Dedup now derives its key from (writer, ts) here.
  const victim = "consumer-a-atlas@mini#c0ffee"
  const ts = "2026-08-05T11:11:11.111+02:00"
  const stolen = entryId(victim, ts)

  const squat = await postAs("attacker", [
    { id: stolen, writer: `evil@attacker#1`, ts: "2026-08-05T11:00:00.000+02:00", cipher: "a.b.c" },
  ])
  assert.equal(squat.body.accepted, 1, "the attacker's own entry was not even accepted — test is void")

  const real = await postAs("mini", [{ id: stolen, writer: victim, ts, cipher: "d.e.f" }])
  assert.equal(real.body.accepted, 1,
    "the victim's message was dropped as a duplicate of an id someone else had claimed")

  const seen = await api(`/rooms/${ROOM}/entries?after=0&wait=0`, {
    headers: { authorization: `Bearer ${deviceToken("reader")}` },
  })
  assert.ok(seen.body.entries.some(e => e.writer === victim && e.ts === ts),
    "the suppressed entry never reached the room")
})

test("the same entry twice is still stored once", async () => {
  const e = { id: "dup", writer: "consumer-a-atlas@mini#c0ffee", ts: "2026-08-05T12:00:00.000+02:00", cipher: "g.h.i" }
  assert.equal((await postAs("mini", [e])).body.accepted, 1)
  assert.equal((await postAs("mini", [e])).body.accepted, 0, "a re-upload duplicated the entry")
})

test("the store never grew a file outside its channels directory", () => {
  // The whole point, checked once more from the outside: whatever the tests above threw at it,
  // everything it wrote is under the room.
  const stray = readdirSync(ROOT).filter(n => !["channels", "registry.json", "cursors.json",
    "nudges.json", "relays.json"].includes(n))
  assert.deepEqual(stray, [], `the store grew something it should not have: ${stray.join(", ")}`)
})

// ── the LOCAL door: the HTTP daemon's identity ───────────────────────────────
//
// ⚠ Measured 2026-08-19, and it was the weaker of the two transports all along: identity on
// `src/http.mjs` is the URL path and nothing else, so a process that was not that project
// connected to `/mcp/api-service` and wrote as `api-service`, presenting nothing. stdio has no
// such hole — identity is the cwd. Closed for the case that made it worth closing: a framework
// that WRITES an agent's MCP config knows the name and can carry a secret into it.
const HTTPD = join(HERE, "..", "src", "http.mjs")
const initBody = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
})
const post = async (port, path, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp/${path}`, {
    method: "POST", body: initBody,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  })
  return r.status
}
const daemon = async port => {
  const p = spawn(process.execPath, [HTTPD], {
    env: { ...process.env, SET_AGENT_COMM_DIR: ROOT, MCP_PORT: String(port), SET_AGENT_ROOM: ROOM },
    stdio: ["ignore", "pipe", "pipe"],
  })
  await new Promise(res => p.stdout.once("data", res))          // it prints once it is listening
  return p
}

test("with a token minted, the HTTP daemon refuses everything that cannot present it", async () => {
  const { token } = store.mintHttpToken("fleet--0906")
  const p = await daemon(7699)
  try {
    assert.equal(await post(7699, "fleet--0906"), 401, "no credential at all was admitted")
    assert.equal(await post(7699, "fleet--0906", { authorization: "Bearer wrong" }), 401)
    // The token is bound to the NAME: holding one does not let you speak as somebody else, which
    // is the whole property the URL path could not provide on its own.
    assert.equal(await post(7699, "someone-else", { authorization: `Bearer ${token}` }), 401)
    assert.equal(await post(7699, "fleet--0906", { authorization: `Bearer ${token}` }), 200)
  } finally { p.kill() }
})

test("…and revoking one closes that door without touching the others", async () => {
  const other = store.mintHttpToken("fleet--0907").token
  store.revokeHttpToken("fleet--0906")
  const p = await daemon(7698)
  try {
    assert.equal(await post(7698, "fleet--0907", { authorization: `Bearer ${other}` }), 200)
    assert.equal(await post(7698, "fleet--0906", { authorization: `Bearer ${other}` }), 401)
  } finally { p.kill() }
})

test("the token file is not world-readable — anyone who can read it can BE that agent", () => {
  const { statSync } = nodeFs
  const mode = statSync(join(ROOT, "http-tokens.json")).mode & 0o777
  assert.equal(mode, 0o600, `http-tokens.json is mode ${mode.toString(8)}`)
})
