## ADDED Requirements

### Requirement: Every waking decision SHALL be recorded

This project's thesis is that being read is cheap and being woken is expensive. There is currently
no number for either: `wakes` is computed and discarded, and the letterbox's verdicts are not
kept. Every figure in the field notes is therefore a proxy.

Each time an entry is evaluated against a seat, the outcome SHALL be appended to a ledger: which
entry, which seat, what decided it (the addressing rule, the letterbox, the safety net, or a
declared quiet), and which way it went.

#### Scenario: A rule decision is recorded

- **WHEN** a broadcast `FACT` is evaluated for a seat and does not wake it
- **THEN** the ledger records the entry, the seat, `rule` as the decider, and that it did not wake

#### Scenario: A letterbox decision is recorded with its verdict

- **WHEN** the letterbox is consulted for an entry and answers
- **THEN** the ledger records `letterbox` as the decider and the answer it gave

#### Scenario: A letterbox failure is recorded as a failure, not as a verdict

- **WHEN** the letterbox times out or cannot be run, and the entry wakes the seat by failing open
- **THEN** the ledger records that the decision came from the failure path
- **AND** it is distinguishable from a letterbox that answered "yes"

#### Scenario: A safety net decision is recorded

- **WHEN** the safety net reverses a declined entry
- **THEN** the ledger records `net` as the decider

### Requirement: A wake-up that produced a turn SHALL be recorded as such

A wake-up is not the cost; the turn it produces is. The two must be counted separately, because
the gap between them is exactly what tells us whether the gates are working.

The Stop hook and `sac wait` SHALL record when a wake-up was actually delivered to a session.

#### Scenario: An announced wake-up is recorded

- **WHEN** `sac wait` announces an entry to its session
- **THEN** the ledger records that this entry woke that seat

#### Scenario: A blocked turn is recorded

- **WHEN** the Stop hook blocks the end of a turn because of an unread entry
- **THEN** the ledger records that this entry held that seat's turn open

#### Scenario: A decision that never reached a session is not counted as a wake-up

- **WHEN** an entry is judged worth waking a seat, but that seat has no watcher armed
- **THEN** the ledger holds the decision without recording a delivered wake-up

### Requirement: Recording MUST NOT be able to fail a turn

Recording MUST NOT block, MUST NOT throw, and MUST NOT print; a failed append SHALL be dropped and
every caller SHALL proceed as if it had succeeded.

The ledger sits on the hot path of a hook that runs on every tool call and of the process that
holds the long poll. The rule that governs the heartbeat governs this. A measurement that can
break the thing it measures is worse than no measurement.

#### Scenario: An unwritable ledger changes nothing

- **WHEN** the ledger file cannot be written
- **THEN** delivery, waking and the turn proceed exactly as if recording had succeeded
- **AND** nothing is printed to the transcript

#### Scenario: A corrupt ledger is survivable

- **WHEN** the ledger contains an unparseable line
- **THEN** `stats` skips that line and reports the rest
- **AND** no caller fails because of it

### Requirement: The ledger SHALL be bounded

Measured precedent: one project minted about 27 seats an hour and grew a tool result past the
readable limit. A per-decision ledger grows faster than that. It SHALL have a ceiling in entries
or in age, applied oldest-first, and the ceiling SHALL be stated where the numbers are reported.

#### Scenario: The ledger does not grow without limit

- **WHEN** the ledger reaches its ceiling
- **THEN** the oldest records are dropped
- **AND** `stats` states the window its numbers cover

### Requirement: `sac stats` SHALL report what the bus cost

`sac stats [room…] [--since <duration>]` SHALL report, per room and on request per seat:

- entries written;
- how many were decided by the rule, by the letterbox, by the safety net, and by a declared quiet;
- how many wake-ups were delivered, and how many turns were held open by the Stop hook;
- characters delivered for reading, and how many were clipped.

#### Scenario: Reporting a room

- **WHEN** `stats team` is called
- **THEN** the output gives entry count, decisions by decider, wake-ups and characters delivered
- **AND** states the time window covered

#### Scenario: Reporting with no data

- **WHEN** `stats` is called on a store with no ledger
- **THEN** the command succeeds and states that nothing has been recorded yet
- **AND** does not create the appearance of a measured zero

#### Scenario: Reading never changes what is measured

- **WHEN** `stats` is called
- **THEN** no cursor moves, no entry is marked read, and no room's state changes
