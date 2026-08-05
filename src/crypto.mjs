// Crypto for the remote leg: room encryption + stateless tokens. `node:crypto` only — the
// core has no runtime dependencies, and that may not change because a relay is added.
//
// TWO SEPARATE SECRETS, and confusing them would defeat the point:
//
//   RELAY_SECRET  the relay's own key. It signs tokens: "this device may write into this
//                 room". The relay HAS it, so it can verify without storing anything.
//   room key      the AES key of a room. The relay NEVER has it — it travels inside the
//                 invite code, which is handed over out of band (Signal, a phone call).
//                 That is what makes the relay a dumb letterbox: it forwards what it cannot read.
//
// So the relay decides WHO may post, and never learns WHAT was posted.

import { createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto"

const b64 = buf => Buffer.from(buf).toString("base64url")
const unb64 = s => Buffer.from(s, "base64url")

// ── room key ──────────────────────────────────────────────────────────────────

export const newRoomKey = () => b64(randomBytes(32))

/**
 * AES-256-GCM. The nonce is random per message and travels with the ciphertext; the auth tag
 * makes tampering detectable — a relay that flips a byte gets a failed decrypt, not a subtly
 * altered instruction. That matters here: the payload is instructions between agents.
 */
export function encrypt(roomKey, plaintext) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", unb64(roomKey), iv)
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
  return `${b64(iv)}.${b64(body)}.${b64(c.getAuthTag())}`
}

export function decrypt(roomKey, blob) {
  const [iv, body, tag] = String(blob).split(".")
  if (!iv || !body || !tag) throw new Error("malformed ciphertext")
  const d = createDecipheriv("aes-256-gcm", unb64(roomKey), unb64(iv))
  d.setAuthTag(unb64(tag))
  return d.update(unb64(body)) + d.final("utf8")
}

// ── stateless tokens ──────────────────────────────────────────────────────────

const sign = (secret, payload) => b64(createHmac("sha256", secret).update(payload).digest())

const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  // Length must be compared first: `timingSafeEqual` throws on a mismatch instead of returning
  // false, and an exception is as good a signal to an attacker as a fast `false`.
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A token IS its own storage: `{claims}.{hmac}`. The relay verifies with `RELAY_SECRET` and
 * keeps no device table — which is what lets it run on a platform with no disk and no database,
 * and lets someone else run it without operating anything.
 *
 * The price, stated plainly: a token cannot be revoked one by one without state. Rotating
 * `RELAY_SECRET` invalidates ALL of them (everyone re-joins), and that is the documented
 * recovery path. `exp` keeps the blast radius bounded.
 */
export function issue(secret, claims, ttlSeconds) {
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
  return `${payload}.${sign(secret, payload)}`
}

/** @returns the claims, or null — never throws, so a caller cannot forget to catch. */
export function verify(secret, token, now = Date.now()) {
  const [payload, mac] = String(token || "").split(".")
  if (!payload || !mac || !equal(mac, sign(secret, payload))) return null
  try {
    const claims = JSON.parse(unb64(payload))
    return claims.exp * 1000 > now ? claims : null
  } catch { return null }
}

/**
 * The admin token is DERIVED from the relay secret, so operating the relay takes exactly one
 * environment variable. Whoever knows `RELAY_SECRET` can mint invites — that is the same
 * person who deployed the relay, and giving them a second secret to lose buys nothing.
 */
export const adminToken = secret => sign(secret, "set-agent-comm:admin:v1")
