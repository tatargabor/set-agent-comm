# The live test — real sessions, on a private bus

```bash
node demo/harness.mjs demo/scenarios/three-projects-two-seats.json
node demo/harness.mjs demo/scenarios/handoff-chain.json
DEMO_MODEL=claude-opus-5 node demo/harness.mjs demo/scenarios/three-projects-two-seats.json
DEMO_TRIAGE=on          node demo/harness.mjs …      # spend real Haiku calls on the letterbox too
```

Two scenarios, both three projects with two seats each:

| | the question it asks |
|---|---|
| `three-projects-two-seats` | one fact, one request, one question — does each get the addressing it deserves |
| `handoff-chain` | news whose consequence lands two projects away: is the chain carried, and does it stop where it should |
| `handoff-chain-remote` | the same file (`extends`), with the projects dealt out to two machines and a real relay between them — does the chain still cross |

A scenario may set `machines`, mapping a machine name to the projects that live on it. Each machine
gets its own store directory — which is all a second computer is here — the harness starts a relay
and runs the real handshake, and the report adds a **GÉPEK KÖZÖTT** section counting what actually
crossed. `extends` keeps a remote variant the *same* scenario rather than a copy that drifts.

And the harness itself, for free:

```bash
npm run demo:smoke        # both smoke tests; also part of `npm test`
node demo/harness.mjs demo/scenarios/handoff-chain-remote.json   # two machines, a real relay
```

A live run costs a few dollars and takes half an hour, which is the wrong loop to be in when what
broke is the harness. Both smoke tests put a fake `claude` first on `PATH` and run a scenario
through the real harness, the real `sac install` and the real store, in their own `DEMO_RUN_DIR`
so they can never wipe a paid run's measurement.

- `demo/smoke.mjs` — four distinct seats, both entries, 2 wake-ups against the old rule's 5, focus
  4/4. The seat count is the load-bearing one: it is what collapsed to 4-of-19 while the seat
  sprawl was live, and the fake `claude` uses its own pid as owner exactly so it can catch that.
- `demo/smoke-remote.mjs` — two machines, a real relay on a port of its own, the real `sac relay
  use` / `invite` / `join` handshake, and the question that matters: **crossed 1/1**.

**It costs money.** Every round of a real scenario is a real `claude -p` session. The harness prints the total at the
end (`total_cost_usd`, summed across turns), so a run can be judged on what it bought.

## Why this exists next to the unit tests

`store.test.mjs` proves what the code does; `nudge.test.mjs` proves what the watcher does. Neither
could have caught the failure that actually happened.

⚠ `to` — the field that decides who gets interrupted — shipped with passing tests on 2026-08-05,
and the next **190 consecutive entries did not use it**, in 47 opportunities. The mechanism was
correct and the room paid the full price of not having it. Protocol adherence is a property of the
skill, the tool descriptions and the prompt, and the only honest way to measure it is to run real
sessions and count what they wrote.

So this harness answers a different question from the test suite: **not "does it work" but "will
they use it that way".**

## What a run does

1. Builds `demo/run/` from the scenario: one directory per project, with source files, a
   `.mcp.json`, and hooks + skill installed by **`sac install` itself** — if the installer breaks,
   this breaks.
2. Every seat introduces itself once. That call CREATES the seat, and the harness keeps the
   returned `session_id` so every later round `--resume`s it. That is what makes a seat outlive one
   turn — and what lets one project hold two of them, which is the case the seat mechanism exists
   for and the one most likely to go wrong.
3. Runs the scenario's rounds. A round's `parallel` seats run **genuinely at the same time** — two
   siblings reaching for one file only collide if they are both thinking; run one after the other,
   the second merely reads what the first already announced, and the round measures nothing.
4. Reads the bus back off disk and reports.

Everything lands in `demo/run/store`, so a run can never touch the live bus.

## What the report measures

| | why it is the number that matters |
|---|---|
| broadcast / seat-addressed / project-addressed | addressing is the only thing that claims attention. Addressing a *project* wakes all its sessions, so it is counted separately from a seat |
| entries naming several addressees | naming everyone is a broadcast with extra steps — and it also bypasses the letterbox |
| average length | the one number that did not move when the wake-up rule landed (measured baseline: 2168 characters) |
| ack-shaped openings, `re:` chains | the closing handshake that could not terminate: 23 entries in 8 minutes between four seats |
| **interruptions, now vs. the old rule** | computed by running `store.wakes` over every (entry, seat) pair — counted from the rule, not estimated |
| focus declared | a scope lookup instead of a scope conversation: 46 entries in two days went on that |

## Writing a scenario

The rounds are the design work: each one should be a situation where **the right move differs**,
so the report shows a choice rather than a habit.

- a fact nobody must act on → belongs in a broadcast `FACT`, and must wake nobody
- a request only one sibling can serve → belongs in `to: ["<seat>"]`
- a question only one participant can answer → tests whether they address it or shout it
- two seats of one project reaching for one file → should be settled by `agents`/`focus`, not by a round of messages
- a round where nobody has anything to say → the silence is the result; any entry here is the ack habit returning
- a piece of news whose consequence lands on **one other project** → tests whether the chain is carried
  forward one addressee at a time, or shouted once and left for everyone to work out

⚠ **The prompt may not assert anything the files contradict.** Measured on the first run: round 1
said "`ROUNDING` is now `banker`", the repository said `half-up`, and `pricing/0` correctly refused
to announce it — so the round measured the agent's honesty instead of its addressing, and the case
it existed for never ran. If a prompt claims a change has already happened, the scenario's `files`
must already contain it.

The seats really do the work: they get `Edit` and `Write` alongside the bus tools, confined to
`demo/run/<project>`. ⚠ `--allowedTools` **pre-approves, it does not restrict** — the seats were
already editing their files before those two were listed (verified on disk after the first handoff
run: the renamed SKU had landed in all three projects). Naming them changes nothing about what the
seats can do; it makes the grant visible in the harness instead of resting on a default.

`{{PROJECT}}` and `{{ROLE}}` are substituted into `intro`. Prompts deliberately do **not** name the
mechanism — telling the agent to "use `to`" would measure the prompt, not the protocol.
