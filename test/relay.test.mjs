// THE REMOTE LEG, measured end to end: two machines on one machine.
//
// Two separate stores (= two machines) and a real relay process in between. Nothing is mocked:
// the entries go over HTTP, encrypted, and the assertions read back the receiving machine's
// file system — the same "measure the result, not the call" rule as the rest of the suite.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const SAC = join(HERE, "..", "bin", "sac.mjs")
const RELAY = join(HERE, "..", "src", "relay.mjs")
const SECRET = "test-secret-not-for-real-use"
const ROOM = "atlas"

// Two machines: two stores, two device names.
const A = mkdtempSync(join(tmpdir(), "sac-machine-a-"))
const B = mkdtempSync(join(tmpdir(), "sac-machine-b-"))
// A third machine, only for the invite-replay case: redeeming an invite REPLACES that
// machine's room config, so doing it on B would silently change B's name mid-suite.
const C = mkdtempSync(join(tmpdir(), "sac-machine-c-"))
const env = (root, device, extra = {}) => ({
  ...process.env, SET_AGENT_COMM_DIR: root, SET_AGENT_DEVICE: device,
  SET_AGENT_NAME: "web-app", CLAUDE_CODE_SESSION_ID: `${device}-session`, ...extra,
})

let relay, port
const run = (root, device, args, timeoutMs = 20_000) => new Promise(resolve => {
  const p = spawn(process.execPath, [SAC, ...args], { env: env(root, device), encoding: "utf8" })
  let out = "", err = ""
  p.stdout.on("data", d => { out += d })
  p.stderr.on("data", d => { err += d })
  // A hung child must fail its own test, not freeze the whole run — a blocking `wait` in the
  // wrong place is exactly the mistake this suite is here to catch.
  const timer = setTimeout(() => { p.kill(); err += `\n[timed out after ${timeoutMs}ms]` }, timeoutMs)
  p.on("exit", code => { clearTimeout(timer); resolve({ code, out, err }) })
})

async function startRelay(p = port, extra = {}) {
  const proc = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PORT: String(p), RELAY_SECRET: SECRET, RELAY_HOST: "127.0.0.1", ...extra },
  })
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", d => { if (String(d).includes("relay on")) resolve() })
    proc.on("exit", c => reject(new Error(`relay exited with ${c}`)))
    setTimeout(() => reject(new Error("relay did not start")), 10_000)
  })
  return proc
}

port = 7590 + (process.pid % 200)
relay = await startRelay()
after(() => {
  relay?.kill()
  rmSync(A, { recursive: true, force: true })
  rmSync(B, { recursive: true, force: true })
  rmSync(C, { recursive: true, force: true })
})

test("HANDSHAKE: an invite carries the room key, and joining yields a device token", async () => {
  const use = await run(A, "desktop", ["relay", "use", `http://127.0.0.1:${port}`, "--secret", SECRET])
  assert.equal(use.code, 0, use.err)

  const inv = await run(A, "desktop", ["invite", ROOM, "--for", "macmini"])
  assert.equal(inv.code, 0, inv.err)
  const code = inv.out.split(/\s+/).find(w => w.startsWith("sac-join:"))
  assert.ok(code, `no invite code in the output: ${inv.out}`)

  // The room key is IN the code and never goes to the relay — that is what keeps the relay
  // unable to read the room, so it has to be verifiable, not just claimed.
  const payload = JSON.parse(Buffer.from(code.slice("sac-join:".length), "base64url"))
  assert.ok(payload.k, "the invite does not carry a room key")
  assert.equal(payload.r, ROOM)

  const joined = await run(B, "macmini", ["join", code])
  assert.equal(joined.code, 0, joined.err)
  assert.match(joined.out, /joined "atlas"/)
  const cfgB = JSON.parse(readFileSync(join(B, "relays.json"), "utf8"))
  assert.equal(cfgB.rooms[ROOM].namespace, "macmini")
  assert.equal(cfgB.rooms[ROOM].roomKey, payload.k, "the two machines do not share a room key")
  assert.ok(!cfgB.relay?.secret, "the joining machine must never receive the relay secret")
})

