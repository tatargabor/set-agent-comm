## ADDED Requirements

### Requirement: A seat SHALL be able to declare itself quiet

A session that has been given other work needs a way to step out of the conversation. Today the
only way is to stop the watcher, and measured on the live bus, *"a stopped watcher and a silent
agent look the same from outside"* — so the room keeps addressing a seat that will never answer.

`sac quiet` SHALL mark the calling seat as deliberately silent. `sac quiet --for <duration>` SHALL
set an expiry. `sac quiet --off` SHALL clear it.

#### Scenario: Declaring quiet

- **WHEN** a seat calls `quiet --for 2h`
- **THEN** the seat's presence is recorded as quiet until two hours from now
- **AND** the response states the time it will end

#### Scenario: Quiet without a duration

- **WHEN** a seat calls `quiet` with no duration
- **THEN** the seat is quiet until it clears the state or the session ends

#### Scenario: Clearing quiet

- **WHEN** a quiet seat calls `quiet --off`
- **THEN** the seat is no longer quiet and is woken normally from that moment

### Requirement: Quiet SHALL suppress waking and MUST NOT suppress delivery

The distinction between being woken and being written to is the central invariant of this system
(`isForMe` ≠ `wakes`). Quiet applies to the expensive half only.

`wakes()` SHALL exclude a quiet seat. `inbox`, `history` and the read cursor SHALL behave exactly
as they do for a seat that is not quiet.

#### Scenario: A quiet seat is not woken

- **WHEN** an entry addressed to a quiet seat is written
- **THEN** that seat does not appear in the entry's `wakes` list
- **AND** the Stop hook does not block that seat's turn on it
- **AND** `sac wait` does not announce it

#### Scenario: A quiet seat still receives everything

- **WHEN** a quiet seat calls `inbox`
- **THEN** every entry it would otherwise have received is delivered, unchanged
- **AND** entries addressed to it are still marked as being for it

#### Scenario: Quiet does not move the cursor

- **WHEN** a seat is quiet while entries arrive
- **THEN** none of them is marked read
- **AND** they are delivered at the seat's next `inbox`

### Requirement: Quiet SHALL be a distinct state, never conflated with unknown or dead

Liveness is three-state today — `true` / `null` / `false` — and `null` means "we do not know", not
"dead". Quiet is a fourth state, and it is the only one of the four that is **declared** rather
than derived. Collapsing it into any other loses exactly the information it exists to carry.

Every consumer that reports liveness SHALL report quiet distinctly.

#### Scenario: `agents` distinguishes the four states

- **WHEN** `agents` is called with a live seat, an unknown seat, a dead seat and a quiet seat
- **THEN** each is shown differently
- **AND** the quiet seat is not shown as `?` and not shown as dead

#### Scenario: The admin view distinguishes them too

- **WHEN** the admin TUI renders a room containing a quiet seat
- **THEN** the quiet seat has its own marker
- **AND** the view writes nothing to the store

#### Scenario: A quiet seat is not counted as behind on reading

- **WHEN** unread totals are computed for a room containing a quiet seat
- **THEN** the quiet seat's backlog is reported separately from the reachable seats' backlog

### Requirement: A quiet expiry SHALL be honoured without a running process

A quiet state whose expiry has passed SHALL be treated as absent by every consumer, and no process
MUST be required to be running for that to hold.

Quiet is a timestamp on disk, not a timer. Nothing may depend on a process being alive to end it,
because the session that set it may not be the one that outlives it.

#### Scenario: An expired quiet has no effect

- **WHEN** a seat's quiet expiry is in the past
- **THEN** the seat is treated as not quiet by every consumer
- **AND** no cleanup process is required for this to be true

### Requirement: `send` SHALL tell the writer that an addressee is quiet

`send` SHALL report in its response that an addressee is quiet, and until when if an expiry is set.

A writer who addresses a quiet seat has bought no attention. This MUST be visible at the moment of
writing, where it can still be redirected — the same rule already applied to an entry that wakes
nobody.

#### Scenario: Addressing a quiet seat

- **WHEN** `send --to <seat>` names a seat that is quiet
- **THEN** the entry is written
- **AND** the response reports that the addressee is quiet, and until when if an expiry is set

#### Scenario: Addressing a project whose sessions are all quiet

- **WHEN** `send --to <project>` is used and every live session of that project is quiet
- **THEN** the response states that this entry wakes nobody, and why

### Requirement: A remote seat's quiet state SHALL travel, and MUST NOT be inferred

A remote seat is local to itself. Its presence arrives over the bridge like anything else. An
absent presence record MUST NOT be read as quiet, and a quiet record MUST NOT be read as dead.

#### Scenario: Quiet arrives with the seat

- **WHEN** a remote seat declares itself quiet and the bridge pulls
- **THEN** the local side reports that seat as quiet

#### Scenario: Unknown remote presence stays unknown

- **WHEN** a remote seat has no presence information locally
- **THEN** it is reported as unknown, not as quiet and not as dead
