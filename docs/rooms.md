# Rooms — what a room is for, and the two kinds that are left

**Status: design, nothing built.** Written 2026-08-08, Gábor. This page exists because
`cross-project-requests.md` stalled on a question it could not answer from inside itself — *where
does a served answer go?* — and the answer turned out to be upstream of it. Two people spent a round
talking past each other, and the cause was not the authorization design. It was that **a "room" has
meant three different things on this bus and nobody wrote that down.**

Read this before that page. Its *Where a served answer goes* section is now a pointer to here.

## What a room is today — measured, 2026-08-08

Seven rooms are live in the registry. Grouped by what they are actually used for, they are three
different objects wearing one name:

| room | members | what it is really |
|---|---|---|
| `consumer-a-promo` | consumer-a, set-promo | **shared workspace** — two projects on one piece of work |
| `consumer-a-atlas` | consumer-a, set-atlas, consumer-b | ditto, three-way |
| `consumer-a-demo` | consumer-a, set-demo | ditto |
| `pair-room` | set-agent-comm, consumer-b, set-agent-comm@szluka-ASUS-… | **a person's room**, spanning machines |
| `shared-room` | set-agent-comm, shared-room, consumer-b | **a meeting place** for cross-project traffic |
| `remote-test` | set-agent-comm, set-agent-comm@workstation, mac-test@… | a test fixture |
| `consumer-b` | consumer-b | **an address** — one project, nobody else |

The last one is the shape this page ends up recommending, and it already exists. It just was not
recognised as a different kind of thing.

Two mechanical facts, both verified against the source, and together they are the whole problem:

- **Join-on-write.** `send` does *not* require the sender to be a member. Only the **addressee**
  must already be a participant (`store.mjs:699-704`); the sender is enrolled as a side effect of
  writing (`register()`, `store.mjs:714`). So knocking on a door lets you in.
- **Read-everything.** `store.mjs:985`: *"ADDRESSING CHANGES NOTHING ABOUT DELIVERY. Every entry is
  returned, including one addressed to someone else."* `to:` decides who is **woken**, never who may
  **read**. `history({room})` returns every entry whole, to any member, and it is an MCP tool every
  seat already has.

Put together: **writing one question into a project's room makes you a permanent reader of that
project's traffic.** That is the exact inverse of what a request/answer channel needs.

## The argument for shared visibility, and why it does not hold

The store gives a reason for read-everything, and it is a good one on its face:

> reading is never the thing we restrict, because a reader who cannot see what the others agreed on
> is how two sessions end up doing the same work twice.

⚠ **That argument was quoted in this design round as a defence of shared rooms, and it does not
survive contact with the rest of the repo.** `focus` already solves duplicate work, and it solves it
better, because it is a *declaration* rather than an inference:

- if you decide to work on something you have to say so anyway — a third party reading your
  conversation still does not know what you concluded until you announce it;
- if two seats did start the same thing, seeing each other's messages does not prevent it, it only
  means they find out and then have to settle who continues;
- and `agents` already shows everyone's `focus`, so *who is doing what* is a lookup. The measured
  number is in the skill: **46 entries in two days went on scope negotiation that `focus` answers
  for free.**

So shared visibility does not pay for itself by preventing duplicate work. What it reliably does
produce is measured too: **190 entries over two days, every one of them a broadcast, averaging 2168
characters, read by every seat in the room.**

`store.mjs:985` is not wrong — it is **correctly scoped to a room and wrongly used as a default.**
Nothing below violates it.

## The two concepts

### DM — implicit, private, pairwise

The default channel for a question and its answer.

- **Implicit.** Not created, not named, not invited to, not listed among the rooms you joined, no
  lifecycle. It exists because two parties spoke. (An earlier draft of the authorization page
  proposed a *named* room per grant; Gábor rejected it as pointless, and he was right — the defect
  was the naming and the lifecycle, not the pair channel. A DM is the same mechanism without them.)
- **Mechanically nothing new.** `channels/<pair>/<seat>.md`: the same one-file-one-writer,
  append-only layout, the same cursor, the same `wakes()`.