test("a used invite is refused the second time", async () => {
  const inv = await run(A, "desktop", ["invite", ROOM, "--for", "laptop"])
  const code = inv.out.split(/\s+/).find(w => w.startsWith("sac-join:"))
  assert.equal((await run(C, "laptop", ["join", code])).code, 0)
  const again = await run(C, "laptop", ["join", code])
  assert.notEqual(again.code, 0, "the same invite could be redeemed twice")
  assert.match(again.err, /already used/)
})

test("DELIVERY: a message written on A reaches B's file system", async () => {
  const sent = await run(A, "desktop", ["send", ROOM, "REQUEST", "Do not regenerate the atlas yet."])
  assert.equal(sent.code, 0, sent.err)
  assert.match(sent.out, /"relay": "pushed 1"/, `it was not uploaded: ${sent.out}`)

  const pulled = await run(B, "macmini", ["sync", ROOM])
  assert.equal(pulled.code, 0, pulled.err)
  assert.match(pulled.out, /received 1/, `nothing came down: ${pulled.out}`)

  const inb = await run(B, "macmini", ["inbox", ROOM])
  assert.match(inb.out, /Do not regenerate the atlas yet\./)
  // The sender is named with the machine it came from: the local name is unforgeable, a remote
  // one is only worth its token, and the reader is entitled to see which one it got.
  assert.match(inb.out, /web-app@desktop#/, `the remote sender is not marked: ${inb.out}`)
})

test("the answer comes back — the leg is symmetric", async () => {
  await run(B, "macmini", ["send", ROOM, "ANSWER", "Understood, not touching it."])
  await run(A, "desktop", ["sync", ROOM])
  const inb = await run(A, "desktop", ["inbox", ROOM])
  assert.match(inb.out, /Understood, not touching it\./)
  assert.match(inb.out, /web-app@macmini#/)
})

test("THE RELAY CANNOT READ THE ROOM", async () => {
  // Not a claim in the README — measured. Everything the relay holds is fetched with a device
  // token and searched for the plaintext.
  const cfg = JSON.parse(readFileSync(join(B, "relays.json"), "utf8")).rooms[ROOM]
  const res = await fetch(`http://127.0.0.1:${port}/rooms/${ROOM}/entries?after=0&wait=0`,
    { headers: { authorization: `Bearer ${cfg.token}` } })
  const body = await res.json()
  const raw = JSON.stringify(body)
  assert.ok(raw.length > 100, "nothing came back, so this proves nothing")
  assert.ok(!raw.includes("regenerate"), "the relay is holding readable plaintext")
  assert.ok(!raw.includes("Understood"), "the relay is holding readable plaintext")
})

test("a device may not post under another machine's name", async () => {
  // The token carries the namespace, and the relay enforces it — this is what stands in for
  // the local `cwd` identity across the network, so a forged name has to be rejected.
  const cfg = JSON.parse(readFileSync(join(B, "relays.json"), "utf8")).rooms[ROOM]
  const res = await fetch(`http://127.0.0.1:${port}/rooms/${ROOM}/entries`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ entries: [{ id: "forged", writer: "web-app@desktop#fake", ts: new Date().toISOString(), cipher: "x.y.z" }] }),
  })
  const body = await res.json()
  assert.equal(body.accepted, 0, "a device posted under someone else's namespace")
  assert.equal(body.rejected, 1)
})

