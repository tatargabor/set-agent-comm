## Why

`sac admin` renders three panes on one page and offers three keys: `↑`/`↓` to change room, `r`,
and `q`. Everything else on the screen is unreachable:

- **An entry cannot be read.** Every message in the flow is collapsed to one truncated line. The
  view that exists to show what is flowing cannot show what was said — and this is the same tool
  an operator reaches for precisely because `inbox` clips at 1200 characters.
- **Subscribers are silently dropped.** The pane keeps `(rows - 14) / 2` seats and prints
  `… és még N`. In a room with 18 seats — measured, `consumer-a-atlas` has 18 — most of them cannot be
  looked at by any means.
- **The flow cannot be scrolled.** Only the last screenful is drawn; everything older is
  unreachable, and the snapshot itself stops at the most recent 400 entries.
- **Nothing can be searched or filtered.** Finding who is behind, or what woke somebody, means
  reading the whole screen by eye.

The view is honest and read-only, and both properties must survive. What it lacks is a way in.

## What Changes

- **One pane is active at a time**, marked visibly; `Tab` / `Shift-Tab` moves between the three,
  and `↑`/`↓`/`PgUp`/`PgDn`/`Home`/`End` act on the active pane. Room selection remains what the
  channels pane does — so today's muscle memory keeps working.
- **Every pane scrolls, and no pane silently drops rows.** Where content exceeds the pane, the
  position is shown (`3/18`), never `… and N more` with no way to reach them.
- **`Enter` opens the selected item** in a full-screen overlay: an entry's whole text with its
  header, addressees, `re:` and length; a seat's cursor position, focus, liveness and backlog.
  `Esc` closes it.
- **`/` searches** the active pane and `f` cycles a filter on the flow (all → waking only → one
  type). Both are visible in the header while active, because a filtered view that does not say so
  is a lying view.
- **The flow follows new entries only when the view is already at the bottom.** Scrolled up, it
  stays where the operator put it, and marks that newer entries exist.
- **`?` shows the key map.** The footer stays a one-line summary.
- **Terminal resize is handled**; panes re-flow without leaving the alternate screen dirty.

## Capabilities

### New Capabilities
- `admin-navigation`: how an operator moves through the admin view — pane focus, scrolling,
  opening an item, searching and filtering — and what the view must never do while they do it.

### Modified Capabilities
<!-- None: `sac admin`'s existing behaviour has no spec yet, and this change adds to it rather
     than altering what it reports. -->

## Impact

- `src/admin-tui.mjs` — the `ui` state grows from `{ selected }` to a per-pane cursor, scroll
  offset, overlay and query; `render` stays a pure function of `(snapshot, ui)` so the existing
  tests keep working and new ones can assert on a screen without a terminal.
- `src/store.mjs` — `history` currently returns `slice(-limit)` with no way to reach older
  entries; scrolling past the newest 400 needs an offset or a larger window. This is the only
  core change, and it must not alter what any existing caller sees.
- `test/admin-tui.test.mjs` — new cases for focus, scrolling, the overlay, and the invariants
  below.
- **Unchanged and load-bearing**: the view writes nothing (no cursor moves, nothing is marked
  read), no line ever exceeds the terminal width, liveness stays three-state with `null` drawn as
  `?`, and the package gains no dependency.