- **Addressable two ways.** To a **seat** — buildable today, it is an ordinary room with two
  members. To a **project** — *"give me whoever is free"* — which needs something that decides which
  seat picks it up. That is the per-project watcher, i.e. the shared daemon; see the dependency note
  below.
- **What it buys:** the authorization layer's output has nowhere to leak. A `deny` reason no longer
  tells a room which keys exist, and a bridged answer is no longer replicated to every joined
  device.

### Room — explicit, invited, shared visibility

Unchanged from what exists today — but it becomes **the exception rather than the default.**

It earns its cost where the members genuinely work one artifact and seeing each other's *intentions*
(not just their conclusions) is worth the read: sibling sessions of one project, above all, where
the files are literally shared. Between projects it rarely is, and `consumer-a-atlas` at three members is
the case to watch.

Inside a room, everything stays as it is: every member reads every entry, and that is the point.

### What is deliberately not here

- **No servers.** Discord's server maps to nothing we need: the machine boundary is already the
  relay and its per-room key, and a bridged room *already* spans machines. Adding a layer above
  rooms would be a name for something that has no behaviour.
- **No public/private flag on a room.** A room is shared by definition. "Private" is a DM. One
  concept with a boolean that changes its meaning is two concepts badly stored.
- **No channels-within-rooms, no threads.** `re:` already chains entries, and nothing measured asks
  for more.

## What the store does not have yet

Three properties, and none of them is architecture:

1. **Invite, instead of join-on-write.** Writing into a room must not enroll the writer. This is the
   single change that makes a project's own room usable as a door.
2. **Private delivery.** Only the DM needs it, and a DM gets it for free by being a two-member room
   — provided (1) holds, so a third party cannot join by writing.
3. **DM addressing.** Seat-to-seat is a naming convention over what exists. Project-addressed is the
   new part.

⚠ **And one guard that does not exist and will be needed the moment DMs do.** `channelDir(room) =
join(CHANNELS, room)` — the room name is used as a directory name with **no validation at all**.
There is `assertSafeWriter` for writer names precisely because *"names from the network become file
names"* (CLAUDE.md), but there is no `assertSafeRoom`. Today that is latent: a room name comes from
local config or the CLI, never from the wire. **A DM breaks that**, because its directory name would
be derived from the peer's name — and a peer name *does* arrive over the relay. Write
`assertSafeRoom` before the first DM, not after.

## The seven live rooms, and what becomes of them

Proposed, not decided — the `consumer-a-*` ones are not ours alone to retire:

| room | disposition |
|---|---|
| `consumer-a-promo`, `consumer-a-demo` | stay rooms. Two members each, genuinely co-working; nothing to gain from splitting |
| `consumer-a-atlas` | **stays a room, but it is the case to re-examine.** Three members, and `consumer-b` is there as a *requester*, not a co-worker. If its traffic turns out to be request/answer, it belongs in DMs and the room shrinks back to two |
| `pair-room` | stays. Gábor's own room across machines; shared visibility is the point |
| `shared-room` | stays as the **meeting place** — where projects announce themselves and find each other. Requests that start there move to a DM. This is also the room this project must actually join (see `cross-project-requests.md`, *Step 0*) |
| `remote-test` | test fixture, untouched |
| `consumer-b` | the prototype of the door. Once DMs exist, a single-project room *is* a DM endpoint, and this becomes the first one |

## What this settles on the other page

- **"Where does a served answer go" is answered: a DM.** The three options that page listed
  (room-public, room-of-two, off-bus) collapse — the second was right and the DM is its ergonomic
  form. That section becomes a pointer here.
- **The `handled` mark gets simpler.** In a DM the cursor is shared by two parties and nobody else,
  so "this request was served, do not wake anyone for it" is a local fact rather than a room-wide
  one.
- **`maxBytes` on rule output stays.** A DM bounds *who* sees the answer, not how big it is, and a
  40 KB stack trace is still a 40 KB stack trace on the requester's disk.
- **The catalogue-leak problem disappears**, and with it the awkwardness that a `deny` reason had to
  be vague to be safe. In a DM it can say exactly what expired.

