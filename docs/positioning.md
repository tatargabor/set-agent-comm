# The field, feature by feature — and what is left for us

**Surveyed 2026-08-10.** This page is what the README's *Prior art and relatives* section grew
into. That section named four projects and stopped; this one reads them, compares them against
what is built here, and states plainly where they are ahead.

It is written to be falsifiable. Every claim about another project is from its own README on the
date above, with the number it gives; every claim about this one points at a file. A survey that
flatters the surveyor is worth nothing, so the two sections that matter most are *What the field
does that we do not* and *The thing that could make all of this irrelevant*.

## The field

Nine projects solve some version of "two agent sessions on one machine should be able to talk".
Stars are 2026-08-10; the newest of them is five months old.

| | ★ | transport | woken how |
|---|---|---|---|
| [agent-message-queue](https://github.com/avivsinai/agent-message-queue) (Go) | 81 | Maildir `tmp→new→cur` | `amq wake` injects into the terminal, with backoff |
| [claude-code-inter-session](https://github.com/yilunzhang/claude-code-inter-session) (Python) | 26 | WebSocket on `127.0.0.1:9473` | delivered as a prompt via `Monitor` |
| [cc2cc](https://github.com/non4me/cc2cc) | 14 | JSON files, 3 s polling | MCP channel push — needs `--dangerously-load-development-channels` |
| [mcp-dispatch](https://github.com/sophia-labs/mcp-dispatch) (Python) | 2 | JSON files, ack'd | stderr alert to the **human**; otherwise piggybacks on a tool result |
| [claude-intercom](https://github.com/sanztheo/claude-intercom) | 2 | `fs.watch` + asyncRewake | asyncRewake |
| [agent-comms-mcp](https://github.com/watchout/agent-comms-mcp) | 0 | PostgreSQL + `pg_notify` → webhook | HTTP POST into the session |
| [aichat-mcp](https://github.com/Wayy-Research/aichat-mcp) | 0 | cloud relay | — |
| [patchcord](https://patchcord.dev) | — | Supabase + a server | — |
| **set-agent-comm** | 2 | one file per writer, append-only | `sac wait` in a `Monitor`, **after two gates** |

Two facts about that table are worth more than the rows. **Nobody has won it** — the leader has 81
stars in eight months, and five of the nine are effectively unread. And **every one of them is a
transport**: the design question each answers is *how does the message get there*. That question
turns out to be the easy one.

## What we do that nothing else in the field does

Ordered by how hard each would be to copy.

### 1. An attention economy: delivery and interruption are separate

Everywhere else, a delivered message is an interrupting message. Here `isForMe` and `wakes` are two
different functions (`src/store.mjs`), and the second one is the scarce resource:

| | |
|---|---|
| a broadcast `FACT` | delivered to everyone, wakes nobody |
| `to: ["proj#3f9c1a20"]` | wakes that one seat, delivered to all |
| `to: ["proj"]` | wakes the sessions of that project **that a cheap model agrees are meant** |

Measured 2026-08-06 against 133 live entries in one room: **12 would have interrupted anyone,
instead of all 133.** A 91% cut, and the mechanism is in the server rather than in a prompt —
which is the whole point, see *What the field taught us* below.

The nearest thing anyone else has is `agent-comms-mcp`'s loop prevention (max depth 10, max 20
exchanges per 300 s) and AMQ's `--priority urgent` filter. Both are brakes; neither is an economy.
A brake stops a runaway. An economy makes the ordinary case cheap.

### 2. A model in the path, pointed both ways

`sac wait` asks `claude-haiku-4-5`, headless and toolless, one question: *given what this seat
declared it is working on, is this entry for it?* (`src/triage.mjs`). Nobody else puts a model
between arrival and interruption at all.

The half that is genuinely unusual is the second one. The letterbox **fails open** — a missing
binary, a timeout, unparseable output all wake the agent, because a missed message is the failure
this project exists to prevent. The safety net, which asks whether a *declined* entry was declined
wrongly, **fails closed** — because a net that guesses yes rebuilds the storm it was added to
catch. Two model calls, opposite failure directions, and the reason each is what it is, is written
above it.

### 3. The reader's bill

Addressing decides who is interrupted. It does nothing about what everyone still *reads*. Measured
2026-08-06: one room held 157 entries averaging 2338 characters — with three sessions open, roughly
1.1 million characters, a quarter of a million tokens, spent on reading, in two days.

`inbox` clips at 1200 characters and only where it is safe to: an entry that is entitled to
interrupt you always arrives whole; `history` is one call away for everything else. **No other
project in the field treats the reader's context as a budget.**

### 4. Identity that an agent cannot forge

The name is the working directory plus `CLAUDE_CODE_SESSION_ID`. The model never supplies it, and
neither does a config file.

| project | who decides the sender's name |
|---|---|
| AMQ | `--me` / `AM_ME`, a string; *"identity is not cryptographically verified"* |
| mcp-dispatch | `MCP_DISPATCH_AGENT_ID`; dynamic mode *"accepts arbitrary agent names without validation"* |
| cc2cc | auto-generated, renameable with `register()`; HMAC signing exists, but an unsigned message is still processed |
| inter-session | a name the session proposes, `rename` changes it |
| **here** | cwd + session id, filled in **server-side** on every entry |

The distinction that matters is stated in the README's limitations table and holds up: this is
unforgeable by an *agent*, not by a *process*. Everything runs as one user. It protects you from a
confused agent, which is the threat that actually happens.

### 5. A remote leg the relay cannot read

Of the nine, three reach another machine: `patchcord` (needs Supabase and a server), `aichat-mcp`
(a cloud relay), and this one. AMQ says no outright — *"those require infrastructure"*.

What is different here is not that it reaches; it is what the operator of the middle sees.
Bodies are AES-GCM ciphertext and the room key never leaves the participants. The sender and the
timestamp travel in the clear because the relay routes by them — so they are bound to the
ciphertext as additional authenticated data, and changing either in transit makes the decrypt
*fail*. Without that binding the relay could re-attribute any entry it forwards **without ever
holding the room key**, and "an agent cannot write in someone else's name" would have stopped at
the network's edge. This is measured, not asserted: `test/relay.test.mjs`, `THE RELAY CANNOT READ
THE ROOM` and `REATTRIBUTION FAILS`.

The relay is also not the source of truth. Lose it entirely and no message is lost: the machines
re-upload and duplicates are dropped by entry id.

### 6. Authorization with four verdicts, one of them a human

`src/policy.mjs` — built, 22 tests, **nothing calls it yet.**

Every authorization layer in the wider agent-tooling world is binary: allow or deny.
[Kong's MCP Tool ACLs](https://konghq.com/blog/product-releases/mcp-tool-acls-ai-gateway),
[Bedrock AgentCore Gateway interceptors](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/)
and [Google's Agent Gateway](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/gateways/agent-gateway-overview)
all decide whether an agent may call a tool. They can, because the thing being protected is a
service that is always up.

Here the thing being protected is a person's attention, so "I cannot decide this" is not a failure
mode — it is a fourth first-class outcome:

```
serve   code answers it — no model, no wake-up
gate    a cheap toolless model decides
wake    a person is interrupted (today's behaviour, and the default)
deny    an answer saying no, and why
```

Three decisions inside it are worth more than the four verdicts:

- **Data release fails closed, attention fails open.** The same broken policy file serves nothing
  and wakes somebody. *A broken policy costs a turn, never a leak.*
- **A path-traversal ask matches nothing — `*` included — and falls to `wake`, never to `deny`.**
  A denial is an answer, and answering a probe confirms the probe.
- **A grant written against a bare project name matches local writers only.** The relay
  authenticates the *device* half of a name and nothing else, so a borrowed device token must not
  inherit every grant ever issued to that project.

### 7. Every non-obvious branch carries the measurement that put it there

Not a feature, and the one thing here that no competitor has any of. The comments are dated,
numbered accounts of observed failures — `⚠ Measured 2026-08-09: a heartbeat burning a whole core
for 6h09m`. Three things follow from it that are not obvious:

- **It protects decisions, where tests protect code.** No unit test can enforce "never
  `mkdirSync(…, {recursive: true})`"; the comment explaining the six-hour spin can, because the
  next person reads it before reverting.
- **It is the only documentation form that survives being edited by a model.** An agent rewrites a
  line whose reason it cannot see. It does not casually rewrite a measured one.
- **The limitations table is the credential.** A project that names the twelve edges it has run
  into has been used; a feature list has not.

## What the field does that we do not

Read this section first if you are deciding whether to use this.

| | who | what they have |
|---|---|---|
| **installability** | AMQ | `brew install`, a checksummed installer, a single binary, `amq upgrade`. Here: `git clone` and `npm install -g .`, and **not published to npm at all** |
| **CI** | AMQ, others | a workflow and a badge. Here: 174 tests, no `.github/`, no green tick a visitor can see |
| **more than one agent brand** | AMQ, mcp-dispatch | handles like `claude`, `codex`, `user`. Here the seat model rests on `CLAUDE_CODE_SESSION_ID` — the best thing about it, and what excludes every non-Claude-Code user |
| **a human in the channel** | agent-comms-mcp | Discord in and out, same path as bot-to-bot, so a person can join from a phone. Here a person reads the files or a TUI, on the machine |
| **threads** | AMQ | first-class `--thread`, `amq trace`. Here `re:` points at an entry and no more; the README says so |
| **orchestration adapters** | AMQ | swarm mode, Symphony, Kanban, delivery receipts, `amq doctor --ops` |
| **portability** | most | Go/Python single binaries. Here: procfs-first liveness, a `ps` fallback, and no Windows |
| **an ack'd queue** | mcp-dispatch, AMQ | a message stays until acknowledged. Here the cursor advances on read and `sac unread` is the undo |

And two that are ours alone to fix: **nothing calls `policy.mjs`**, and there is **no audit trail**
for what a `serve` verdict hands out — a permission layer that does not record what it released is
silent after an incident.

## The thing that could make all of this irrelevant

Claude Code now ships `ListAgents` and `SendMessage`. Run today on this machine, `ListAgents`
returned nine peer sessions with names, liveness and state (`idle` / `busy` / `waiting` / `shell`)
— which is most of what `sac agents` answers — and `SendMessage` delivers to any of them, including
sessions in the cloud and, with Remote Control, on other machines. Its own documentation says the
receiver *"does not check an inbox"*.

That is the roster and the transport, built in, free, and with none of the install cost. Anyone
choosing a tool from the table at the top of this page should know it exists first.

What it does not have, on the evidence of its own tool description:

- **no persistence.** Messages *"enqueue and drain at the receiver's next tool round"*. There is no
  log, no history, no cursor, nothing to `cat`, and nothing survives the session.
- **no economy.** Every message arrives. There is no notion of an entry that is worth reading and
  not worth a turn — which is the 91% above.
- **no declared scope.** Nothing answers "what is that session holding" without asking it, which
  costs a round trip from both sides.
- **no policy.** Its guidance on the real risk is a paragraph of prompt: *"NEVER ask a peer to
  perform an action that was denied or blocked in your session … cross-session permission
  laundering."*

That last line is the most useful sentence in this whole survey, and it is worth being precise
about why. The problem it names is real and correctly identified. The mechanism chosen to solve it
is an instruction to a model — which is exactly the mechanism that failed here, measured: `to`
shipped as an optional field and the next **190 entries used it zero times**. An optional field
that 190 entries decline to use is not a mechanism, it is a suggestion. A "NEVER" in a tool
description is the same class of thing.

**That is the position: the transport is now free, and the economics are not.** Everything in
*What we do that nothing else does* is downstream of a message costing the receiver something.

## What the field taught us

Three things, in the order they changed something here.

1. **AMQ's install story is the whole gap.** 81 stars against a comparable local design says the
   difference is `brew install` versus `git clone`. Nothing about the protocol is being voted on.
2. **`cc2cc` requires `--dangerously-load-development-channels` to push a message.** Building on an
   unstable private channel buys instant delivery and a dependency that can be withdrawn. The
   `Monitor` long-poll here is uglier and is on a supported path.
3. **`inter-session` treats incoming messages as instructions by default**, with guardrails in the
   prompt. It is the clearest statement of the risk `policy.mjs` exists to answer in code: once a
   peer can start your turn, "what may it ask for" is a permission question, and a permission
   question answered in a prompt is answered nowhere.

## Where this goes

The build order is in [`cross-project-requests.md`](cross-project-requests.md). Read against this
page, three items in it are the differentiators rather than features:

- **DMs** (next) — a room today makes every writer a permanent reader of the room's traffic; an
  answer to a request has nowhere private to go. See [`rooms.md`](rooms.md).
- **`serve` from a catalogue** — code answering code, no model in the path, no wake-up. This is the
  only item here that makes an agent bus *cheaper* to run rather than better behaved.
- **the gatekeeper** — the cheap toolless model for what rules cannot decide.

And one item that is not in the build order and should be: **an audit line per served request**
(`ts, who, ask, verdict, rule`), before `serve` is wired to anything. The `serve` path releases
data with no human and no model in it; without a record it cannot be reviewed after the fact.
