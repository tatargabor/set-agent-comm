// THE POLICY EVALUATOR — build order step 2. Almost every case here is adversarial, which is why
// the thing under test is a pure function: an expired grant, a path-traversal ask and a borrowed
// device token are all cheap to state and impossible to arrange with a real relay and a real clock.
//
// The four cases the plan named as the point of this step are marked ⚠ below.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluate, catalogue, readPolicy, effectiveUntil, keyMatches, safeKey, ROTATE_DAYS, POLICY_PATH }
  from "../src/policy.mjs"

const NOW = Date.parse("2026-08-08T12:00:00Z")
const DAY = 86_400_000
// A local requester and a remote one, identical in every way that is not evidence.
const LOCAL = { who: "consumer-b#4289030d", project: "consumer-b", via: "bus-local", human: false }
const REMOTE = { who: "consumer-b@mac-mini#4289030d", project: "consumer-b", device: "mac-mini", via: "bus-relay" }
const grant = (over = {}) => ({ who: "consumer-b", keys: ["capabilities", "status:*"], until: "2026-11-01", ...over })
const POLICY = (over = {}) => ({
  rules: { capabilities: { verdict: "serve", run: "scripts/kepessegek.mjs" },
           "status:*": { verdict: "serve", run: "scripts/status.mjs" },
           "*": { verdict: "wake" } },
  grants: [grant()],
  ...over,
})
const ask = (request, key, over = {}) =>
  evaluate({ request: { ...request, ask: key }, policy: POLICY(over), now: NOW, ...over.ctx })

// ── the default, and why it has to be this one ────────────────────────────────

test("no policy file at all — everything wakes, exactly as today", () => {
  // The feature has to be strictly additive: a project that never opts in must lose nothing, or
  // installing this becomes a decision every project on the bus is forced to make.
  const r = evaluate({ request: { ...LOCAL, ask: "capabilities" }, policy: null, now: NOW })
  assert.equal(r.verdict, "wake")
  assert.match(r.reason, /has not opted in/)
})

