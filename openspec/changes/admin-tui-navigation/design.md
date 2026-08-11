## Context

`src/admin-tui.mjs` is 362 lines with no dependencies. Its shape is already right: `snapshot()`
reads the store, `render(snap, ui)` is a **pure function** of that snapshot plus a `ui` object, and
`runAdminTui()` is the only impure part. The tests exercise `render` directly with a hand-built
room and `{ selected: 0 }`, so a whole screen can be asserted on without a terminal.

That structure is why this change is tractable: navigation is entirely a matter of growing `ui`
and keeping `render` pure. Nothing about what the view *reports* changes.

Two properties are load-bearing and are the reason the tool can be left running on a second
screen all day:

- **It writes nothing.** No cursor moves, nothing is marked read. Watching a room may never change
  what the seats in it will see.
- **`live` is three-state**, and `null` means "we do not know", not "dead".

One existing limit becomes visible as soon as scrolling exists: `snapshot()` calls
`store.history({ room, limit: 400 })`, and `history` is `all.slice(-limit)` — there is no way to
ask for anything older.

## Goals / Non-Goals

**Goals:**

- Reach everything on screen: every seat, every entry, the whole text of an entry.
- Keep `render` pure, so the screen stays assertable in tests.
- Keep every existing key working — `↑`/`↓` still changes room from the channels pane.

**Non-Goals:**

- Any write path. No marking read, no sending, no "reply from the admin view". If that is ever
  wanted it is a different tool with a different name.
- A dependency. No `blessed`, no `ink`.
- Mouse support.
- Rendering `sac stats` (the other change). The stats pane, if it happens, comes after both land.

## Decisions

### D1 — `ui` grows into per-pane state; `render` stays pure

```
ui = {
  pane: "channels" | "subs" | "flow",
  cursor: { channels: 0, subs: 0, flow: 0 },   // selected row, per pane
  scroll: { channels: 0, subs: 0, flow: 0 },   // first visible row, per pane
  overlay: null | { kind: "entry" | "seat" | "help", …, scroll },
  query:  { channels: "", subs: "", flow: "" },
  filter: "all" | "waking" | <TYPE>,
  follow: true,
}
```

`ui.selected` is kept as an alias of `cursor.channels` so the existing tests — which pass
`{ selected: 0 }` — keep passing unchanged. A test that hands in a partial `ui` gets defaults for
everything else.

*Alternative rejected:* a single global cursor with the pane implied by it. It makes "go back to
the pane I was in" impossible to express, which is the whole point of `Esc` returning you where
you were.

### D2 — Derivation order: filter → search → scroll

Each pane derives its rows in one direction: the full list, then the filter, then the query, then
the visible slice. The cursor indexes into the **filtered** list, and the position indicator is
`cursor+1 / filtered.length`, with the unfiltered total named in the header when they differ.

This is the only order in which "3/18 shown of 47" can be stated truthfully, and stating it
truthfully is the requirement — a narrowed view that does not say it is narrowed is the same
failure class as a quiet room that is actually a broken one.

### D3 — Selection is anchored to identity, not to an index

A redraw happens every second and the underlying list can gain rows. The cursor therefore stores
the **id** of the selected thing (room name, seat name, entry `ts|from`), and the index is
recomputed each frame. If the selected item is gone, the cursor moves to the nearest surviving row.

*Alternative rejected:* keeping the index. A new entry arriving above the cursor would shift the
selection to a different message — and the operator would open the wrong one.

### D4 — Follow mode is a boolean derived from where the cursor is

`follow` is true while the flow's cursor is on the newest entry. Arriving entries scroll into view
only then. Scrolling up sets it false; pressing `End` sets it true again. The indicator ("N newer
below") is drawn from the same state.

This is the one interaction where getting it wrong makes the tool worse than it is today: a view
that jumps while you read is unusable exactly when there is traffic to read.

### D5 — Older entries: raise the window, and state the boundary

`store.history` gains an optional `before` (or an offset) so the flow can page backwards.
Everything about the existing signature stays as it is — `{ room, from, limit }` with
`slice(-limit)` — because `inbox`, the MCP tool and the CLI all depend on it.

If paging backwards is not implemented in this change, the pane MUST say it is at the start of the
loaded window and give the room's total. **The boundary is stated either way**; what is optional
is whether it can be crossed. Silently ending at entry 400 is not an option — that is the same
mistake as `… és még N`.

### D6 — Keys are matched from one table, and `?` is generated from it

One `KEYS` table maps a key to an action, per pane. The footer and the `?` overlay are rendered
from that table, so a binding cannot exist without being documented. Raw-mode escape sequences
(`\x1b[A`, `\x1b[5~`, `\x1b[Z` for Shift-Tab) are decoded in one place, because a partially
decoded sequence otherwise falls through as stray printable characters into a search box.

### D7 — The overlay is a full-screen replacement, not a floating box

An overlay that leaves the panes visible around it has to be composited into lines that are
already colour-escaped and truncated, and the existing `trunc`/`pad`/`fit` helpers work per line.
A full-screen overlay reuses them exactly as they are.

*Trade-off, accepted:* you lose sight of the room while reading an entry. `Esc` is one key, and
the alternative is a rewrite of the line-composition layer.

### D8 — Resize is handled by reading `process.stdout.columns` every frame, plus a `resize` listener

The frame already reads the terminal size every render. The listener exists to redraw immediately
rather than up to a second later, and to clamp the scroll offsets into the new bounds. Clamping is
done at render time, so a stale `ui` can never draw out of range.

## Risks / Trade-offs

- **The state machine grows, and the tests are the only guard.** → `render` stays pure and every
  new behaviour is asserted on a rendered screen, the way the existing tests do it.
- **A search box in raw mode swallows keys.** → While a query is being typed, only printable
  characters, backspace, `Enter` and `Esc` are consumed; every other key is ignored rather than
  being interpreted as navigation.
- **`history` gaining a parameter touches the core.** → Optional argument, existing behaviour when
  absent, and covered by a test that asserts the old callers are byte-identical.
- **More keys means more ways to write by accident.** → There is no write path in this file at
  all; the test that asserts the store is untouched after exercising every key is the guard, and
  it is cheap.
- **Colour and truncation interact.** `trunc` already walks escape sequences; new indicators must
  go through it. → The existing no-wrap test is extended to the overlay and to the narrow case.

## Migration Plan

1. Grow `ui` with defaults, keeping `selected` as an alias. Nothing changes on screen.
2. Add focus and the position indicators; the panes still show what they show today.
3. Add scrolling, and remove the `… és még N` truncation once every row is reachable.
4. Add the overlay (entry, seat, help).
5. Add search and filter.
6. Add follow mode and the older-entries boundary.

Every step leaves a working tool. Rollback is per-step: the state is entirely in memory, and the
tool writes nothing, so there is nothing to undo outside the file.

## Open Questions

1. **Does `Enter` on a room in the channels pane open something, or just move focus to the flow?**
   Leaning: move focus to the flow of that room — a "room detail" overlay would duplicate the two
   panes below it.
2. **Should the flow show clipped or whole text in the one-line rendering?** It is one line either
   way; the question is whether the overlay is the only place the full text lives. Leaning: yes,
   overlay only — that is what makes the one-line form safe to keep dense.
3. **Does the subscriber overlay show per-writer cursor detail?** It is the most useful thing the
   store knows and nothing surfaces it. Leaning: yes, but it is the one place where this view gets
   close to reporting *what* was read rather than *how much*.
4. **Does `sac stats` (the other change) become a fourth pane or a separate view?** Not decided
   here, and deliberately: both changes should land before that is answered.
