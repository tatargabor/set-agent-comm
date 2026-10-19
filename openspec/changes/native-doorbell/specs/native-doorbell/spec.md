## ADDED Requirements

### Requirement: A seat's doorbell SHALL be recorded by its own hooks

The SessionStart hook SHALL record the session's inbox socket, the effective
`crossSessionInbound`, and the permission mode the window started in (its command line, else the
`defaultMode` that applies); the Stop hook — and the watch guard's PreToolUse — SHALL record the
live permission mode. The record SHALL be one file per seat, written only by that seat's hooks,
and recording SHALL never fail or print.

#### Scenario: A fresh window is ringable before its first turn
- **WHEN** a window starts with `--permission-mode auto` and has not finished a turn yet
- **THEN** its doorbell record holds the socket path and mode `auto`

#### Scenario: Idle session has a fresh mode
- **WHEN** a session ends a turn in `auto` mode
- **THEN** its doorbell record holds the socket path and mode `auto`

### Requirement: Send SHALL ring a directly addressed seat that can be woken natively

After an entry is written, every seat the rule wakes by direct address (or in a pair room) whose
doorbell would deliver SHALL be sent a notice into its socket, and the result SHALL list it under
`rang`.

#### Scenario: Idle default-mode receiver wakes
- **WHEN** a REQUEST is sent `to` an idle seat whose session is in `default` mode
- **THEN** the seat's session starts a turn without any watch armed
- **AND** the send result lists the seat in `rang`

#### Scenario: Broadcast is not rung
- **WHEN** a QUESTION is sent to the room without `to`
- **THEN** no seat is rung

### Requirement: A seat that would hold the line SHALL NOT be rung

A receiver whose `crossSessionInbound` is `hold` or `refuse`, or that runs in bypass, plan or an
unknown mode without an explicit `accept`, SHALL NOT be rung; the result SHALL list it under
`notRung` with the reason and the fallback.

#### Scenario: Bypass receiver
- **WHEN** the addressee's last recorded mode is `bypassPermissions` and no `accept` applies
- **THEN** nothing is posted to its socket
- **AND** `notRung` names the reason and, when the sender is also in bypass mode, suggests `SendMessage` to `uds:<socket>`

#### Scenario: Stale socket
- **WHEN** the recorded socket refuses the connection
- **THEN** the seat is listed in `notRung` as stale and the record is marked stale

### Requirement: A rung entry SHALL NOT be announced twice

A ring SHALL be recorded as a wake-up (`how: "rang"`), and `sac wait` SHALL NOT announce an entry
already rung to that seat. The Stop hook's nudge SHALL NOT be spent by a ring.

#### Scenario: Ring then watch
- **WHEN** a seat with a running watch is rung for an entry
- **THEN** the watch does not announce that entry

### Requirement: The watch SHALL NOT be asked for where the doorbell works

For a seat that can be rung and is in no relay room, the SessionStart note SHALL NOT ask for an
inbox watch, and a `PreToolUse` guard SHALL decline arming one, with the reason.

#### Scenario: Guard declines
- **WHEN** a ringable seat with no relay room tries to arm `sac wait` in a Monitor
- **THEN** the tool call is denied with a reason naming the doorbell

#### Scenario: Relay room keeps the watch
- **WHEN** the seat is in a relay room
- **THEN** the watch is still asked for and allowed
