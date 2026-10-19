## Why

A seat name is `<project>#<8 hex>` and Claude Code's native name is `<project>-<2 hex>`; both change
every time a window is replaced. Measured 2026-10-09 → 10-19 (`docs/native-messaging.md`): 5
built-in sends failed with *"No agent named … is reachable"* because the window had been replaced,
one 2-hex name collided, and an umbrella project with four to five live windows had its products
answer whichever window they last heard from — one order arrived twice through two windows.

The person running the fleet wants to say *"tell the Studio"* and *"this window is the Gateway"* —
in plain words, in either language — and have it reach the right live window. set-core's Fleet
already gives windows stable labels (`<project>-studio`) that a replacement window inherits, and
nothing on the bus reads them.

## What Changes

- **An alias book** (`aliases.json` in the store): a human name → a Fleet label, a project, or a
  seat. Names compare loosely (case, accents, spaces and punctuation ignored), so "Átjáró",
  "atjaro" and "ÁTJÁRÓ!" are one name.
- **Fleet labels are read** (read-only, optional) from set-core's `fleet-roster.json`
  (`SET_AGENT_FLEET_ROSTER` overrides the path) and joined to seats by session id.
- **`to` accepts an alias or a Fleet label** wherever it accepts a seat — MCP `send`, CLI
  `send --to`, room inference. Resolution always ends in a seat, and the result reports
  `resolved: [{ asked, seat, via }]`. An alias that matches several live windows is refused with
  the list, never fanned out.
- **An `alias` MCP tool** — list, bind THIS window, bind a target, remove — so the model fills in
  structured arguments and the person's wording does not matter. Binding this window prefers its
  Fleet label (survives replacement) and says which it used.
- **`sac alias`** on the CLI, forgiving: the rest of the line is the name, no quoting needed.
- **`agents` shows each seat's Fleet label and aliases.**
- **The shipped `agent-comm` skill** gets the trigger phrases in Hungarian and English.

## Capabilities

### New Capabilities
- `seat-aliases`: human names and Fleet labels as addresses that resolve to a live seat.

### Modified Capabilities
(none — the addressing rule for seats and project names is unchanged)

## Impact

- `src/store.mjs` (alias book, Fleet roster reader, `resolveAddressees`, `agents` fields)
- `src/tools.mjs` (new `alias` tool; `send` resolves before room inference)
- `bin/sac.mjs` (`sac alias`; `send --to` resolves)
- `skills/agent-comm/SKILL.md` (triggers + a section)
- tests: `test/aliases.test.mjs`; live: `test/live/aliases.live.mjs`
