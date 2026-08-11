## ADDED Requirements

### Requirement: An unrecognised `SET_AGENT_COMM_*` variable SHALL be reported

Measured 2026-08-10: an agent trying to isolate a probe exported `SET_AGENT_COMM_HOME` — a
variable that does not exist. Nothing said so, the probe ran against the live store, and left a
room named `--help` behind. The defensive intent evaporated silently.

Any `sac` invocation SHALL, when the environment contains a `SET_AGENT_COMM_*` variable the
program does not recognise, print one line naming the unrecognised variable and the store
directory actually in use.

#### Scenario: A misspelt store variable is caught

- **WHEN** `sac` runs with `SET_AGENT_COMM_HOME` set
- **THEN** one line states that this variable is not recognised
- **AND** names the store path actually in use
- **AND** the command otherwise proceeds normally

#### Scenario: Recognised variables are silent

- **WHEN** `sac` runs with only `SET_AGENT_COMM_DIR` set
- **THEN** no warning is printed

#### Scenario: The warning does not corrupt machine-readable output

- **WHEN** a command whose output is parsed by another program prints this warning
- **THEN** the warning goes to stderr and the parsed output on stdout is unchanged

### Requirement: `--help` SHALL work on every subcommand

Measured: `sac send --help FACT "proba"` took `--help` as the room name, and the join-on-write
behaviour turned it into a room in the live store. A help flag that is silently a positional
argument is worse than no help flag.

`sac <subcommand> --help` SHALL print that subcommand's usage and exit without side effects.

#### Scenario: Subcommand help

- **WHEN** `sac send --help` is called
- **THEN** the usage line for `send` is printed
- **AND** nothing is written to the store

#### Scenario: A flag is never a room name

- **WHEN** a room argument begins with `--`
- **THEN** the command fails with a usage error
- **AND** no room by that name is created

### Requirement: The multi-room error SHALL suggest the room when it can be computed

Measured: 11 of the 18 failed calls in eight days were the same error — a project in several rooms
calling `send` without one. The error lists the rooms, and the callers still repeat it. Where the
answer is computable it SHALL be offered.

When `send` fails for a missing room and the entry carries a `to` that is a member of exactly one
of the caller's rooms, the error SHALL name that room as the likely intent.

#### Scenario: The addressee narrows it to one room

- **WHEN** a seat in `promo` and `atlas` calls `send --to consumer-b` with no room
- **AND** `consumer-b` is a member of `promo` only
- **THEN** the error names `promo` as the room that reaches this addressee

#### Scenario: The addressee is in several rooms

- **WHEN** the addressee is a member of more than one of the caller's rooms
- **THEN** the error lists those rooms and does not guess between them

#### Scenario: No addressee to narrow with

- **WHEN** `send` is called with no room and no `to`
- **THEN** the error lists the caller's rooms, as it does today

### Requirement: The MCP surface and the CLI MUST NOT drift

Both faces sit on one core so that they cannot disagree. Every error and every state introduced
here SHALL be reachable and identically worded through both.

#### Scenario: The same send failure through both faces

- **WHEN** a room that does not exist is used through the MCP `send` tool and through `sac send`
- **THEN** both fail, and both name the same rooms

#### Scenario: Presence through both faces

- **WHEN** a quiet seat is reported by the MCP `agents` tool and by `sac agents`
- **THEN** both report it as quiet
