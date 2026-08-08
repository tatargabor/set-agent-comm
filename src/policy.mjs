/**
 * THE POLICY EVALUATOR — build order step 2 of `docs/cross-project-requests.md`.
 *
 * One question, asked by the receiving project about an incoming entry: *what happens to this?*
 * Four answers — `serve` (code answers it, no model, no wake-up), `gate` (a cheap gatekeeper
 * decides), `wake` (today's behaviour: a human-led session is interrupted), `deny` (an answer
 * saying no, and why).
 *
 * ⚠ IT IS A PURE FUNCTION, and that is not tidiness. Everything interesting here is adversarial —
 * an expired grant, a path-traversal ask, a device token borrowed to impersonate a project — and
 * an adversarial case is only worth writing if it can be run without a relay, a second machine and
 * a clock. Reading the file is `readPolicy`, below, and it is the only thing here that touches
 * disk.
 *
 * ⚠ WHICH WAY EACH LAYER FAILS, because the two rules look contradictory and are not:
 *   data release fails CLOSED — no match, unreadable file, parse error: nothing is served;
 *   attention fails OPEN     — the same failure falls through to `wake`, so a person sees it.
 * In one sentence: a broken policy costs a turn, never a leak.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Where the policy lives. Tracked, in the RECEIVING project — so it may hold nothing machine-specific. */
export const POLICY_PATH = join(".claude", "agent-comm.policy.json")

/** The 90-day ceiling from *Grants*. Exported so a test states the number rather than reproducing it. */
export const ROTATE_DAYS = 90

const DAY = 86_400_000

/**
 * READ IT FRESH, EVERY TIME. Not a performance oversight: this project has already been bitten by
 * long-running processes holding stale code (README, *After an update, restart what polls*), and a
 * permission change that needs a restart to take effect is one that will be wrong at the moment it
 * matters — which, for a permission, is the only moment there is.
 *
 * A missing file and a broken file are DIFFERENT and both are reported, because they mean opposite
 * things about intent: "never opted in" versus "opted in and I have just broken it". Both evaluate
 * to `wake`; only the second is worth telling somebody about.
 */
export function readPolicy(projectDir) {
  let raw
  try { raw = readFileSync(join(projectDir, POLICY_PATH), "utf8") }
  catch { return { policy: null, missing: true } }
  try { return { policy: JSON.parse(raw) } }
  catch (e) { return { policy: null, error: e.message } }
}

/**
 * IS THIS ASK KEY SAFE TO MATCH AGAINST ANYTHING?
 *
 * A key arrives from the network and ends up selecting a rule, and a rule carries `run` — a script
 * path. `status:*` matching `status:../../../etc/shadow` is the whole attack, and it is not
 * hypothetical in this codebase: `assertSafeWriter`/`assertSafeTs` exist because names from the
 * network became file names once already.
 *
 * ⚠ An unsafe key matches NOTHING — not a rule, not a grant, not even `*`. It therefore falls
 * through to the default, which is `wake`: never served (data fails closed), and a person still
 * sees that somebody sent something malformed (attention fails open). Rejecting it into a `deny`
 * would have been the tidier-looking choice and the wrong one — a denial is an answer, and
 * answering a probe confirms the probe.
 */
export function safeKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 200 &&
    /^[A-Za-z0-9_.:*-]+$/.test(key) && !key.split(":").includes("..")
}

/**
 * Does a pattern cover a key? Exact, or a single trailing `*` after a `:` (`status:*`), or the
 * bare `*` catch-all. Deliberately not a glob: every extra wildcard form is another way for a
 * rule to reach further than the person who wrote it believed.
 */
export function keyMatches(pattern, key) {
  // ⚠ ABSENT AND UNSAFE ARE NOT THE SAME KEY, and collapsing them was a real bug in this file's
  // first draft. A request with no `ask` at all is FREE TEXT — the common case, and the reason the
  // catch-all exists ("both a declared catalogue and free text through the gatekeeper") — so it
  // matches `*` and nothing narrower. A key that was supplied and is unsafe matches nothing at all,
  // `*` included.
  if (key === undefined || key === null || key === "") return pattern === "*"
  if (!safeKey(key)) return false
  if (pattern === "*") return true
  if (pattern === key) return true
  if (pattern.endsWith(":*")) return key.startsWith(pattern.slice(0, -1)) && key.length > pattern.length - 1
  return false
}

