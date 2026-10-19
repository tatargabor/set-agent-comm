## 1. Core

- [x] 1.1 `OWNER`, `isOwner(name)`; `isForMe` ignores owner names; `send`'s participant check exempts them [REQ: the-owner-shall-be-addressable]
- [x] 1.2 `resolveRoom` and `resolveAddressees` treat `owner` as known, never as a reason to infer a room [REQ: the-owner-shall-be-addressable]
- [x] 1.3 `ownerOpen()` → `sac.owner/1` over non-archived rooms; open = no `re:` to it in the room [REQ: the-open-items-shall-be-listed-for-a-program]
- [x] 1.4 `ownerClose({ room, ts, note })` appends a FACT with `re:` as `owner` [REQ: the-open-items-shall-be-listed-for-a-program]

## 2. Wire and faces

- [x] 2.1 bridge push: `owner` → `owner@<ns>` [REQ: each-machine-s-owner-shall-be-their-own]
- [x] 2.2 `sac owner [--json]`, `sac owner close <room> <ts> [note…]` [REQ: the-open-items-shall-be-listed-for-a-program]
- [x] 2.3 MCP `send` description and the skill mention `owner` [REQ: the-owner-shall-be-addressable]

## 3. Tests

- [x] 3.1 Unit: wakes nobody, mixed addressing, open/answered/closed, archived skipped, relay translation both ways [REQ: the-open-items-shall-be-listed-for-a-program]
- [x] 3.2 Live: a real session told "ask the owner of this machine …" addresses `owner`; `sac owner --json` lists it; nobody is rung [REQ: the-owner-shall-be-addressable]
