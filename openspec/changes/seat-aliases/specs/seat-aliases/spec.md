## ADDED Requirements

### Requirement: An alias SHALL resolve to exactly one seat

A human name bound in the alias book SHALL be accepted wherever a seat is accepted as an addressee,
and SHALL be rewritten to exactly one seat before the entry is written. The send result SHALL
report each rewrite as `{ asked, seat, via }`.

#### Scenario: Alias bound to a Fleet label reaches the window holding the label
- **WHEN** "Studio Lead" is bound to the Fleet label `web-app-studio` and the live seat of session `S2` holds that label
- **THEN** `send` with `to: ["Studio Lead"]` writes an entry addressed to that seat
- **AND** the result's `resolved` names the alias, the seat and `via: "alias→label"`

#### Scenario: A replacement window inherits the alias through its label
- **WHEN** the window that held the label closes and a new session takes the same Fleet label
- **THEN** the same alias resolves to the new session's seat without being re-bound

#### Scenario: Ambiguity is refused, never fanned out
- **WHEN** an alias bound to a project resolves to two live seats
- **THEN** `send` fails and the error lists both seats with their Fleet labels

### Requirement: Alias names SHALL compare loosely

Case, diacritics, whitespace and punctuation SHALL be ignored when matching an alias.

#### Scenario: Accents and punctuation do not matter
- **WHEN** "Átjáró" is bound
- **THEN** `to: ["atjaro"]` and `to: ["ÁTJÁRÓ!"]` resolve to the same seat

#### Scenario: An alias may not shadow a real address
- **WHEN** someone binds an alias whose key equals an existing project name
- **THEN** the binding is refused, naming the project it would shadow

### Requirement: A Fleet label SHALL be an address on its own

A Fleet label from set-core's roster SHALL resolve to the seat whose session holds it, without
an alias. A missing or unreadable roster SHALL yield no labels and no error.

#### Scenario: Label without alias
- **WHEN** `to: ["web-app-assistant"]` names a Fleet label and no alias
- **THEN** the entry is addressed to the seat of the session holding that label

#### Scenario: No roster
- **WHEN** the roster file does not exist
- **THEN** seats and project names keep working and labels simply do not resolve

### Requirement: A window SHALL be able to name itself in plain words

The `alias` tool called with only a name SHALL bind that name to the calling window — to its Fleet
label when it has one, otherwise to its seat — and SHALL say which, and what that means when the
window is replaced.

#### Scenario: Binding this window with a Fleet label
- **WHEN** a window holding Fleet label `web-app-studio` calls `alias` with `name: "Studio Lead"`
- **THEN** the book maps "Studio Lead" to the label, and the result says it survives window replacement

#### Scenario: Binding this window without a Fleet label
- **WHEN** a window with no Fleet label does the same
- **THEN** the book maps the name to the seat, and the result says a replacement window must claim it again

### Requirement: Seats SHALL be listed with their names

`agents` SHALL show, per seat, its Fleet label (when any) and the aliases that resolve to it.

#### Scenario: Listing
- **WHEN** a seat holds a label and one alias points at it
- **THEN** its `agents` record carries `label` and `aliases`
