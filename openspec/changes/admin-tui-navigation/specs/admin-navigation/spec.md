## ADDED Requirements

### Requirement: Exactly one pane SHALL be active, and the active pane SHALL be visible

The view SHALL keep exactly one of the three panes (channels, subscribers, flow) active at any
time, SHALL mark it so the operator can tell which one without pressing a key, and SHALL move
focus with `Tab` (forward) and `Shift-Tab` (backward).

#### Scenario: The active pane is marked

- **WHEN** the view is rendered with the subscribers pane active
- **THEN** that pane's header is distinguishable from the other two
- **AND** the other panes still render their content

#### Scenario: Focus cycles

- **WHEN** `Tab` is pressed on the last pane
- **THEN** focus returns to the first pane

#### Scenario: Existing keys keep working

- **WHEN** `↑`/`↓` are pressed while the channels pane is active
- **THEN** the selected room changes, as it did before this change
- **AND** `q` quits and `r` redraws from any pane

### Requirement: Every pane SHALL scroll, and no pane MAY silently drop rows

A pane whose content exceeds its height SHALL scroll, and SHALL report the cursor's position
within the total (for example `3/18`). A pane MUST NOT drop rows with no way to reach them.

`↑`/`↓` move by one row, `PgUp`/`PgDn` by one pane height, `Home`/`End` to the ends — all within
the active pane.

#### Scenario: A long subscriber list is fully reachable

- **WHEN** a room has 18 seats and the pane can show 4
- **THEN** every one of the 18 can be brought into view by scrolling
- **AND** the pane shows which of the 18 the cursor is on

#### Scenario: Scrolling stops at the ends

- **WHEN** the cursor is on the first row and `↑` is pressed
- **THEN** the cursor stays on the first row and the view does not scroll past it

#### Scenario: A pane shorter than its content states so

- **WHEN** content exceeds the pane height
- **THEN** the position indicator is rendered in the pane's header

### Requirement: `Enter` SHALL open the selected item in full

The one-line rendering exists to fit the overview; it is not a way to read. `Enter` SHALL open the
active pane's selected item in a full-screen overlay, and `Esc` SHALL close it and return the
cursor exactly where it was.

For an entry the overlay SHALL show the whole text — never clipped — with its timestamp, type,
author, addressees, `re:` target and character count. For a seat it SHALL show liveness with its
age, focus, room membership, backlog and how far behind it is per writer.

#### Scenario: Reading a whole entry

- **WHEN** an entry of 3000 characters is opened
- **THEN** the overlay shows all 3000 characters, wrapped to the terminal width
- **AND** the overlay scrolls if the entry is taller than the screen

#### Scenario: Closing returns to where you were

- **WHEN** the overlay is closed with `Esc`
- **THEN** the same item is still selected and the pane's scroll position is unchanged

#### Scenario: Opening a seat

- **WHEN** a subscriber row is opened
- **THEN** the overlay names the seat's liveness state, focus, and unread count
- **AND** an unknown liveness is shown as unknown, never as dead

### Requirement: The view MUST remain read-only under every interaction

Nothing in the admin view may write. Opening an entry is not a delivery: it MUST NOT move a
cursor, MUST NOT mark anything read, MUST NOT send a heartbeat, and MUST NOT create or modify any
file in the store. This holds for every key introduced here.

#### Scenario: Opening an entry changes nothing

- **WHEN** an entry is opened, scrolled and closed
- **THEN** the store's cursor file is byte-identical to what it was before

#### Scenario: No file is created by navigating

- **WHEN** every navigation key is exercised in turn
- **THEN** no new file appears in the store directory

### Requirement: Search and filter SHALL be visible whenever they are active

`/` SHALL start a search over the active pane, matching case-insensitively against the rendered
row. `f` SHALL cycle the flow pane's filter: all entries → waking entries only → one entry type.
Whenever either is narrowing what is shown, the pane header SHALL say so and SHALL show how many
rows of the total are being shown; `Esc` SHALL clear it.

A filtered view that does not announce itself is indistinguishable from a quiet room, which is the
failure this project exists to prevent.

#### Scenario: A search narrows and says so

- **WHEN** `/atlas` is entered in the channels pane
- **THEN** only matching rooms are listed
- **AND** the header states the query and the count shown out of the total

#### Scenario: The waking filter

- **WHEN** the flow filter is set to waking entries
- **THEN** only entries that would interrupt some seat are listed
- **AND** the header names the filter

#### Scenario: Clearing restores everything

- **WHEN** `Esc` is pressed with a search active
- **THEN** every row is shown again and the header stops mentioning a query

#### Scenario: A search that matches nothing says nothing matched

- **WHEN** a query matches no row
- **THEN** the pane states that nothing matched the query, rather than appearing empty

### Requirement: The flow SHALL follow new entries only when it is at the bottom

The view redraws on a timer. If a redraw moved the flow while the operator was reading older
entries, the tool would be unusable exactly when it matters. The flow SHALL scroll to a newly
arrived entry only when it is already showing the newest one; otherwise it SHALL hold its
position and SHALL indicate that newer entries exist.

#### Scenario: Following at the bottom

- **WHEN** the flow is showing the newest entry and a new entry arrives
- **THEN** the new entry is shown

#### Scenario: Not following when scrolled up

- **WHEN** the flow is scrolled up and a new entry arrives
- **THEN** the visible rows do not move
- **AND** the pane indicates that there are newer entries below

#### Scenario: A selection survives a redraw

- **WHEN** a redraw happens while a row is selected
- **THEN** the same row is still selected afterwards, even if rows were added above or below it

### Requirement: Entries older than the loaded window SHALL be reachable or the limit SHALL be stated

The snapshot loads the most recent entries only. Scrolling to the top of the flow SHALL either
load older entries or state plainly that this is the beginning of the loaded window and how many
entries the room holds in total. Silently ending at an arbitrary boundary MUST NOT happen.

#### Scenario: Reaching the top of the window

- **WHEN** the flow is scrolled to its first loaded entry and the room holds more
- **THEN** either the older entries are loaded, or the pane states that it is the start of the
  loaded window and gives the room's total

### Requirement: Every rendered line MUST fit the terminal, at any size

A line wider than the terminal wraps, pushes every pane below it down a row, and the layout stops
lining up. This holds for the overlay and for every new indicator introduced here. The view SHALL
re-flow on a terminal resize without corrupting the alternate screen.

#### Scenario: No line exceeds the width

- **WHEN** the view is rendered at 60 columns with long seat names, a long query and an open
  overlay
- **THEN** no rendered line is wider than 60 visible columns

#### Scenario: Resize

- **WHEN** the terminal is resized while the view is running
- **THEN** the next frame uses the new size
- **AND** the scroll positions remain within their new bounds

#### Scenario: A pane too small to draw

- **WHEN** the terminal is too short to give a pane any rows
- **THEN** the view renders without throwing and shows what it can

### Requirement: `?` SHALL show the key map

The footer is one line and cannot carry every key. `?` SHALL open a key map listing every binding,
and any key SHALL close it.

#### Scenario: The key map lists the bindings

- **WHEN** `?` is pressed
- **THEN** the overlay lists focus, movement, open, search, filter and quit bindings

#### Scenario: The footer stays one line

- **WHEN** the view is rendered normally
- **THEN** the footer occupies exactly one line and names the way to the key map