test("a policy that will not parse costs a TURN, never a leak", () => {
  const dir = mkdtempSync(join(tmpdir(), "sac-policy-"))
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(join(dir, POLICY_PATH), "{ this is not json")
    const { policy, error } = readPolicy(dir)
    assert.ok(error, "a broken policy was not distinguished from a missing one")
    assert.equal(evaluate({ request: { ...LOCAL, ask: "capabilities" }, policy, now: NOW }).verdict, "wake",
      "a broken policy served something — data release must fail closed")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a missing policy and a broken one are told apart", () => {
  // They mean opposite things about intent — "never opted in" versus "opted in and just broke it" —
  // and only the second is worth telling somebody about. Both still evaluate to `wake`.
  const dir = mkdtempSync(join(tmpdir(), "sac-policy-"))
  try { assert.equal(readPolicy(dir).missing, true) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── the grant confers, the rule only describes ────────────────────────────────

test("a `serve` rule with a matching grant is served", () => {
  const r = ask(LOCAL, "capabilities")
  assert.equal(r.verdict, "serve")
  assert.equal(r.run, "scripts/kepessegek.mjs", "the verdict does not carry what to run")
})

test("⚠ a `serve` rule with NO grant is DENIED, not woken", () => {
  // Both halves are evaluated and deny wins. The rule describes a capability, the grant confers it;
  // reversing that once for convenience turns the whole file into documentation.
  const r = ask({ ...LOCAL, who: "stranger#1", project: "stranger" }, "capabilities")
  assert.equal(r.verdict, "deny", "an ungranted project was served, or quietly handed to a human")
  assert.match(r.reason, /no grant reaches/)
})

test("`wake` and `gate` need no grant — grants gate DATA, not ATTENTION", () => {
  // If a grant were needed to wake somebody, adding a policy file would silently cut a stranger off
  // from the project entirely, which is the opposite of additive and makes `"*": wake` a lie.
  const r = ask({ ...LOCAL, who: "stranger#1", project: "stranger" }, "something-unlisted")
  assert.equal(r.verdict, "wake", "a stranger could no longer reach a person by asking")
})

test("free text — no `ask` at all — is the catch-all's job, not an error", () => {
  const gated = evaluate({ request: LOCAL, policy: POLICY({ rules: { "*": { verdict: "gate" } } }), now: NOW })
  assert.equal(gated.verdict, "gate", "a request with no ask key fell through the catch-all")
})

// ── expiry ────────────────────────────────────────────────────────────────────

test("⚠ an expired grant is a REASONED DENY, never a fall-through to wake", () => {
  // "Your access expired on the 1st" is something the far end can act on. A sudden wake-up where
  // there used to be an answer is a mystery at both ends.
  const r = ask(LOCAL, "capabilities", { grants: [grant({ until: "2026-08-01" })] })
  assert.equal(r.verdict, "deny")
  assert.equal(r.expired, true)
  assert.match(r.reason, /expired on 2026-08-01/, `the denial does not say when: ${r.reason}`)
})

test("a grant whose `until` cannot be read serves NOTHING — broken is not unlimited", () => {
  const r = ask(LOCAL, "capabilities", { grants: [grant({ until: "whenever" })] })
  assert.equal(r.verdict, "deny", "an unparseable expiry was read as 'no expiry, therefore fine'")
  assert.equal(r.broken, true, "it was reported as an expiry, which sends the reader to fix the wrong thing")
})

test("a grant with no `until` at all is broken too — `until` is required", () => {
  const r = ask(LOCAL, "capabilities", { grants: [{ who: "consumer-b", keys: ["capabilities"] }] })
  assert.equal(r.verdict, "deny")
})

test("use rotates the expiry, and can only ever SHORTEN it", () => {
  const g = grant({ until: "2026-12-31" })
  // A person used it yesterday: good for another 90 days…
  assert.equal(effectiveUntil(g, "2026-08-07T12:00:00Z"), Date.parse("2026-08-07T12:00:00Z") + ROTATE_DAYS * DAY)
  // …and use cannot push it past what the tracked file allows, or the review becomes advisory.
  assert.equal(effectiveUntil(grant({ until: "2026-08-20" }), "2026-08-07T12:00:00Z"), Date.parse("2026-08-20"))
  // With nothing recorded, it runs to its ceiling — there is no origin to rotate from.
  // ⚠ This is the half of *Grants* that is genuinely ambiguous and is flagged as an open question
  // rather than settled here; see the note in `effectiveUntil` and in the plan.
  assert.equal(effectiveUntil(g, null), Date.parse("2026-12-31"))
})

test("`granted` is a provenance line, not a date — it is never parsed", () => {
  // The plan writes it "2026-08-08, Gábor". A version of this code read a rotation origin out of
  // it, which works right up until somebody writes "last week, over lunch".
  const g = grant({ until: "2026-12-31", granted: "2026-01-01, Gábor" })
  assert.equal(effectiveUntil(g, null), Date.parse("2026-12-31"),
    "a prose field was mined for a date, and it shortened a live grant")
})

// ── who a grant reaches: the borrowed device token ────────────────────────────

test("⚠ a remote `who` does NOT match a bare project-name grant", () => {
  // The relay authenticates the DEVICE half of a name and nothing else, and the project half is
  // whatever the poster typed. Without this rule one device token becomes every grant ever issued
  // to that project name.
  const r = ask(REMOTE, "capabilities")
  assert.equal(r.verdict, "deny", "a device token was accepted as proof of which PROJECT is asking")
})

test("…and the same request IS served on a grant written against project@device", () => {
  const r = ask(REMOTE, "capabilities", { grants: [grant({ who: "consumer-b@mac-mini" })] })
  assert.equal(r.verdict, "serve")
})

test("a grant for one machine confers nothing on another", () => {
  const r = ask({ ...REMOTE, who: "consumer-b@other-box#1", device: "other-box" }, "capabilities",
    { grants: [grant({ who: "consumer-b@mac-mini" })] })
  assert.equal(r.verdict, "deny")
})

test("a grant may name one seat, and then reaches only that seat", () => {
  const g = { who: "consumer-b#4289030d", keys: ["capabilities"], until: "2026-11-01" }
  assert.equal(ask(LOCAL, "capabilities", { grants: [g] }).verdict, "serve")
  assert.equal(ask({ ...LOCAL, who: "consumer-b#other" }, "capabilities", { grants: [g] }).verdict, "deny")
})

test("a wildcard grantee is not a grant — `who: \"*\"` reaches nobody", () => {
  const r = ask(LOCAL, "capabilities", { grants: [grant({ who: "*" })] })
  assert.equal(r.verdict, "deny", "a grant applying to everyone was honoured")
})

// ── the ask key itself, which arrives from the network ────────────────────────

test("⚠ the wildcard tail REJECTS a path-traversal ask", () => {
  // `status:*` must not match `status:../../..`. A rule carries `run` — a script path — so a key
  // that walks out of its namespace is the whole attack, and names from the network have become
  // file names in this codebase once already.
  assert.equal(keyMatches("status:*", "status:../../.."), false)
  const r = ask(LOCAL, "status:../../..")
  assert.notEqual(r.verdict, "serve", "a traversal ask was SERVED")
  assert.equal(r.verdict, "wake", "it was answered — a denial confirms the probe; it should just reach a person")
})

test("an unsafe key matches nothing at all, `*` included", () => {
  for (const bad of ["a/b", "a\\b", "..", "status:..", "x y", "élet", "a".repeat(201)])
    assert.equal(keyMatches("*", bad), false, `"${bad}" matched the catch-all`)
  assert.equal(safeKey("status:db-1.2_x"), true, "a perfectly ordinary key was rejected")
})

test("the longest matching wildcard wins, so key order in the file decides nothing", () => {
  // Otherwise a permission would depend on the order of keys in a JSON object, which is not
  // something a person reviewing the diff can see.
  const rules = { "status:*": { verdict: "wake" }, "status:db:*": { verdict: "serve", run: "s.mjs" }, "*": { verdict: "wake" } }
  const r = evaluate({ request: { ...LOCAL, ask: "status:db:size" }, now: NOW,
    policy: { rules, grants: [grant({ keys: ["status:db:*"] })] } })
  assert.equal(r.verdict, "serve")
  assert.equal(r.rule, "status:db:*")
})

// ── the catalogue is filtered by the same grants ──────────────────────────────

test("the catalogue never exceeds what the grants would actually give", () => {
  // A project's capability list says what it does all day. One evaluator, one place to be wrong.
  const policy = POLICY({ capabilities: { capabilities: "what may I ask", "status:db": "db health", secret: "internal" },
    grants: [grant({ keys: ["capabilities"] })] })
  const seen = catalogue({ request: LOCAL, policy, now: NOW }).map(c => c.key)
  assert.deepEqual(seen, ["capabilities"], `the catalogue leaked: ${seen.join(", ")}`)
})

test("a caller with no grant gets an EMPTY catalogue, not the list", () => {
  const policy = POLICY({ capabilities: { capabilities: "what may I ask", secret: "internal" }, grants: [] })
  assert.deepEqual(catalogue({ request: LOCAL, policy, now: NOW }), [])
})
