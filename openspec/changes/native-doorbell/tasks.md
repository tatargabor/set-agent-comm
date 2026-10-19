## 1. Record

- [x] 1.1 `store.setDoorbell(seat, patch)` / `doorbellOf(seat)` over `doorbells/<seat>.json`; never throws [REQ: a-seat-s-doorbell-shall-be-recorded-by-its-own-hooks]
- [x] 1.2 `store.inboundPolicy(cwd)` from user, project and local settings: any `refuse`, then `hold`, then `accept`, else null [REQ: a-seat-s-doorbell-shall-be-recorded-by-its-own-hooks]
- [x] 1.3 SessionStart records socket + inbound + the mode the window started in (`store.initialMode`); Stop and the watch guard record the live mode [REQ: a-seat-s-doorbell-shall-be-recorded-by-its-own-hooks]

## 2. Ring

- [x] 2.1 `store.ringable(seat)` → `{ ok, why }` per design D3 [REQ: a-seat-that-would-hold-the-line-shall-not-be-rung]
- [x] 2.2 `store.ringPlan(entry, woke, room)` — direct address or pair room only [REQ: send-shall-ring-a-directly-addressed-seat-that-can-be-woken-natively]
- [x] 2.3 `src/doorbell.mjs` `ring()` — connect, one line, close, 2 s timeout; stale on ENOENT/ECONNREFUSED [REQ: send-shall-ring-a-directly-addressed-seat-that-can-be-woken-natively]
- [x] 2.4 MCP and CLI `send` ring after writing; result `rang` / `notRung` with reason and fallback [REQ: a-seat-that-would-hold-the-line-shall-not-be-rung]
- [x] 2.5 Ledger `how: "rang"`; rung marks; `sac wait` skips rung entries; nudge untouched [REQ: a-rung-entry-shall-not-be-announced-twice]

## 3. Watch

- [x] 3.1 SessionStart omits the arm line for a ringable seat with no relay room [REQ: the-watch-shall-not-be-asked-for-where-the-doorbell-works]
- [x] 3.2 `hooks/watch-guard.mjs` (PreToolUse on Monitor) denies an inbox watch for such a seat; `sac install` wires it [REQ: the-watch-shall-not-be-asked-for-where-the-doorbell-works]

## 4. Tests

- [x] 4.1 Unit: deliverability matrix, plan (direct vs broadcast), stale socket, rung skip, guard decision, a real local socket server as the target [REQ: send-shall-ring-a-directly-addressed-seat-that-can-be-woken-natively]
- [x] 4.2 Live (`npm run live`): idle default-mode `claude -p` is rung and answers on the bus; bypass target is not rung; the guard denies a watch [REQ: send-shall-ring-a-directly-addressed-seat-that-can-be-woken-natively]