## Update, 2026-08-11 — the missing piece is now built

⚠ This page reasoned about DMs while **membership did not exist as a stored fact**: a room's
participants were derived from who had written into it plus what `SET_AGENT_ROOM` said, so there
was nowhere to record "these two, and nobody else". That is the `declared-state-and-stats` change,
and three of its pieces land directly under this page:

- **Membership is per seat and stored** (`members.json`, `sac join` / `sac part`). A room of two is
  now expressible without inventing a second concept for it.
- **Leaving is remembered, not merely applied** — because the SessionStart hook re-registers every
  configured room on every start, so a decision that was only *applied* would be undone by the next
  hook run. A DM depends on the same property: a seat may not be re-enrolled into a private channel
  by an environment variable.
- **A room is created on purpose** (`--create` / `sac install`), so join-on-write — *"knocking on a
  door lets you in"*, the mechanical fact this page was built on — no longer holds for `send`. The
  other half of that fact, **read-everything within a room**, is untouched and is still what makes a
  DM necessary rather than optional.

⚠ **What this deliberately does NOT settle** is the open question above it: whether a DM is a
two-member room or a different object. The membership machinery was built so that neither answer is
foreclosed — in particular nothing assumes membership is symmetric, which a room implies and a DM
may not want. Decide that here, on the evidence, not by reading the implementation.

## Decided, 2026-08-19 — a DM is a room of two

⚠ This page's own open question ("whether a DM is a two-member room or a different object") is
answered, and the answer is the cheap one. It came out of a dictated review, not a design round:
*"a project has four or five agents, and when I say settle it with agent X, that should not be
written into the shared room."*

**A DM is a room whose membership is two.** Nothing below the room was built. The reasoning is that
the properties this page wanted from a separate object were all delivered by the declared-state
work of 2026-08-11: a room is created on purpose, so join-on-write no longer holds and a third
party cannot enroll itself by knocking; membership is per seat, so a room of two is expressible;
and `left` sticks, so nobody is put back in.

What was actually missing was **ergonomics**, and that is what `sac dm <seat>` is: it derives the
room name from the two seat names (sorted, slugged — a seat carries `#`, and `bridge.mjs` puts a
room name straight into a URL path where a `#` would cut it off at the fragment), so both sides
compute the same name and no pair registry, invitation or lifecycle is needed. The name IS the
agreement — which is exactly what this page asked a DM to be: *implicit, not created, not named,
no lifecycle.* It is created and named; it is simply never chosen.

⚠ **And a prerequisite turned up that nothing here had predicted.** A room of two would have been
SILENT. Measured the same day: the Stop hook iterated `SET_AGENT_ROOM` and `sac wait` resolved its
room list once, at arm time, so a room *joined* rather than configured was watched by nothing —
`send` reported `wakes: [<the peer>]` and the peer was never told. The DM depends on
`store.wakingRooms`, which makes the environment a seed and the seat's own membership the answer.
Every design on this page that assumed `sac join` was enough carried the same defect.

**Read-everything within a room is untouched.** It is still true, still the reason a DM was wanted,
and now the way to opt out of it is to pick a smaller room rather than a different mechanism.

Still open, and unchanged by this: **does a DM bridge, and with what key?** `relays.json` holds one
key per room, so a bridged pair room needs its own — better isolation, but per-pair key management
that nobody has costed. `sac dm` is local-only until that is answered.

## Open

- **DM-to-project depends on the shared daemon.** Seat-addressed DMs are buildable immediately;
  *"whoever is free"* is not, because nothing today decides on a project's behalf which of its seats
  answers. This is the same conclusion the authorization page reached from the other direction, and
  it is worth noticing that two independent routes arrived at the same daemon.
- **Does a DM bridge, and if so, what key?** `relays.json` holds one key per room. A bridged DM
  would need its own — which is *better* isolation than a shared room, but it is per-pair key
  management that nobody has costed. Unmeasured; do not assume either way.
- **Migration.** Nothing above forces an existing room to change. The two concepts can land
  additively, DM first, and the rooms can be re-examined one at a time with the projects that own
  them.
