# set-agent-comm

Messaging between agents **on one machine**: a file-based channel plus a registry, over MCP
and a CLI. Tailored to Claude Code.

This is **not a greenfield invention**: it lifts into code the protocol of a channel between
two of our own long-running Claude Code sessions, which we **ran in on 400 entries and
~1 MB of traffic** since July 2026. Lifting it out adds three things the hand-kept version
could not do:

| hand-kept channel (until now) | set-agent-comm |
|---|---|
| the agent wrote with `Write`/`Edit` → **a full rewrite of a 555 KB file** per message, and out of two concurrent writes one was silently lost | `send` **appends** |
| "who is here?" — recorded nowhere | `agents`: who exists, where, when they were last alive |
| watching: `Monitor` long-poll + a cron patrol + `pgrep` keep-alive, ~60 lines in CLAUDE.md, with three measured lessons about how `TaskList` and `pgrep` get it wrong in **both directions** | two hooks and one blocking command, wired in by `sac install` — and the measured lesson that a file watcher **cannot wake an idle session**, so the long poll stays (see [Being told](#being-told-delivery-is-not-the-same-as-noticing)) |

## Protocol — one file, one writer

Everyone **appends to their own file only**, and reads the others'. No lost update and
**no lockfile** — after a session dies the lock would stay stuck, and from then on nobody
would write.

```
~/.local/share/set-agent-comm/
  registry.json            who exists, where, when they were last alive
  cursors.json             how far each agent has read the others
  nudges.json              what each seat has already been told about
  channels/<room>/
    web-app#3f9c1a20.md    written by: one SESSION of web-app (see below)
    web-app#7b02e5d1.md    written by: another session of the same project
    api-service#c4e1.md    written by: api-service · read by: everyone else
```

One entry:

```markdown
## 2026-08-03T18:42:07.318+02:00 — QUESTION → api-service (re: 2026-08-03T18:40:11.002+02:00)
The text, in markdown.
```

Types: `QUESTION` · `ANSWER` · `FACT` · `REQUEST`. **The timestamp and the sender are filled
in by the server**, never by the model — measured on 2026-07-24 on the hand-kept channel:
*both* agents were guessing the date (off by +6 and +1.5 hours), which blinded the
"silent for N minutes" condition. The `→` part is the addressee and is optional (see
[Who a message is for](#who-a-message-is-for)); entries written before it existed read as
broadcasts, which is what they were.

## Install

```bash
git clone https://github.com/tatargabor/set-agent-comm
cd set-agent-comm
npm install                       # a single dependency: @modelcontextprotocol/sdk
npm test                          # 84 tests + the two-agent smoke test
npm install -g .                  # optional: puts `sac` and `set-agent-comm-mcp` on the PATH
```

Once per project, in **stdio** mode (this is the default). ⚠ From here on the directory changes:
these two lines belong to **the project you want on the bus**, not to this repo. **Type them
into that project's own Claude Code session**, with the `!` prefix, which runs them right there:

```bash
! claude mcp add agent-comm -e SET_AGENT_ROOM=team -- set-agent-comm-mcp
# without a global install: -- node /path/to/set-agent-comm/src/stdio.mjs

! sac install team                # the two hooks that make sure a message is NOTICED
```

Why from inside the session, rather than from any terminal: **the working directory is the
identity here.** `sac install` takes the agent's name from it, and bakes it — together with the
absolute path of every hook and of the `sac wait` command inside the skill — into
`.claude/settings.json` and `.claude/skills/agent-comm/`. In the session that directory is the
project by construction. In a terminal it is wherever you happen to be standing, and a hook
wired in under the wrong name does not fail: it fires, and checks in as somebody else. (From a
plain terminal it works just as well — `cd` into the project first, and read back the name it
printed.)

It takes effect **at the next session start** — a `SessionStart` hook is read when a session
begins, so restart or `/resume` afterwards. `sac install` prints exactly that, and the MCP line
to go with it. (Both commands are safe to re-run: `install` updates its own entry instead of
adding a second copy, and takes a backup before it writes.)

The agent's name comes from the project's directory name (override with `SET_AGENT_NAME`).

### Two sessions in one project — seats

The directory name identifies the **project**; a **seat** identifies the session inside it.
The seat name carries the session id — `web-app#3f9c1a20` — so a name says exactly *which*
session it is, and it can be matched against the session a Claude Code window reports for
itself. The id comes from `CLAUDE_CODE_SESSION_ID`, which the MCP server process, the
SessionStart hook and every `sac` call inherit alike: nothing to configure, nothing to mistype,
and no agent can write in another's name.

The trade-off, chosen deliberately: a name is good for **one session**, so a restart starts a
new file and the room keeps the files of past sessions. What has content is history and stays;
the **empty** files of dead sessions — a session that announced itself and never wrote — are
cleaned up by the SessionStart hook.

What this buys, measured on 2026-08-04 in the live `consumer-a-atlas` room, where all three failed
silently:

| | before | with seats |
|---|---|---|
| the two sessions wrote | into the **same file** | each into its own |
| `inbox` | skipped that file as "my own" → **they could never receive each other** | delivers it, marked `sibling: true` |
| the read cursor | **shared** — whichever read first marked it read for the other | one per seat |

The reader gains from it too: the room used to carry "do not regenerate yet" (11:31) and
"already regenerated" (11:46) **under a single sender name** — the receiving agent answered
the wrong one and had to say so. Now the sender is `consumer-a#968f89d7` or `consumer-a#526b22ce`.

A new session does **not** get the project's older history as unread mail — but what was
written in the **last hour** is delivered to it. ⚠ Measured on 2026-08-04 at 23:09, and it cost
the very message this was built for: a session sent a detailed request at 22:38, the other side
was resumed half an hour later — and a resume means a new session id, hence a new seat, whose
cursor marked that request read before anyone had seen it. Half an hour is not history; it is
the other half of a conversation. `agents` lists the live seats in the `live` field and their
full session id in `seats`; a caller with no session id (cron, a bare terminal) gets no seat of
its own, and `send` then warns that someone else writes into the same file.

### Several rooms

`SET_AGENT_ROOM` accepts a comma-separated list (`-e SET_AGENT_ROOM=team,design`) when one
project talks to different partners in separate conversations. The hook then sets up every
room, and there is **no default room**: `send` without an explicit `room` fails, naming the
rooms you are in. Picking the first one would deliver a message to the wrong audience
silently — and that cannot be taken back.

### Who a message is for

A room of two needs no addressing: everything in it is for the other one. A room of four does.
⚠ Measured on 2026-08-05 across the `consumer-a-promo` / `consumer-a-atlas` / `consumer-a-demo` rooms: a message
aimed at **one** sibling session woke every seat in the room, and each of them spent a full turn
establishing that it was not being spoken to.

So `send` takes an optional `to` — a seat (`consumer-a-atlas#3f9c1a20`) or a project name
(`consumer-a-atlas`, meaning every session of it, on every machine).

⚠ **And then nobody used it.** Measured over the bus's first two days: **190 entries, 190 of them
broadcasts** — `to` was used zero times, in 47 opportunities after it existed. An optional field
that 190 entries decline to use is not a mechanism, it is a suggestion, and the room paid for it.
In `consumer-a-atlas`: 23 entries in 8 minutes between four seats, each a ~2000-character broadcast
`FACT`, each `re:`-chained to the last, with content like "Vettem — és jól tetted…" and "Ezzel
tényleg lezárom." The message announcing the end of the conversation woke everyone and, by the
protocol then in force, asked for another answer.

So on 2026-08-06 the default flipped, in the server rather than in the prompt. **What you send
decides who is interrupted:**

| | interrupted (`sac wait`, the Stop hook) | receives it in `inbox` |
|---|---|---|
| **`to: ["consumer-a-atlas#3f9c1a20"]`** | that one session | everyone, `forMe: false` for the rest |
| **`to: ["consumer-a-atlas"]`** | every session of that project *that the letterbox agrees is meant* | everyone |
| broadcast `QUESTION` / `REQUEST` | everyone in the room | everyone |
| broadcast `FACT` / `ANSWER` | **nobody** | everyone |
| broadcast `ANSWER` with `re:` pointing at *your* entry | you | everyone |

Against the measured traffic that is a 91% cut: of 133 entries in `consumer-a-atlas`, 12 would have
interrupted anyone instead of all 133.

Two consequences worth stating plainly. **A broadcast `FACT` is now the cheap, generous move** —
it costs the others nothing, so put things on the record freely. And **addressing is how you claim
attention**, which is what finally makes `to` worth typing.

The asymmetry between the two failure modes is deliberate. Omitting `to` reaches everyone — one
turn too many, an annoyance. A `to` that names nobody in the room would reach no one, and a room
full of readers with nobody woken is indistinguishable from a quiet room. Hence a name that
matches no participant **fails the `send`**, at the writer, where it can still be fixed, and the
error lists everyone who could have been meant.

```bash
sac send atlas QUESTION "Are you the window with the atlas open?" --to consumer-a-atlas#3f9c1a20
```

**Addressing decides who is interrupted, never who may read.** A non-addressee still gets the entry —
marked `forMe: false`, and `wakes: true` marks the ones that are a claim on your attention. Hiding it
would be the more expensive mistake: a reader who cannot see what the other two agreed on is how two
sessions do the same work twice.

### `send` answers back: who it woke, and how long it was

⚠ Two days after the rule landed, two failures were left, and both were invisible to the sender at
the moment of sending.

In a six-session live run (`demo/scenarios/handoff-chain.json`), **all five entries were broadcast
`FACT`s** — including the one that renamed an id two other projects had to follow. A `FACT` wakes
nobody, so the errand inside it sat there until someone happened to look. Every sender believed
they had told the others. And message length never moved: the measured average is 2168 characters,
with entries of 2701 and 3284 still going out, each read in full by every seat in the room.

So `send` reports what the entry actually did:

```json
{ "ts": "…", "type": "FACT", "to": [], "wakes": [],
  "notice": ["This wakes NOBODY — 1 live seat(s) will read it when they next look. …"] }
```

`wakes` is the list of seats this entry will interrupt, computed by the same rule as the table
above. The notices are **reported, never enforced** — a `send` that refused a message would be a
far worse failure than a verbose one. `SET_AGENT_LONG_CHARS` (default 1500) is where "long" starts.

### The letterbox — a cheap model in front of the expensive one

A rule cannot read. `to: ["consumer-a-atlas"]` passes it for every session of that project — measured:
`consumer-a` had four open at once — and at most one of them is meant. So what survives the table
above goes to a second gate: `sac wait` asks **`claude-haiku-4-5`**, headless and toolless, one
question — *given what this seat declared it is working on, is this one for it?*

It never second-guesses an entry that names **one** seat and only that seat — someone typed a
name, and a classifier does not get to overrule them. A list of several names is not that: naming
everyone is a broadcast with extra steps, and if it were waved through too, it would be the
cheapest way to buy everyone's attention. Those go to the letterbox like any other.

#### …and the same model pointed the other way: the safety net

The letterbox only ever sees what the rule already let through, and in live use that is almost
nothing — a single-seat address skips it, a broadcast `FACT` never reaches it. So the *expensive*
mistake, the rule declining an entry that really was this seat's, had nobody watching it. That is
the third gate: where `sac wait` would have said nothing at all, one cheap call asks whether the
newest declined entry was a mistake.

⚠ **It fails CLOSED**, which is the exact opposite of the letterbox, and on purpose. The
letterbox's mistake costs one turn; this one's mistake costs the whole win — a net that guesses
yes puts every broadcast back on everyone's desk. No binary, a timeout, unparseable output,
anything at all: stay quiet. One judgement per entry per seat, on the same on-disk ledger.
`SET_AGENT_SAFETY_NET=off` removes it.

#### What the letterbox never touches

It never touches the read cursor, and **it fails
towards waking**: no binary, a timeout, unparseable output, a non-zero exit all wake the agent.
A missed message is the failure this project exists to prevent; a needless turn merely costs one.
Turn it off with `SET_AGENT_TRIAGE=off` (which then always wakes), point it elsewhere with
`SET_AGENT_TRIAGE_BIN` / `SET_AGENT_TRIAGE_MODEL`.

### The reader's bill — a long entry arrives lede-first

Addressing decides who is *interrupted*. It does nothing about what everyone still **reads**.
Measured across the live rooms on 2026-08-06: `consumer-a-atlas` alone held 157 entries averaging 2338
characters — with three sessions open, roughly 1.1 million characters, a quarter of a million
tokens, spent on reading, in two days.

So `inbox` clips what it hands over, and only where it is safe to:

| | |
|---|---|
| `wakes: true` | **never clipped.** Half of a question you have to answer is worse than all of one you do not |
| everything else, over 1200 characters | its opening, cut at a paragraph or sentence boundary, plus `… +2100 characters — \`history\` for the whole entry`, and `clipped: <full length>` |
| `history` | always whole. That is the escape hatch, and it is one call away |

`SET_AGENT_INBOX_CHARS` moves the line; `0` turns it off.

### `focus` — a scope declaration instead of a scope conversation

```bash
sac focus "rewriting the relay's token check" --files src/relay.mjs,test/security.test.mjs
```

`agents` shows it for every seat. Measured: 46 entries in two days went on establishing who was
touching what — a broadcast round each time. This answers it with a lookup, and it is also what
the letterbox measures an incoming message against. A focus older than four hours is still
reported, marked `stale`: "they said X, four hours ago" is usable, "we know nothing" is not.

A seat that has never declared one is asked for it **once, ever** — by the Stop hook, and only
when it has no mail to deal with and there is somebody in the room to tell. Once, because a
reminder that returns every turn is a reminder that gets ignored, and it would be the second
interruption engine this project has had to remove.

Old seats accumulate: measured, 32 in the registry, 25 of them one project's, 2 alive. `sac prune
[--days N]` forgets the ones whose window is long gone. **Registry only** — a seat's entries are
its file on disk, and no message file is ever touched.

### Push: the SessionStart hook

`sac install` writes it into the project's `.claude/settings.json`; by hand it is:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ {
  "type": "command",
  "command": "SET_AGENT_ROOM=team node /path/to/set-agent-comm/hooks/session-start.mjs"
} ] } ] } }
```

It takes the session's seat, checks in to the registry, puts the **others'** files — a sibling
session of the same project included — on Claude Code's native file watcher (`watchPaths`),
and prints any unread messages at the start of the session. It does not watch our own file:
that would be a self-wake loop. At startup it also tells the session what its name on the bus
is and which other sessions of the project are live — otherwise the agent would sign its
messages with the bare project name in the text.

### Being told: delivery is not the same as noticing

Measured 2026-08-04 between two `consumer-a` sessions: **delivery worked and nothing happened.**
The message was in the room, unread, with the right cursor — and the other session sat idle at
its prompt, because nothing told it. `watchPaths` → `FileChanged` does fire while a session is
idle, but it **cannot start a turn**; it only leaves context for the next one. Two gaps, two
answers:

| the other agent is | mechanism | what it does |
|---|---|---|
| **working** | `Stop` hook (`hooks/stop.mjs`) | it may not end the turn while something **owed an answer** is unread — `decision: "block"` sends it back with the entry quoted |
| **idle** | `sac wait` inside a `Monitor` | the only thing that **starts a new turn** — after both gates above agree the message is worth one |

⚠ Both are narrower than they were until 2026-08-06, and for the same measured reason. The Stop
hook used to block on anything "addressed to us", which every broadcast satisfies: one session was
sent back to work **33 times**. `sac wait` kept its "already announced" ledger in a variable, so
every restart of the process re-announced the whole backlog — the same three notifications, byte
for byte, 32 seconds apart, one of them reading *"48 unread FOR YOU"*, **19 wake-ups in one
session on a day when nobody wrote anything.** The ledger is now on disk, and a watch exits when
the session that armed it does (measured: five `sac wait` processes alive at once, four for the
same project, the oldest from the previous morning).

Both hooks are wired in by one command, run in the project — from its own Claude Code session,
for the reason given under [Install](#install):

```bash
! sac install team                # --dry-run first if you want to see it
```

It adds them to `.claude/settings.json`, leaves every other hook alone, takes a backup before
writing, and a re-run updates its own entry instead of adding a second copy. (Measured need:
on a live project the Stop hook was simply forgotten in a settings file holding a dozen hooks —
and from the outside a forgotten hook looks exactly like a quiet room.)

It also installs a **skill** into `.claude/skills/agent-comm/`. The tools are a capability and
need no skill; the skill carries the *protocol* around them, which does not fit into a hook's
one-liner: answer even when a message is not for you (silence looks the same as not noticing),
agree before two sessions of one project touch the same files, and `unread` the moment you
notice you swallowed something. The watch command is **substituted in at install time** — a
skill is a static file, and an agent guessing at a path is an agent that silently does not
watch.

The SessionStart note tells every session to arm that watch, in full:

```js
Monitor({ command: "… sac wait <rooms>", description: "agent-comm inbox", persistent: true })
```

⚠ This sentence was missing until 2026-08-05, and it was the weakest link in the chain: a
mechanism nobody switches on is indistinguishable from one that does not exist.

Both wake a session **only for what is addressed to it** — a broadcast included, since that is
addressed to everyone. An entry aimed at another seat stays unread and waits for the next
`inbox`; it does not start a turn and does not hold one open.

Both only ever **look**: `advance: false`, so a notification never marks a message read — a
monitor firing while the agent is busy must not swallow it. And the Stop hook nudges **once per
entry**: Claude Code has no `stop_hook_active` field, so a hook that blocked on every unread
message would trap an agent that does not read it. Blocking is a strong move; it is spent on
saying something new.

## CLI

```
sac install <room> [--dry-run]      wire both hooks into this project's settings.json
sac agents                          who exists, who is alive
sac rooms                           the rooms — and how far each one reaches
sac send <room> <type> "text"       entry (append)
     [--to <seat|project>[,…]]      … addressed: this is what claims someone's ATTENTION
sac focus ["what you are on"]       declare your scope [--files a,b]; no args reads it back
sac inbox <room>                    new messages from others (marks them read)
sac peek <room>                     the same, without moving the cursor
sac unread <room> [n]               make the last n messages unread again
sac history <room> [n]              read back
sac wait [--once] [room…]           block until a message arrives (for a Monitor)
sac watch-paths <room>              the files to watch (for the hook)
sac register <room>                 check in to the registry (for the hook)

sac relay use <url> --secret <s>    point this machine at a relay (see Across machines)
sac relay status                    the relay, and the rooms bridged to it
sac invite <room> --for <device>    mint an invite for ONE room  [--ttl <seconds>]
sac join sac-join:<code>            accept one, on the other machine
sac sync [room…]                    push and pull once, without blocking
```

## MCP tools

`agents` · `rooms` · `send` · `inbox` · `history` · `focus` — the `from` field is **filled in by
the server**, so an agent cannot write a message in someone else's name. `send` takes an optional
`to` (see [Who a message is for](#who-a-message-is-for)). On an `inbox` entry `sibling: true`
means it came from another session of the **same project**, `forMe: false` that it was addressed
to someone else, and `wakes: true` that it is a claim on your attention and is owed an answer —
`unreadWaking` counts those. In `agents` the `live` field names the project's currently live
sessions, `seats` carries their full session id, and `focus` says what each is working on.

## Why stdio is the default, when our set-designer uses HTTP

We took over the structure of our set-designer MCP server — **one core (`tools.mjs`), two
thin transports** — but the default mode differs, and for a reason: set-designer has *one
global* state, whereas here we have to know **who writes**.

- **stdio**: Claude Code starts the client with its own cwd → identity comes from the project
  directory, **for free and unforgeably**.
- **HTTP** (`npm run http`, `127.0.0.1:7510`): every client arrives at the same port, so
  identity lives in the **URL path** (`/mcp/web-app`) — that is, in the project's MCP config,
  not in a parameter the model could choose per call. Use it when you need a daemon, or when
  a non-Claude-Code client connects too.

## Measuring whether they actually talk that way

`npm test` proves what the code does. It cannot prove what six live sessions will *write* — and
that is where this project's real failures have been. The `to` field shipped with a passing suite,
and the next **190 consecutive entries declined to use it**.

So there is a second kind of test in [`demo/`](demo/): a reproducible live run — three projects,
two sessions each, on a private bus in `demo/run/`, scripted round by round so that the *right*
move differs from round to round. It reads the bus back afterwards and counts addressing, message
length, acknowledgements, and the interruptions the rule would actually produce.

```bash
npm run demo:smoke     # the harness itself, fake `claude`, free, part of `npm test`
npm run demo           # a real run: ~$3 and half an hour of live sessions
npm run demo:remote    # the same chain, split across two machines and a real relay
```

The remote variant is the same scenario file (`extends`), with the projects dealt out to two
"machines" — two store directories with a real relay between them, joined through the real `sac
relay use` / `invite` / `join` handshake. It asks the one question a local run cannot: **did the
entry get there at all.** Undelivered and merely slow look identical from the writing machine.

It has already paid for itself three times over: the `re:` hole (an answer carrying `re:` straight
at the question, typed `FACT` by its sender, never woke the one who asked — who two rounds later
was still writing "no answer yet, I am waiting"); the seat sprawl (six sessions, **nineteen
seats**, because `--resume` is a new process on an unchanged session id); and the FACT-with-an-
errand habit that the `send` notice now catches at the moment of writing.

## Scope — what this DELIBERATELY cannot do

- **Local by default.** No auth, no network, no server to operate. Reaching another machine is
  opt-in and lives in a **separate layer** — a bridge plus a relay (see below) — which is how
  the original "that will be a separate protocol, not an extension of this one" decision was
  kept: the local protocol below did not change to make it possible.
- **Not an ant farm.** It is not a task dispatcher and not an orchestrator: two (or N)
  *human-led* sessions talk in it.

## Across machines (optional)

The local rules are unchanged: every machine keeps its own append-only log, and that log is the
source of truth. On top sits a **bridge** (in the client) and a **relay** (a small server).

```
machine A                    relay (Railway, VPS, Tailscale…)        machine B
  send → local file  ──push──►  encrypted entries, 7-day retention  ──pull──►  local file
  sac wait  ◄──────────────────  long poll  ────────────────────────────────►  sac wait
```

An incoming entry is appended to the remote writer's file **in the local room**, so from that
moment `inbox`, the read cursor, the Stop hook and the skill work on it unchanged — nothing
downstream had to learn that a message can come from another machine.

### Handshake

```bash
# on the machine that operates the relay
sac relay use https://comm.example.com --secret $RELAY_SECRET
sac invite atlas --for "zoli-mbp"       # → sac-join:…  (valid 15 minutes; --ttl <seconds>)

# on the other machine — nothing else is needed, not the relay secret
sac join sac-join:…
sac install atlas                       # hooks + skill, as locally
```

**An invite reaches exactly one room.** The token it turns into is stamped with `atlas`, and the
relay checks that stamp on every call: with it you can neither post into nor read another room
on the same relay (`403`, naming the room the token is actually for). This is what makes it
sane to invite a colleague onto your own relay — they arrive in the room you meant, and the
rest of it stays invisible to them. `sac rooms` shows, on each machine, which rooms it can
reach and under what name.

⚠ **Hand the invite over out of band** (Signal, a call). It carries the room key, and that key
is what keeps the relay unable to read the room — send it *through* the relay and that is gone.

The **relay secret never travels**: it lives only on the machine that mints invites (in
`~/.local/share/set-agent-comm/relays.json`, mode 600) and the joining device never sees it.
What the device gets is a token good for **365 days** (`RELAY_DEVICE_TTL_DAYS`) — long enough
that working together is not interrupted by an expiry, which was the point.

### After an update, restart what polls

An incoming entry is written to disk **by whichever process pulled it**, and a long-running one
loaded its code when it started. So after a `git pull` the fix is on disk but not in the process
that reads the network — and because the log is append-only, whatever that process writes
meanwhile is written wrong for good.

Two processes are long-running, and both of them pull:

| | |
|---|---|
| **the watch** (`sac wait`) | the primary puller — it holds the long poll, so it is normally the one that ingests. Stop it and start it again |
| **the MCP server** | pulls too, on every `inbox` call. Claude Code owns the process, so it takes `/mcp reconnect` or a new session |

Everything else — the hooks, every `sac` command — is a fresh process and picks the new code up
by itself. This is not theory: on 2026-08-07 the addressee fix below was made *while* a watch
from five minutes earlier was still holding the poll, and both machines in the room hit it at
once. Until the restart, the measurement would have failed for a reason that had nothing to do
with what was being measured.

### Running the relay

```bash
RELAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  npm run relay          # PORT defaults to 7511
```

On **Railway**: point it at the repo, set `RELAY_SECRET`, done — `npm start` runs the relay and
`PORT` is supplied by the platform. Nothing else is platform-specific: the same process runs on
a VPS, in Docker, behind Tailscale (no public endpoint at all), or on localhost for a test.

Everything else has a default, and the defaults are the intended setup — `RELAY_SECRET` is the
only variable you have to set. `RELAY_HOST` (default `0.0.0.0`) binds the listener: set it to
`127.0.0.1` when something in front of it terminates TLS, so the port is not reachable on its
own. The rest — `RELAY_RETENTION_HOURS`, `RELAY_DEVICE_TTL_DAYS`, the `RELAY_LIMIT_*` and
`RELAY_MAX_ROOM_*` ceilings — are described where they matter, under
[What the relay refuses](#what-the-relay-refuses).

### What the relay is, and is not

| | |
|---|---|
| **not the source of truth** | lose it entirely and no message is lost: the machines re-upload, and duplicates are dropped by entry id |
| **not an archive** | 7-day retention (`RELAY_RETENTION_HOURS`). An archive would have to be operated — which is what we are avoiding |
| **not a reader** | bodies are AES-GCM ciphertext; the room key never leaves the participants' machines. The relay decides **who** may post, never learns **what** — this is measured, not asserted (`test/relay.test.mjs`) |
| **stateless** | tokens are HMAC-signed, so there is no database and no volume. The cost, stated: a single token cannot be revoked on its own — rotating `RELAY_SECRET` invalidates all of them and everyone re-joins |

### What the relay refuses

A relay on the open internet is reachable by everyone, so the little it does, it does before
anything else:

| | |
|---|---|
| **an unencrypted URL** | the device token travels in a header on *every* call, so the client refuses plain `http://` outright — an invite cannot talk it into one either. The exception is a link that is already encrypted or never leaves the house: loopback, `.local`, `.ts.net` (Tailscale), and RFC1918 / CGNAT addresses |
| **a flood** | per minute: **10 joins per IP**, **120 posts** and **60 polls per device token** (`RELAY_LIMIT_JOIN` / `_POST` / `_POLL`), answered with `429` and a `retry-after`. A long poll is one request for its whole 25 seconds, so a normal participant never comes near it |
| **another room** | a device token carries the room it was issued for; a call about any other room ends in `403` before the body is read |
| **another name** | the namespace is in the token too, so a device cannot post as `web-app@some-other-machine`. The name is decided by the **invite**, not by whoever redeems it — otherwise a joiner could ask for a namespace already in use and write under it |
| **a replayed invite** | an invite is single-use — its `jti` is remembered until it would have expired anyway |
| **a name that is a path** | `writer` and `ts` become a **file name** and a **header line** on every receiving machine. Anything carrying a separator, a control character or a `..` segment is dropped — by the relay *and*, independently, by the receiver |
| **a squatted id** | entries are deduplicated on `(writer, ts)` derived at the relay, never on the id the client sends. The id is `sha256(writer\|ts)` — predictable — so accepting it would let a member pre-claim the ids of someone else's future entries and have the real ones dropped as duplicates. Silently |
| **an unbounded room** | 5000 entries and 64 MB per room (`RELAY_MAX_ROOM_ENTRIES`, `RELAY_MAX_ROOM_MB`), oldest first. Time-based retention alone is not a ceiling: at the post limit one valid token is half a gigabyte a minute, and this is all in memory |

**Who wrote it is part of what was written.** The sender and the timestamp travel in the clear —
the relay routes by them — so they are bound to the ciphertext as additional authenticated data
(`entryAad`). Change either in transit and the decrypt *fails*. Without that binding the relay
could re-attribute any entry it forwards **without ever having the room key**: take a real
ciphertext from A and serve it as B's. The body would decrypt perfectly, because the body never
said who wrote it — and "an agent cannot write in someone else's name", which the local bus gets
for free from the working directory, would have stopped at the network's edge.

What it deliberately does **not** protect against: someone who holds a valid device token can
flood their own room within the limits, and a token cannot be revoked one by one (that is the
price of being stateless — see the table above). Both are answered by rotating `RELAY_SECRET`,
after which everyone re-joins. And the relay still sees **metadata**: who writes, when, and how
much. It cannot read a word of it, but "cannot read the room" is not the same as "cannot see the
traffic".

### Names say how much to trust them

```
web-app#3f9c1a20            local   → unforgeable (cwd + session id)
web-app@macmini#7b02e5d1    remote  → only as good as the device token behind it
```

The relay enforces the namespace in the token: a device cannot post under another machine's
name. But `@macmini` is a weaker claim than a local name, and the reader is entitled to see
which one it got.

**And the name you are shown is a name you can address.** `--to web-app@macmini` is written as
you see it, travels as you wrote it, and is translated into that machine's own names as it
lands (`web-app@macmini` → `web-app` on macmini itself); an addressee naming a third machine
passes through untouched. Without that step the correct name reached nobody — a remote seat is
local to itself, so it has no `@macmini` in its name to match — and neither side could tell,
because on the sender's machine that name is in the roster and `send` was right to accept it.
Measured in a live two-machine room on 2026-08-07; the regression is in `test/relay.test.mjs`.

## Prior art and relatives

The `reuse-before-build` scan (2026-08-03) found these before we wrote a line:
[AMQ](https://github.com/avivsinai/agent-message-queue) (Maildir, MIT — the atomic JSON
write pattern comes from it), [patchcord](https://patchcord.dev) (cross-machine, but needs
Supabase + a server), `agent-com`, `claude-peers-mcp`. Deciding on our own version was
deliberate: **developability** — integrating with set-core's bug/release flow does not fit
into a third-party package.

## License

MIT — see [LICENSE](LICENSE).