/**
 * THE NAMES A GRANT MAY BE WRITTEN AGAINST TO REACH THIS REQUESTER — and the one-line rule that
 * keeps a borrowed device token from becoming every grant ever issued to a project name.
 *
 * ⚠ The relay authenticates the DEVICE half of a name and nothing else (`src/relay.mjs`, `nsOf`):
 * it drops an entry whose namespace does not match the token's, and the project half is whatever
 * the poster typed. So any process holding any valid device token for a shared room can post as
 * `consumer-b@that-device#0001`. Hence:
 *
 *   a grant written against a BARE PROJECT NAME matches local writers only.
 *
 * Anything arriving `via: "bus-relay"` must be granted on the full `project@device`. This is the
 * row the copilot wrote on their own side — *"név@gép#seat csak annyit ér, amennyit a device
 * token"* — and the request record as first drafted destroyed the distinction it depends on.
 */
export function granteeNames(request) {
  const { who, project, device, via } = request
  const names = [who]                                     // the seat as written, always exact
  if (via === "bus-relay") { if (project && device) names.push(`${project}@${device}`) }
  else if (project) names.push(project)
  return names.filter(Boolean)
}

/**
 * THE EFFECTIVE EXPIRY of one grant: the tracked ceiling, and what use has rotated it to.
 *
 * ⚠ `min`, always — it can only ever SHORTEN. `docs/cross-project-requests.md` can be read two
 * ways on this ("until is required, capped at 90 days" versus "the tracked file says this grant may
 * live at most until 2026-11-01"), and the two readings only coincide when `until` is itself within
 * 90 days of the grant. Taking the minimum is the one behaviour that is correct under both, and it
 * is the fail-closed direction. ⚠ WHICH READING IS MEANT IS AN OPEN QUESTION FOR GÁBOR — see the
 * note added to the plan; do not resolve it by reading this code, which deliberately does not.
 *
 * `lastUse` is a HUMAN's last use, and the caller is responsible for that: machine traffic keeps a
 * grant usable, a person's use keeps it alive. Where `human` cannot be derived — every remote
 * requester — the caller passes nothing and the grant runs to its ceiling. Rotating on a signal we
 * do not have would rebuild the permanent permission the expiry exists to prevent, wearing a fresh
 * date.
 *
 * ⚠ `granted` IS NOT A DATE and is never parsed as one. The plan's own example writes it
 * `"2026-08-08, Gábor"` — a provenance line, why this grant exists, for the human reading the
 * diff. An earlier version of this function used it as the rotation origin, which is the kind of
 * quiet field-overloading that works until somebody writes "last week, over lunch" in it. With no
 * recorded use there is nothing to rotate from, so the grant simply runs to its tracked `until`.
 */
export function effectiveUntil(grant, lastUse) {
  const ceiling = Date.parse(grant.until)
  if (Number.isNaN(ceiling)) return null                  // an unparseable `until` is not an expiry
  const from = Date.parse(lastUse || "")
  return Number.isNaN(from) ? ceiling : Math.min(ceiling, from + ROTATE_DAYS * DAY)
}

/** A grant's identity in the runtime store. Stable across edits that do not change who-gets-what. */
export const grantKey = g => `${g.who}::${(Array.isArray(g.keys) ? g.keys : []).join(",")}`

const rev = (verdict, reason, extra = {}) => ({ verdict, reason, ...extra })

/**
 * EVALUATE ONE REQUEST.
 *
 *   evaluate({ request, policy, now, lastUse })
 *     request  the record from *The request record* — { who, project, device, via, ask, … }
 *     policy   the PARSED policy object, or null for "no policy file"
 *     now      Date or ms, injected so an expiry test does not depend on the wall clock
 *     lastUse  { [grantKey]: isoDate } — a human's last use, from the untracked runtime store
 *
 * Returns { verdict, reason, key, grant, rule } — `reason` is always populated, because `deny` is
 * never silence and the other three are worth being able to explain too.
 */
