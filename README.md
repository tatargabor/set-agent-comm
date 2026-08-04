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
## 2026-08-03T18:42:07.318+02:00 — QUESTION (re: 2026-08-03T18:40:11.002+02:00)
The text, in markdown.
```

Types: `QUESTION` · `ANSWER` · `FACT` · `REQUEST`. **The timestamp and the sender are filled
in by the server**, never by the model — measured on 2026-07-24 on the hand-kept channel:
*both* agents were guessing the date (off by +6 and +1.5 hours), which blinded the
"silent for N minutes" condition.

## Install

```bash
git clone https://github.com/tatargabor/set-agent-comm
cd set-agent-comm
npm install                       # a single dependency: @modelcontextprotocol/sdk
npm test                          # 31 tests + the two-agent smoke test
npm install -g .                  # optional: puts `sac` and `set-agent-comm-mcp` on the PATH
```

Once per project, in **stdio** mode (this is the default):

```bash
cd ~/code/web-app
claude mcp add agent-comm -e SET_AGENT_ROOM=team -- set-agent-comm-mcp
# without a global install: -- node /path/to/set-agent-comm/src/stdio.mjs

sac install team                  # the two hooks that make sure a message is NOTICED
```

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
| **working** | `Stop` hook (`hooks/stop.mjs`) | it may not end the turn with unread mail — `decision: "block"` sends it back with the room named |
| **idle** | `sac wait` inside a `Monitor` | the only thing that **starts a new turn**: every message is an event in the chat |

Both hooks are wired in by one command, run in the project:

```bash
sac install team                  # --dry-run first if you want to see it
```

It adds them to `.claude/settings.json`, leaves every other hook alone, takes a backup before
writing, and a re-run updates its own entry instead of adding a second copy. (Measured need:
on a live project the Stop hook was simply forgotten in a settings file holding a dozen hooks —
and from the outside a forgotten hook looks exactly like a quiet room.)

```js
// the agent arms this once, e.g. at the start of the session
Monitor({ command: "sac wait", description: "agent-comm inbox", persistent: true })
```

Both only ever **look**: `advance: false`, so a notification never marks a message read — a
monitor firing while the agent is busy must not swallow it. And the Stop hook nudges **once per
entry**: Claude Code has no `stop_hook_active` field, so a hook that blocked on every unread
message would trap an agent that does not read it. Blocking is a strong move; it is spent on
saying something new.

## CLI

```
sac install <room> [--dry-run]      wire both hooks into this project's settings.json
sac agents                          who exists, who is alive
sac send <room> <type> "text"       entry (append)
sac inbox <room>                    new messages from others (marks them read)
sac peek <room>                     the same, without moving the cursor
sac unread <room> [n]               make the last n messages unread again
sac history <room> [n]              read back
sac wait [--once] [room…]           block until a message arrives (for a Monitor)
sac watch-paths <room>              the files to watch (for the hook)
```

## MCP tools

`agents` · `rooms` · `send` · `inbox` · `history` — the `from` field is **filled in by the
server**, so an agent cannot write a message in someone else's name. On an `inbox` entry
`sibling: true` means it came from another session of the **same project**; in `agents` the
`live` field names the project's currently live sessions, and `seats` carries their full
session id.

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

## Scope — what this DELIBERATELY cannot do

- **One machine.** No auth, no network, no server to operate. Multiple machines (e.g. a
  remote colleague) **will be a separate protocol**, not an extension of this one.
- **Not an ant farm.** It is not a task dispatcher and not an orchestrator: two (or N)
  *human-led* sessions talk in it.

## Prior art and relatives

The `reuse-before-build` scan (2026-08-03) found these before we wrote a line:
[AMQ](https://github.com/avivsinai/agent-message-queue) (Maildir, MIT — the atomic JSON
write pattern comes from it), [patchcord](https://patchcord.dev) (cross-machine, but needs
Supabase + a server), `agent-com`, `claude-peers-mcp`. Deciding on our own version was
deliberate: **developability** — integrating with set-core's bug/release flow does not fit
into a third-party package.

## License

MIT — see [LICENSE](LICENSE).
