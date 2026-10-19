## ADDED Requirements

### Requirement: The owner SHALL be addressable

`owner` SHALL be accepted as an addressee in any room without being a participant, stored in
`to`, and SHALL wake no seat and ring no doorbell when it is the only addressee.

#### Scenario: Asking the owner wakes nobody
- **WHEN** a seat sends a QUESTION with `to: ["owner"]` into a room with three live seats
- **THEN** the entry is written with `→ owner`
- **AND** `wakes` is empty and nothing is rung

#### Scenario: Owner and a seat
- **WHEN** an entry is addressed to `owner` and to one seat
- **THEN** that seat is woken as for any direct address

### Requirement: The open items SHALL be listed for a program

`sac owner --json` SHALL list, across the non-archived rooms of this machine, every entry
addressed to `owner` that no entry in its room answers with `re:`, in the `sac.owner/1` shape,
oldest first.

#### Scenario: Answered by an agent
- **WHEN** an agent answers an owner-addressed QUESTION with `re:` pointing at it
- **THEN** the QUESTION no longer appears in the view

#### Scenario: Closed by the owner
- **WHEN** the owner runs `sac owner close <room> <ts>`
- **THEN** a FACT with that `re:` is written as `owner` and the item leaves the view

### Requirement: Each machine's owner SHALL be their own

In a relayed room, `owner` written on one machine SHALL be that machine's owner and SHALL NOT
appear in another machine's view.

#### Scenario: Relayed room
- **WHEN** an entry addressed to `owner` is pushed from machine A and pulled on machine B
- **THEN** on B it is addressed to `owner@A` and is not in B's view