export function evaluate({ request = {}, policy = null, now = Date.now(), lastUse = {} } = {}) {
  const t = now instanceof Date ? now.getTime() : now
  const key = request.ask

  // NO POLICY FILE → EVERYTHING WAKES. A project that never opts in behaves exactly as it does
  // today and loses nothing; the feature is strictly additive. It is also the honest default for
  // "what do you give out automatically": a project that has not said, gives out nothing.
  if (!policy || typeof policy !== "object") return rev("wake", "no policy — this project has not opted in", { key })

  const rules = policy.rules && typeof policy.rules === "object" ? policy.rules : {}
  const grants = Array.isArray(policy.grants) ? policy.grants : []

  // Which grants are written against a name that reaches THIS requester (see `granteeNames`), and
  // of those, which cover the key that was asked. `who` is never a wildcard — a grant that applied
  // to everyone would not be a grant.
  const names = granteeNames(request)
  const mine = grants.filter(g => g && typeof g.who === "string" && g.who !== "*" && names.includes(g.who))
  const covering = mine.filter(g => (Array.isArray(g.keys) ? g.keys : []).some(p => keyMatches(p, key)))

  // AN EXPIRED GRANT IS A `deny` WITH A REASON, never a silent fall-through to `wake`. "Your access
  // to status:* expired on 2026-11-01" is something the far end can act on; a sudden wake-up where
  // there used to be an answer is a mystery at both ends. So this is decided BEFORE the rules: a
  // requester who had access and lost it is told that, not quietly handed to a human.
  //
  // ⚠ A grant whose `until` cannot be read is NOT live. `until` is required, and treating an
  // unparseable one as "no expiry, therefore fine" was this file's second first-draft bug: it is
  // the broken-policy case, and the broken-policy case may not release data. It is reported apart
  // from expiry because the two say different things to the person who has to fix it.
  const dated = covering.map(g => ({ g, until: effectiveUntil(g, lastUse[grantKey(g)]) }))
  const live = dated.filter(d => d.until !== null && d.until >= t)
  if (covering.length && !live.length) {
    const expired = dated.filter(d => d.until !== null).sort((a, b) => b.until - a.until)[0]
    return expired
      ? rev("deny", `your grant for "${key}" expired on ${new Date(expired.until).toISOString().slice(0, 10)}`,
        { key, expired: true })
      : rev("deny", `the grant covering "${key}" has no readable \`until\` — nothing is served on a broken grant`,
        { key, broken: true })
  }

  // The rule: exact key first, then a wildcard tail, then the catch-all. Longest pattern wins among
  // wildcards, so `status:db:*` beats `status:*` — otherwise the order of keys in a JSON object
  // would decide a permission, and that is not something anyone reviewing the file can see.
  const pattern = Object.keys(rules)
    .filter(p => keyMatches(p, key))
    .sort((a, b) => (a === key ? -1 : b === key ? 1 : b.length - a.length))[0]
  const rule = pattern ? rules[pattern] : null
  const verdict = rule && typeof rule.verdict === "string" ? rule.verdict : null

  // ⚠ BOTH HALVES ARE EVALUATED AND `deny` WINS. The rule describes a capability, the grant confers
  // it — a key with a `serve` rule and no matching grant is denied. Reversing that once, for
  // convenience, turns the whole file into documentation.
  //
  // Note what is NOT gated: `wake` and `gate` need no grant. Grants gate DATA RELEASE, not
  // attention. If a grant were needed to wake a human, then adding a policy file would silently
  // take away a stranger's ability to reach this project at all — the opposite of "strictly
  // additive", and it would make the honest default (`"*": wake`) a lie.
  if (verdict === "serve") {
    if (!live.length) return rev("deny", `no grant reaches "${key}" for ${request.who}`, { key, rule: pattern })
    const { g, until } = live[0]
    return rev("serve", `granted to ${g.who} until ${new Date(until).toISOString().slice(0, 10)}`,
      { key, rule: pattern, run: rule.run, view: g.view, grant: g })
  }
  if (verdict === "deny") return rev("deny", rule.reason || `"${key}" is refused by policy`, { key, rule: pattern })
  if (verdict === "gate") return rev("gate", `"${key || "free text"}" goes to the gatekeeper`, { key, rule: pattern })
  if (verdict === "wake") return rev("wake", `"${key || "free text"}" is for a person`, { key, rule: pattern })

  // No rule matched, or one matched with a verdict nobody defined. Both are the broken-policy case,
  // and it costs a turn rather than leaking: nothing is served, a person sees it.
  return rev("wake", pattern
    ? `rule "${pattern}" has no usable verdict — falling back to a person`
    : `nothing in the policy covers "${key ?? "an ask-less request"}"`, { key })
}

/**
 * THE CATALOGUE, FILTERED BY THE SAME GRANTS. `ask: "capabilities"` is the discovery question, and
 * the list is not public just because it is a list: a project's capability list says what it does
 * all day, and handing the same 43 lines to every caller is a release nobody authorised.
 *
 * One evaluator, one place to be wrong — so this asks `evaluate` about every key rather than
 * re-deriving who may see what. The answer to "what may I ask you" can then never exceed the
 * answer to "what will you give me". A caller with no grant gets zero entries, which is the honest
 * statement that there is nothing here for it.
 */
export function catalogue({ request = {}, policy = null, now = Date.now(), lastUse = {} } = {}) {
  const keys = Object.keys(policy?.capabilities || {})
  return keys.filter(k => {
    const r = evaluate({ request: { ...request, ask: k }, policy, now, lastUse })
    return r.verdict === "serve"
  }).map(k => ({ key: k, what: policy.capabilities[k] }))
}
