## 1. Core (store.mjs)

- [x] 1.1 `aliasKey(name)` — NFD, strip combining marks, lowercase, letters and digits only [REQ: alias-names-shall-compare-loosely]
- [x] 1.2 `fleetLabels()` — read `SET_AGENT_FLEET_ROSTER` or set-core's default roster; session id → `{ label, project, lastSeen }`; any failure → `{}` [REQ: a-fleet-label-shall-be-an-address-on-its-own]
- [x] 1.3 `aliases()` / `setAlias({ name, kind, target, by })` / `removeAlias(name)` over `aliases.json`; refuse a key equal to a project or seat name [REQ: alias-names-shall-compare-loosely]
- [x] 1.4 `resolveAddressees(to)` — seat/project untouched, then alias, then label; one seat each, ambiguity is an error naming the seats and labels [REQ: an-alias-shall-resolve-to-exactly-one-seat]
- [x] 1.5 `labelOf(seat)` and `agents()` fields `label` / `aliases` [REQ: seats-shall-be-listed-with-their-names]

## 2. Faces

- [x] 2.1 MCP `alias` tool: list / bind this window / bind a target / remove; this window prefers its label and says which [REQ: a-window-shall-be-able-to-name-itself-in-plain-words]
- [x] 2.2 MCP `send` resolves `to` before room inference and reports `resolved` [REQ: an-alias-shall-resolve-to-exactly-one-seat]
- [x] 2.3 CLI `sac alias [name…] [--to target] [--rm]`, the rest of the line is the name; `sac send --to` resolves the same way [REQ: an-alias-shall-resolve-to-exactly-one-seat]
- [x] 2.4 Skill: trigger phrases (HU + EN) and a short section on names [REQ: a-window-shall-be-able-to-name-itself-in-plain-words]

## 3. Tests

- [x] 3.1 Unit: loose keys, shadowing refusal, label resolution, replacement window inherits, ambiguity error, missing roster, `agents` fields [REQ: an-alias-shall-resolve-to-exactly-one-seat]
- [x] 3.2 Live (`npm run live`): a real `claude -p` window told in plain words "your alias is Studio Lead" binds it; a second window sends "to Studio Lead" and the entry lands addressed to the first window's seat [REQ: a-window-shall-be-able-to-name-itself-in-plain-words]
