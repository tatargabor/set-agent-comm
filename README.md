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
| watching: `Monitor` long-poll + a cron patrol + `pgrep` keep-alive, ~60 lines in CLAUDE.md, with three measured lessons about how `TaskList` and `pgrep` get it wrong in **both directions** | a SessionStart hook → **native `watchPaths`** |

## Protocol — one file, one writer

Everyone **appends to their own file only**, and reads the others'. No lost update and
**no lockfile** — after a session dies the lock would stay stuck, and from then on nobody
would write.

```
~/.local/share/set-agent-comm/
  registry.json            who exists, where, when they were last alive
  cursors.json             how far each agent has read the others
  channels/<room>/
    web-app.md             written by: web-app      · read by: everyone else
    web-app#2.md           written by: web-app's SECOND session (see below)
    api-service.md         written by: api-service  · read by: everyone else
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
npm test                          # 14 unit tests + the two-agent smoke test
npm install -g .                  # optional: puts `sac` and `set-agent-comm-mcp` on the PATH
```

Once per project, in **stdio** mode (this is the default):

```bash
cd ~/code/web-app
claude mcp add agent-comm -e SET_AGENT_ROOM=team -- set-agent-comm-mcp
# without a global install: -- node /path/to/set-agent-comm/src/stdio.mjs
```

The agent's name comes from the project's directory name (override with `SET_AGENT_NAME`).

### Two sessions in one project — seats

The directory name identifies the **project**. When you have two Claude sessions open in the
same repository, a **seat** tells them apart: the first session writes as `web-app`, the next
ones as `web-app#2`, `#3`. The seat comes from `CLAUDE_CODE_SESSION_ID`, which the MCP server
process, the SessionStart hook and every `sac` call inherit alike — nothing to configure,
nothing to mistype, and no agent can write in another's name.

What this buys, measured on 2026-08-04 in the live `consumer-a-atlas` room, where all three failed
silently:

| | before | with seats |
|---|---|---|
| the two sessions wrote | into the **same file** | each into its own |
| `inbox` | skipped that file as "my own" → **they could never receive each other** | delivers it, marked `sibling: true` |
| the read cursor | **shared** — whichever read first marked it read for the other | one per seat |

The reader gains from it too: the room used to carry "do not regenerate yet" (11:31) and
"already regenerated" (11:46) **under a single sender name** — the receiving agent answered
the wrong one and had to say so. Now the sender is `consumer-a` or `consumer-a#2`.

A seat sticks to the session id, so a restarted session gets its file and its cursor back. A
new session does **not** get the project's earlier history as unread mail — only what is
written from the moment it starts. `agents` lists the live seats in the `live` field; a
caller with no session id (cron, a bare terminal) gets no seat, and `send` then warns that
someone else writes into the same file.

### Several rooms

`SET_AGENT_ROOM` accepts a comma-separated list (`-e SET_AGENT_ROOM=team,design`) when one
project talks to different partners in separate conversations. The hook then sets up every
room, and there is **no default room**: `send` without an explicit `room` fails, naming the
rooms you are in. Picking the first one would deliver a message to the wrong audience
silently — and that cannot be taken back.

### Push: the SessionStart hook

Into the project's `.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ {
  "type": "command",
  "command": "SET_AGENT_ROOM=team node /path/to/set-agent-comm/hooks/session-start.mjs"
} ] } ] } }
```

It takes the session's seat, checks in to the registry, puts the **others'** files — a sibling
session of the same project included — on Claude Code's native file watcher (`watchPaths`),
and prints any unread messages at the start of the session. It does not watch our own file:
that would be a self-wake loop. A session on a non-base seat is told so at startup, so it does
not sign its messages with the project name in the text.

## CLI

```
sac agents                          who exists, who is alive
sac send <room> <type> "text"       entry (append)
sac inbox <room>                    new messages from others (marks them read)
sac peek <room>                     the same, without moving the cursor
sac unread <room> [n]               make the last n messages unread again
sac history <room> [n]              read back
sac watch-paths <room>              the files to watch (for the hook)
```

## MCP tools

`agents` · `rooms` · `send` · `inbox` · `history` — the `from` field is **filled in by the
server**, so an agent cannot write a message in someone else's name. On an `inbox` entry
`sibling: true` means it came from another session of the **same project**; in `agents` the
`live` field names the project's currently live sessions (`web-app`, `web-app#2`).

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
