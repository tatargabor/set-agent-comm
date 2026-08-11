## ADDED Requirements

### Requirement: A room MUST exist before an entry can be written into it

Today a room is created as a side effect of writing (join-on-write), so a mistyped room name
produces a new, silent room the writer is alone in, and `send` returns success. The system SHALL
treat a room as an object that exists or does not.

`send` into a room that does not exist SHALL fail at the writer, and the error SHALL name every
room the caller could have meant. This mirrors the existing treatment of a mistyped *addressee*,
for the same reason: an entry nobody can receive is indistinguishable from a quiet room.

#### Scenario: Writing into a room that does not exist

- **WHEN** `send` is called with a room name that has no room record
- **THEN** the call fails without writing anything
- **AND** the error lists the rooms the caller is a member of
- **AND** the error states that `--create` is how a new room is opened

#### Scenario: A mistyped room does not become a room

- **WHEN** a caller sends into `"tema"` while being a member of `"team"`
- **THEN** no `channels/tema/` directory is created
- **AND** the error names `team`

#### Scenario: Rooms that exist only as a channel directory keep working

- **WHEN** the store contains `channels/<room>/` from before this change, with no room record
- **THEN** that room SHALL be treated as existing
- **AND** entries in it remain readable and writable

### Requirement: Creating a room is an explicit act

A room SHALL be created only by `sac install <room>`, or by `send`/`join` carrying an explicit
`--create` flag. Creation SHALL record who created it and when.

#### Scenario: Explicit creation

- **WHEN** `send --create` is called with a room name that does not exist
- **THEN** the room is created, the caller is enrolled, and the entry is written
- **AND** the response states that a new room was created

#### Scenario: Creation is idempotent

- **WHEN** `--create` is used for a room that already exists
- **THEN** the room is not re-created and no existing membership is lost

### Requirement: `sac install` SHALL give a project an address room

A project needs a channel whose name nobody had to guess. Measured: an agent inferred a room name
from a naming convention and spent a whole entry asking whether it had guessed right.

`sac install <room>` SHALL, in addition to the named room, create a room named after the project
itself if one does not exist, and enrol the project in it.

#### Scenario: Installing creates the project's address room

- **WHEN** `sac install team` runs in a project called `web-app`
- **THEN** the rooms `team` and `web-app` both exist
- **AND** the seat is a member of both

#### Scenario: The address room is not duplicated on re-run

- **WHEN** `sac install team` runs a second time in the same project
- **THEN** no second address room is created and existing membership is unchanged

### Requirement: Room membership SHALL be a property of the seat, not of the project

Today membership is derived from `SET_AGENT_ROOM`, read from the project's settings at session
start, so every session of a project is in the same rooms. A fourth session of a project cannot be
put in a different room without changing what the other three will read at their next start.

Membership SHALL be recorded per seat. `SET_AGENT_ROOM` SHALL become the **default** applied to a
seat when it first checks in, and SHALL NOT override a membership the seat has since changed.

#### Scenario: A new seat inherits the configured rooms

- **WHEN** a session starts in a project whose `SET_AGENT_ROOM` is `team,design`
- **AND** that seat has no membership record
- **THEN** the seat becomes a member of `team` and `design`

#### Scenario: One session's membership does not follow the project

- **WHEN** a seat leaves `team` and a second session of the same project starts
- **THEN** the second session's membership is unaffected by the first's change

#### Scenario: A changed membership survives a restart of the same seat

- **WHEN** a seat has joined `atlas` and the seat is resumed
- **THEN** the seat is still a member of `atlas`
- **AND** the configured default does not remove it

### Requirement: A running session SHALL be able to join and leave a room

`sac join <room>` and `sac part <room>` SHALL act on the calling seat and take effect immediately,
without a session restart.

#### Scenario: Joining takes effect for the next read

- **WHEN** a seat calls `join atlas`
- **THEN** `inbox atlas` delivers that room's unread entries to it
- **AND** `rooms` lists `atlas` for this seat

#### Scenario: Leaving stops delivery but preserves history

- **WHEN** a seat calls `part atlas`
- **THEN** the seat is no longer woken by entries in `atlas`
- **AND** the seat's own entry file in `atlas` is not deleted or altered
- **AND** `history atlas` still reads back for anyone still in the room

#### Scenario: Leaving the last room is allowed and stated

- **WHEN** a seat parts its only room
- **THEN** the call succeeds
- **AND** the response states that this seat is now in no room and will receive nothing

### Requirement: Room membership SHALL be visible from both ends

Measured on the live bus: *"room membership is invisible from both ends"* — a caller cannot see who
is in a room, and cannot see which rooms it is itself in beyond its own configuration.

`rooms` SHALL report, for each room the caller is in, the other seats that are members, and which
of them are reachable.

#### Scenario: Seeing who is in a room

- **WHEN** `rooms` is called by a seat that is in `team` with two other seats
- **THEN** the output names both other seats
- **AND** marks each one's liveness without collapsing unknown into dead

#### Scenario: A room with no other members is stated as such

- **WHEN** `rooms` is called and one of the caller's rooms has no other member
- **THEN** that room is reported as having nobody else in it
