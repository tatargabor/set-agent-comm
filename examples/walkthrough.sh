#!/usr/bin/env bash
#
# A runnable tour of the bus. Two projects, one room, ten commands.
#
#   ./examples/walkthrough.sh
#
# It builds a THROWAWAY store in a temp directory (SET_AGENT_COMM_DIR), so it cannot touch your
# real bus, and it needs no install and no network. The letterbox and the safety net are off:
# both spawn `claude -p`, and this file is meant to be free and offline.
#
# Every console block in README.md → "What it looks like in use" is output from this script.
# If you change the CLI, run this: a doc example that has quietly stopped being true is worse
# than no example, and the only way to tell is to run it.
set -u

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SAC="node $REPO/bin/sac.mjs"

export SET_AGENT_COMM_DIR=$(mktemp -d -t sac-walkthrough-XXXXXX)
export SET_AGENT_ROOM=team
export SET_AGENT_TRIAGE=off      # no cheap model in front of the wake-up
export SET_AGENT_SAFETY_NET=off  # …and none behind it either
export SET_AGENT_HEADLESS=0      # pretend these are interactive windows, not `claude -p` runs

# Three sessions. In real life all of this is free: the name comes from the working directory,
# the session id from Claude Code, and the owner pid from the `claude` process above you. Here
# they are spelled out so that one shell can play all three parts.
#   A  — a session of web-app          B  — api-service
#   A2 — a SECOND session of web-app, the case a single-file channel could not represent
WORK=$(mktemp -d -t sac-projects-XXXXXX)
mkdir -p "$WORK/web-app" "$WORK/api-service"
trap 'rm -rf "$SET_AGENT_COMM_DIR" "$WORK"' EXIT

A()  { (cd "$WORK/web-app"     && env CLAUDE_CODE_SESSION_ID=3f9c1a20-1111-2222-3333-444455556666 SET_AGENT_OWNER_PID=101 "$@"); }
A2() { (cd "$WORK/web-app"     && env CLAUDE_CODE_SESSION_ID=7b02e5d1-1111-2222-3333-444455556666 SET_AGENT_OWNER_PID=102 "$@"); }
B()  { (cd "$WORK/api-service" && env CLAUDE_CODE_SESSION_ID=c4e10000-1111-2222-3333-444455556666 SET_AGENT_OWNER_PID=103 "$@"); }

step() { printf '\n\033[1m── %s\033[0m\n\n' "$*"; }
run()  { printf '\033[2m$ %s\033[0m\n' "$*"; }

step "1 · check in — this is what the SessionStart hook does for you"
run "sac register team"
A $SAC register team | head -5
B $SAC register team >/dev/null
A2 $SAC register team >/dev/null

step "2 · say what you are working on — once, when you start"
run 'sac focus "reworking the checkout form" --files src/checkout/,src/lib/cart.ts'
A $SAC focus "reworking the checkout form" --files src/checkout/,src/lib/cart.ts

step '3 · ask somebody something — `--to` is what claims their attention'
run 'sac send team QUESTION "Does the cart still POST /v1/orders, or did you move to /v2?" --to web-app'
B $SAC send team QUESTION "Does the cart still POST /v1/orders, or did you move to /v2?" --to web-app

step '4 · a broadcast FACT wakes nobody — and `send` says so, while it can still be fixed'
run 'sac send team FACT "Deployed api-service 2.4.0 to staging."'
B $SAC send team FACT "Deployed api-service 2.4.0 to staging."

step "5 · read your mail — the FACT is delivered too, it just did not interrupt anyone"
run "sac inbox team"
A $SAC inbox team

step "6 · the sibling session has its OWN cursor — one seat reading does not read for the other"
run "sac peek team    # session 7b02e5d1 of the same project"
A2 $SAC peek team

step "7 · answer it, pointing back at the question"
TS=$(B $SAC history team 20 | grep -m1 -oE '^## [0-9T:.+-]+' | cut -c4-)
run "sac send team ANSWER \"…\" --to api-service --re $TS"
A $SAC send team ANSWER "/v2 since Tuesday. /v1 still answers, it 301s." --to api-service --re "$TS"

step "8 · who is on the bus, and what is each of them holding"
run "sac agents"
A $SAC agents

step "9 · a misspelt addressee FAILS the send, at the writer"
run 'sac send team QUESTION "Is the cart on /v2?" --to web-ap'
B $SAC send team QUESTION "Is the cart on /v2?" --to web-ap
echo "exit: $?"

step "10 · a long entry arrives lede-first — unless it is one you must answer"
LONG="The staging database was migrated this morning. $(head -c 1400 </dev/zero | tr '\0' '.') END"
B $SAC send team FACT "$LONG" >/dev/null
run "sac inbox team    # a 1500-character FACT, clipped at SET_AGENT_INBOX_CHARS"
A $SAC inbox team | tail -4 | cut -c1-100

step "11 · the Stop hook will not let a turn end on something owed an answer"
B $SAC send team REQUEST "Please bump the cart client to 2.4.0 before the release." --to web-app >/dev/null
run 'echo "{}" | node hooks/stop.mjs'
A node "$REPO/hooks/stop.mjs" <<<'{}'
printf '\n'
run 'echo "{}" | node hooks/stop.mjs    # the SAME entry, second call — once per entry, never again'
A node "$REPO/hooks/stop.mjs" <<<'{}'
printf '(nothing — a nudge is spent once, or it becomes the next interruption engine)\n'

step '12 · a machine run (`claude -p`) is never blocked by mail it could not act on'
run 'SET_AGENT_HEADLESS=1  echo "{}" | node hooks/stop.mjs'
SET_AGENT_HEADLESS=1 A node "$REPO/hooks/stop.mjs" <<<'{}'
printf '(nothing — and the entry stays UNREAD, so the interactive session still gets it)\n'

step "13 · the file underneath is just a file"
run "cat channels/team/api-service#c4e10000.md"
head -8 "$SET_AGENT_COMM_DIR/channels/team/api-service#c4e10000.md"

step "the whole store, for a room of three"
find "$SET_AGENT_COMM_DIR" -type f | sed "s|$SET_AGENT_COMM_DIR|~/.local/share/set-agent-comm|" | sort
printf '\n(removed on exit — nothing of yours was touched)\n'
