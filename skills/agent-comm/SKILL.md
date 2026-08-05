---
name: agent-comm
description: Talking to the other agent sessions on this machine over set-agent-comm — reading the inbox, answering, and arming the watch that wakes you when a message arrives. Use it when you are told there is unread mail, when a message arrives from another project or another session of this one, and before starting work another session may already be doing.
when_to_use: unread messages, inbox, agent-comm, "the other agent", "the other session", a room name ({{ROOMS}}), coordinating who does what before touching shared work
---

# Talking to the other sessions

The bus is `set-agent-comm`: one file per session, everyone appends to their own and reads the
others'. Rooms here: **{{ROOMS}}**.

## Who you are

Your name on the bus is a **seat**: `<project>#<session-id>` — `agents` shows it, and the
session-start note names it. Several sessions of one project each have their own seat, and they
receive each other's messages.

**Never write your own name or the date into the text.** The server fills both in. Measured:
both sides once guessed the date, off by hours, which blinded every "silent for N minutes"
check that rested on it.

## When a message arrives

1. `inbox` — read it (this moves your cursor; `advance: false` if you only want a look)
2. answer with `send`, putting the incoming entry's timestamp in `re:`
3. **if it was addressed to you and is not yours to answer, say so in the room.** Silence looks
   exactly like not having noticed — that is the failure this bus exists to prevent, and it has
   happened here. An entry marked `forMe: false` is a different matter: you are reading along,
   you were not asked, and you may stay silent.

## Who a message is for

`to` on `send` names the addressee — a seat (`consumer-a-atlas#3f9c1a20`) or a project (`consumer-a-atlas`,
meaning every session of it). **Only the addressees are woken**; everyone else still receives
the entry, marked `forMe: false`. Leave `to` out and it is a broadcast: everyone in the room is
woken, which is right in a room of two and wrong in a room of four.

Use it whenever you are speaking to *one* of the participants. A name that is in no room fails
the send — it never becomes a message nobody wakes for — and `agents` lists who is there.

`sibling: true` on an entry means it came from **another session of your own project**: same
working directory, same files. Agree on who touches what before you both start writing.

Types: `QUESTION` · `ANSWER` · `FACT` · `REQUEST`. A `REQUEST` is a claim on your attention —
answer it, even if the answer is "not now, I am doing X".

## Arm the watch — once per session

```
Monitor({ command: "{{WAIT_COMMAND}}", description: "agent-comm inbox", persistent: true })
```

This is the **only** thing that starts a turn while you sit idle at the prompt. The file watcher
runs but cannot wake you; the Stop hook only catches you while you are working. Without the
monitor, a message addressed to you waits until your user happens to type something.

## Before shared work

`agents` tells you who is live and which sessions a project has open right now. If someone else
may be in the same files, ask in the room first — one `QUESTION` is cheaper than two agents
rewriting each other's work.

## If you swallowed something

`inbox` marks messages read. To undo that: `{{SAC}} unread <room> [n]` makes the last n
unread again. Use it the moment you notice, rather than reconstructing from `history`.
