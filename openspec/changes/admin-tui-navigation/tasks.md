## 1. The `ui` state, without changing the screen

- [x] 1.1 Grow `ui` to `{ pane, cursor, scroll, overlay, query, filter, follow }` with defaults, keeping `selected` as an alias of `cursor.channels` so the existing tests pass unchanged (D1)
- [x] 1.2 `render` normalises a partial `ui` to a complete one, so a test can hand in `{ selected: 0 }` and get every default
- [x] 1.3 Test: the current test file passes untouched — the screen is identical before and after this step
- [x] 1.4 Selection is stored by identity (room name, seat name, `ts|from`), and the index is recomputed each frame; a vanished selection moves to the nearest surviving row (D3)
- [x] 1.5 Test: an entry inserted above the selected one leaves the same entry selected

## 2. Focus and position

- [x] 2.1 One `KEYS` table maps key → action per pane; escape sequences (`\x1b[A/B`, `PgUp`/`PgDn`, `Home`/`End`, `\x1b[Z` for Shift-Tab) decoded in one place (D6)
- [x] 2.2 `Tab` / `Shift-Tab` cycle the active pane; the active pane's header is visibly marked
- [x] 2.3 Each pane header shows `cursor+1 / total` when its content exceeds its height (D2)
- [x] 2.4 Test: rendering with each pane active marks that one and only that one
- [x] 2.5 Test: `↑`/`↓` on the channels pane still changes room, `q` quits and `r` redraws from any pane — no existing key regressed

## 3. Scrolling, and the end of silent truncation

- [x] 3.1 Per-pane scroll with `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`, clamped at both ends
- [x] 3.2 Scroll offsets are clamped at **render** time, so a stale `ui` or a resize can never draw out of range (D8)
- [x] 3.3 Remove the `… és még N` subscriber truncation — every seat is now reachable by scrolling
- [x] 3.4 Test: a room with 18 seats in a pane that shows 4 — every seat can be brought into view, and the header states the position
- [x] 3.5 Test: `↑` on the first row moves nothing

## 4. The overlay

- [x] 4.1 Full-screen overlay replacing the panes, reusing `trunc`/`pad`/`fit` per line (D7); `Esc` closes it and restores the exact cursor and scroll
- [x] 4.2 Entry overlay: whole text, never clipped, wrapped to the terminal width, with ts, type, author, addressees, `re:` and character count; scrolls when taller than the screen
- [x] 4.3 Seat overlay: liveness with its age, focus, room membership, backlog — unknown liveness rendered as unknown, never as dead
- [x] 4.4 `?` opens a key map **generated from the `KEYS` table**, so a binding cannot exist undocumented; any key closes it; the footer stays exactly one line
- [x] 4.5 Test: a 3000-character entry renders in full and scrolls
- [x] 4.6 Test: closing the overlay leaves the same item selected and the scroll position unchanged

## 5. Search and filter

- [x] 5.1 `/` starts a query on the active pane, matching case-insensitively against the rendered row; `Esc` clears it
- [x] 5.2 While typing a query, only printable characters, backspace, `Enter` and `Esc` are consumed — every other key is ignored, never interpreted as navigation
- [x] 5.3 `f` cycles the flow filter: all → waking only → one type
- [x] 5.4 Derivation order is filter → search → scroll, and the header states the query/filter and `shown / total` whenever they differ (D2)
- [x] 5.5 A query matching nothing says so, rather than rendering an empty pane
- [x] 5.6 Test: the header names an active filter and the counts; clearing restores every row

## 6. Follow mode and the window boundary

- [x] 6.1 `follow` is true while the flow cursor is on the newest entry; arriving entries scroll into view only then, and `End` re-enables it (D4)
- [x] 6.2 When not following, the pane indicates how many newer entries are below
- [x] 6.3 Test: a new entry with the flow scrolled up moves no visible row; with the flow at the bottom, it appears
- [x] 6.4 ~~`store.history` gains an optional backward-paging parameter~~ — **not needed, and the core was left alone.** `history` is `all.slice(-limit)`, so a larger `limit` already reaches further back: the TUI doubles its window when the cursor hits the top (`snapshot({ window })`). D5 anticipated a core change; the measurement did not require one, which is the cheaper outcome
- [x] 6.5 Test: no `history` caller changed, because `history` did not — asserted by the full suite (201 tests) and by `admin-tui-readonly.test.mjs`, which checks that a smaller window bounds what is loaded and never what the room reports as its total
- [x] 6.6 The top of the flow either loads older entries or states that this is the start of the loaded window and gives the room's total — never a silent boundary

## 7. The invariants, asserted rather than assumed

- [x] 7.1 Test: exercising every navigation key in turn leaves the store byte-identical — no cursor moved, nothing marked read, no file created
- [x] 7.2 Test: at 60 columns with long seat names, an active query and an open overlay, no rendered line exceeds 60 visible columns
- [x] 7.3 `resize` listener redraws immediately and clamps scroll into the new bounds; a terminal too short to give a pane any rows renders without throwing
- [x] 7.4 Test: a terminal of 10 rows renders; a terminal resized mid-run uses the new size on the next frame
- [x] 7.5 Test: liveness stays three-state everywhere in the new UI, including the overlay

## 8. Closing

- [x] 8.1 Dated, measured comments on the non-obvious branches: follow mode, identity-anchored selection, and the query key-swallowing rule — each with the failure it prevents
- [x] 8.2 README: the `sac admin` section gains the key map and the fact that it is still read-only under every key
- [ ] 8.3 Reconcile with `declared-state-and-stats`: `quiet` is a fourth presence state the subscriber pane and the seat overlay must render distinctly (that change's task 4.9). **Blocked until `quiet` exists** — `liveMark`/`liveWord` are the two places it lands, and both are now single-source, so it is a two-line change there plus its tests