test("A RELAY RESTART LOSES NOTHING — the bridge resyncs and duplicates are dropped", async () => {
  // The failure mode of an ephemeral platform (a redeploy, a crash, a moved container). The
  // relay is memory-only by design, so this has to be safe, not merely unlikely.
  const before = (await run(B, "macmini", ["history", ROOM])).out
  relay.kill()
  await new Promise(r => setTimeout(r, 300))

  // A message written while the relay is DOWN must not be lost either: it is on disk already.
  const sent = await run(A, "desktop", ["send", ROOM, "FACT", "written while the relay was down"])
  assert.equal(sent.code, 0)
  assert.match(sent.out, /"relay": "queued \(relay unreachable/, "a dead relay was reported as a successful send")

  relay = await startRelay()
  await run(A, "desktop", ["sync", ROOM])     // notices the new epoch and resyncs
  await run(A, "desktop", ["sync", ROOM])     // …then re-uploads against the fresh epoch
  await run(B, "macmini", ["sync", ROOM])

  const after = (await run(B, "macmini", ["history", ROOM])).out
  assert.match(after, /written while the relay was down/, "the message written during the outage never arrived")
  const count = s => (s.match(/Do not regenerate the atlas yet\./g) || []).length
  assert.equal(count(after), count(before), "the re-upload duplicated an entry that was already there")
})

test("HTTPS is required on the open internet — the token travels on every call", async () => {
  // The device token sits in a header on every request. Over plain http on the public internet
  // anyone on the path reads it once and can post into the room from then on. Refused at
  // CONFIGURATION time: a token already sent in clear cannot be un-sent.
  const { assertSecureUrl } = await import("../src/bridge.mjs")
  assert.throws(() => assertSecureUrl("http://relay.example.com"), /unencrypted/)
  assert.throws(() => assertSecureUrl("http://1.2.3.4:7511"), /unencrypted/)
  assert.equal(assertSecureUrl("https://relay.example.com/"), "https://relay.example.com")
  // …but a link that is already encrypted or closed stays usable, or the LAN and Tailscale
  // setups — the ones we actually test with — would be locked out for no gain.
  assert.equal(assertSecureUrl("http://127.0.0.1:7511"), "http://127.0.0.1:7511")
  assert.equal(assertSecureUrl("http://100.100.212.67:7511"), "http://100.100.212.67:7511")
  assert.equal(assertSecureUrl("http://workstation.local:7511"), "http://workstation.local:7511")
})

test("RATE LIMIT: /join cannot be hammered", async () => {
  // Guessing an invite is hopeless (HMAC-SHA256) — but hopeless at unlimited speed is still a
  // bandwidth bill, and the endpoint is public from the moment it is deployed.
  const strictPort = port + 1
  const strict = await startRelay(strictPort, { RELAY_LIMIT_JOIN: "3" })
  try {
    const codes = []
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${strictPort}/join`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "bogus", device: "attacker" }),
      })
      codes.push(res.status)
    }
    assert.deepEqual(codes, [401, 401, 401, 429, 429],
      `the limit did not bite where it should: ${codes.join(", ")}`)
  } finally { strict.kill() }
})

test("A TOKEN IS BOUND TO ITS ROOM — it cannot reach another one", async () => {
  // The whole point of inviting someone per room: the device token carries the room it was
  // issued for, and the relay refuses everything else. This is what makes it safe to hand a
  // colleague access to ONE collaboration room without opening the others.
  const cfg = JSON.parse(readFileSync(join(B, "relays.json"), "utf8")).rooms[ROOM]
  const other = "someone-elses-room"

  const post = await fetch(`http://127.0.0.1:${port}/rooms/${other}/entries`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ entries: [{ id: "x", writer: "web-app@macmini#1", ts: new Date().toISOString(), cipher: "a.b.c" }] }),
  })
  assert.equal(post.status, 403, "a token wrote into a room it was not issued for")
  assert.match((await post.json()).error, new RegExp(ROOM), "the refusal should name the room the token IS for")

  const read = await fetch(`http://127.0.0.1:${port}/rooms/${other}/entries?after=0&wait=0`,
    { headers: { authorization: `Bearer ${cfg.token}` } })
  assert.equal(read.status, 403, "a token READ a room it was not issued for")
})
