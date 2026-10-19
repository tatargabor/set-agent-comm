## Why

The person running the machine is not on the bus, so nothing can address them. Asked for by
set-core (change `fleet-waiting-on-you`, design D4, 2026-10-19): a consumer project's operations
watch writes `→ <owner>` inside the TEXT of broadcast REQUESTs — dozens of open items — and nothing
can count those reliably. The same broadcasts are the bus's biggest cost: one bot seat caused 66%
of all wake decisions in 21 days (docs/native-messaging.md), waking every live seat for questions
only the human could answer.

## What Changes

- **`owner` is a reserved addressee**: the human of the machine that reads the entry. `--to owner`
  is stored in `to` like any address, is exempt from the participant check, wakes no seat and is
  never rung. In a relayed room it travels as `owner@<this device>`, and arrives back as `owner`
  only on that device.
- **`sac owner [--json]`** lists owner-addressed entries still OPEN across the rooms of this
  machine — schema `sac.owner/1`: `{ schema, generatedAt, open: [{ room, id, ts, type, from, to,
  text, ageMinutes }] }`, oldest first. set-core's Fleet reads only this view.
- **Open = unanswered**: no entry in the room has `re:` pointing at it. Closing by hand is the same
  rule: `sac owner close <room> <ts> [note]` appends a FACT with that `re:`, written as `owner`.
- The MCP `send` description and the skill say that `owner` exists and when to use it.

## Capabilities

### New Capabilities
- `owner-addressee`: addressing the human, and the view of what is waiting on them.

## Impact

- `src/store.mjs` (`OWNER`, `isOwner`, participant exemption, `resolveRoom`, `isForMe`, `ownerOpen`)
- `src/bridge.mjs` (push: `owner` → `owner@<ns>`)
- `bin/sac.mjs` (`sac owner`, `sac owner close`), `src/tools.mjs` (description), skill
- tests: `test/owner.test.mjs`, relay translation in it; live: `test/live/owner.live.mjs`
