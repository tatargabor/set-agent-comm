# The collision alarm — measured 2026-08-11, decided by nobody yet

Two sessions of one project edit the same file. Today nothing says so at the moment it happens.
This page is the night's investigation: what already solves part of it, whether the problem is real,
what each option costs, and what every option still misses. **It decides nothing** — Gábor decides
in the morning, and the numbers here are what he should decide against.

Everything below is measured on this machine on 2026-08-11 unless it says otherwise. Where a claim
of mine turned out to be wrong it is kept, struck, with the measurement that killed it: this page
is worth less if it only records the conclusions that survived.

## Is there already a solution? Three partial ones, and each stops short in a different place

**1. `focus` plus an instruction to read it.** `skills/agent-comm/SKILL.md:127` and
`.claude/handoff.profile.md:58` both say it: *"read the others' before you touch shared files"*, and
a seat named `<project>#<id>` is another session of this project — *"same working directory, same
files, so its focus is a genuine conflict"*. This is real and it works, with two structural limits:
it is a **pull**, so it costs a tool call the agent has to remember to make, and it is read **at the
start of the work**, so it cannot see a session that started afterwards. The store already
half-admits the second: `FOCUS_STALE_MS` is four hours (`src/store.mjs:1350`).

**2. Claude Code's own staleness guard — and it is not one behaviour, it is two.** Measured with a
scratch file, an external modification between the read and the write:

| tool | after an external change | what actually happened |
|---|---|---|
| `Write` (whole file) | **blocked**, hard error — *"File has been modified since read"* | nothing was lost |
| `Edit` (targeted) | **allowed**, with a note in the tool result | the byte landed on top of the other agent's line |

So the case the logs blame for the worst measured damage — *"a full rewrite works from the model's
context, so it re-allocates the numbers and overwrites what somebody else wrote there"* — is
**already blocked by the harness**. The alarm should not be sold as fixing that; it is fixed.

What survives: `Edit` only warns, the warning is visible to the model and only *after* the write,
and both guards are per-session and per-machine. Neither knows another session exists.

**3. And 74% of tool calls go around both.** Measured over the 60 most recent transcripts in
`~/.claude/projects`, 2762 tool calls: **Bash 2042 (73.9%)**, Edit 302, Read 151, Write 72. A
`sed -i`, a `>` redirect, a generator script or a `git checkout` is a write that neither guard sees,
and this repo's own habit is scripts. The write ratio through the guarded tools is **13.5%**.

## Is the problem real? Yes, and the logs name the casualties

Grepped out of `channels/` — production, not hypotheticals:

- **`SYS-032`, `SYS-033`, `SYS-034`, `SYS-035` — four ID collisions in one day.** Cause as written
  at the time: *"a full rewrite works from the model's context, so it re-allocates the numbers and
  overwrites what somebody else wrote there."*
- **`SYS-053` was lost for nine hours** inside an `auto:` commit; the message asks for a commit gate
  on item deletion.
- **`SYS-057` / `SYS-058` — not an ID collision, a content duplicate.** *"The two writers have no
  shared 'this is already up there' check."* Two sessions did the same work.
- **`SYS-104`** is attributed to non-atomic ID allocation; the fix (`SYS-118`) is listed as not
  carried.

And the convergence that makes this page worth writing: those collisions live in
`knowledge/tetelek.md`, which is **the single most contested path in the focus data — 45 overlapping
pairs, nearly twice the next one**. The declaration data and the damage data point at the same file.

**Agents are already building this feature by hand, in prose.** Four of 61 focus texts carry a
hand-written exclusion list:

> *"NEM az enyém: a suspect kapu, lefthook, `scripts/gates/`, `.claude/skills/{bejaras,funkcio-demo}`…"*
> — `consumer-a#8394845a`
>
> *"`src/admin-tui.mjs` és `test/admin-tui.test.mjs` az enyém, ne nyúljatok hozzá"*
> — `set-agent-comm#10b394c3`

A negative scope, typed into a free-text field that nothing parses, by an agent that had no other
place to put it. That is the feature request, written by the users, in the only syntax available.

## What the focus data actually supports — and the finding that kills the obvious design

61 seats with a focus, 56 of them with paths, 5 projects. Same-project pairs whose declared paths
overlap (prefix-aware, so `src/` covers `src/store.mjs`): **104 pairs, touching 44 of the 61 seats.**

Distance in time between the two declarations:

| < 15 min | < 60 min | < 4 h | ≥ 4 h |
|---|---|---|---|
| 4 | 9 | 12 | **79** |

⚠ **Most contested paths:** `knowledge/tetelek.md` 45 · `knowledge/` 29 · `scripts/fejlesztes-be.mjs`
10 · `knowledge/rendszer/levelezes.md` 10 · `scripts/gates/` 7 · `docs/modszertan/` 7 ·
`docs/cross-project-requests.md` 5 · `lefthook.yml` 6.

⚠ **And now the finding that breaks the naive alarm.** Look at what the *closest in time* pairs
actually are:

```
consumer-b#41ef9450 × consumer-b#fa35d1bb   (Δ 2 perc)   knowledge/index.md
  A: "Csak olvasom a knowledge/index.md első sorát — nincs írásom, semmit nem foglalok le."
  B: "Egyetlen olvasós kérdést válaszolok meg (…), nem írok semmit."

consumer-b#297a1e50 × consumer-b#ea4a320e   (Δ 3 perc)   knowledge/tetelek.md
  A: "Napi briefet állítok össze … csak olvasok"
  B: "Napi briefet állítok össze Gábornak … csak olvasok"
```

**`focus.files` carries no read/write intent.** 9 of 62 texts (15%) say "read-only" in prose that no
code parses, and the tightest, most alarming-looking overlaps in the whole dataset are precisely
those. An alarm built on `focus.files` alone fires hardest exactly where there is no collision.

Two ways out, and they are the fork this page really turns on: **ask the declaration to carry
intent** (a `writes:` list distinct from `reads:`), or **stop trusting declarations and observe the
writes instead** (option C below).

## ⚠ The freshness claim, made and retracted the same night

Late in the investigation I measured every `focus` record against the wall clock and reported:
**"0 of 63 are within the store's own four-hour window; not one focus in the system is fresh."** I
recommended rebuilding scope tracking on observed writes because of it.

**That measurement was wrong, and the corrected one says almost the opposite.** It counted the
leftovers of sessions that had ended. Joining `focus.json` to the registry's *seats* (my first join
used `writers`, which is keyed by **pid**, not by seat):

| | |
|---|---|
| focus records | 63 |
| …whose seat the registry still lists | **25** |
| …whose seat the registry itself has forgotten | **38** |
| of the 25: seat unseen for 30+ min (the store's liveness TTL) | 24 |
| of the 25: **live** | **1** — `consumer-b#2731639d`, seat seen 6 min ago, **focus 3 minutes old** |

Every seat that was actually alive had an accurate focus. This is the same error `sac admin` already
corrects for unread counts — *"a closed session is not 'behind', it is gone"* — committed again,
against a different file. **The input is not rotten; the garbage is never collected.**

Consequences for this page: option C loses its evidence and is **not** recommended on this data.
Option A regains it — among live seats the declaration is current. And the actual defect is smaller
than any option listed here:

- **nothing ever deletes a focus** — not the end of a session, and notably not `capDeadSeats`, which
  prunes dead seats out of the registry and leaves their focus behind. Hence 38 records pointing at
  seats the roster no longer contains, still holding paths.
- the fix is a read-time liveness filter (a dead seat's focus is not a claim; `null` is still not
  dead) plus pruning focus wherever seats are pruned. Few lines, no new hook, no new store file.

One more thing the corrected pass turned up: **20 of 63 focus texts (32%) describe a *finished* or
*waiting* state** — *"kész és commitolva"*, *"nincs aktív szerkesztésem"*, *"a fa szabad"*, *"a
felhasználó válaszára várok"*. There is no field for "done", so it is written in prose that nothing
parses — the same pattern as the hand-written `NEM az enyém` exclusion lists above. Two missing
fields, both being emulated in free text by the people using it.

## Costs, measured

| | |
|---|---|
| `statSync` of one stamp file — what the heartbeat pays today | **0.005 ms** |
| read + parse `focus.json` (23 KB) | **0.062 ms** |
| read + parse `registry.json` (30 KB) | **0.047 ms** |
| both + the full overlap computation for one path | **0.111 ms** |
| **spawning one `node` hook process** | **~43 ms** |
| SessionStart hook, for scale (from `cross-project-requests.md:1000`) | 157 ms |

The decision-relevant number is the last two against the first four: **the thinking is free, the
process is the entire cost.**

~~Therefore put it in `heartbeat.mjs`, which already runs on every tool call, and the marginal cost
is 0.111 ms.~~ ⚠ **Retracted the same night, measured false.** 26 projects under `~/code2` wire a
`PostToolUse` hook — **none of them wires the heartbeat.** All 50 entries are `set-hook-memory
PostToolUse`. There is no agent-comm hook process on the tool-call path to ride along in, here or
anywhere on this machine; and this repo wires only SessionStart and Stop, deliberately
(`CLAUDE.md`: do not run `sac install` here).

What rescues the cost anyway: **a matcher.** A hook scoped to `Edit|Write|NotebookEdit` spawns on
**13.5%** of tool calls rather than 100% — measured above. Matchers are in use on this machine
already (`"matcher": "Bash"` ×50, `"Read"` ×25), so this is not a hoped-for feature.

⚠ But a matcher on the write tools is also the 74% blind spot: it will not see a `Bash` write. A
matcher of `Edit|Write|Bash` costs 87.4% of calls and still cannot tell which Bash command writes.

## The five options

### A — PostToolUse, warn after the write

Fires after the byte landed; prints only when there is a collision (the heartbeat rule — *never
block, never throw, never print* — survives, because silence is still the normal case). Cheapest to
build, cannot make anything worse, and it is a *notification*, which is what this project is for.
Catches: the same-file case, within seconds. Misses: it is too late to prevent the write, and a
`Bash` write is invisible.

### B — PreToolUse, block before the write

`PreToolUse` can return `deny` or `ask`, so this genuinely prevents. It is also the only option that
puts agent-comm on the **critical path of every write**: a bug, a slow disk, a corrupt `focus.json`
and the session cannot edit anything. Against that: `readPolicy`'s discipline (read fresh, fail in
the declared direction) and the whole *fails-open/fails-closed* framing in `policy.mjs` already
exist to answer this question, and they say attention fails open. A blocking alarm fails **closed**
on the user's own work, which no layer of this project does today.
Worth noting: with a 15% baseline of read-only declarations, `deny` is indefensible and `ask` is the
only honest verdict.

### C — Derive the scope from writes, instead of trusting the declaration

Record what each seat actually **wrote** (path + timestamp, from the hook payload) and answer "who
is in this file" from observation. This is the option the data argues for:

- it has no read/write ambiguity — a write is a write;
- it cannot go stale by neglect, where 79 of 104 overlaps were ≥4 h old declarations;
- it needs nothing from the agent, and the repo's own precedent is exactly this — *"A heartbeat sent
  by the agent was rejected: that costs a whole turn. This costs a process."*

Costs: a new file in the store, per-seat and append-only (the one-writer invariant makes this
cheap), plus the rate-limit discipline the heartbeat already documents. It does **not** replace
`focus` — focus says *why*, which is what a human needs to resolve a collision; this says *what*.

### D — Worktree isolation (Gábor's idea, 2026-08-11 night)

Give each session its own `git worktree` so they cannot collide, then merge. Real, not impossible:
git supports it and Claude Code has `EnterWorktree` plus subagent `isolation: "worktree"`.

⚠ **Measured, and this is the reason it cannot be the answer for the collisions we actually had.**
A scratch repo, a list file with two sections, two branches:

```
agent-a:  + SYS-032 A-AGENT UJ TETELE   → into "## Nyitott"
agent-b:  + SYS-032 B-AGENT UJ TETELE   → into "## Lezart"
git merge → Auto-merging, MERGE CLEAN, no conflict
result   → two SYS-032 in one file
```

Git merges by line region, so it cannot see a semantic collision. Isolation does not remove this
class — it **defers it to merge time and then passes it through silently**, which is strictly worse
than a shared file plus an alarm, because at merge time nobody is watching and the turn that could
have fixed it is over. This is the exact failure the logs recorded four times in one day.

Three further costs, measured here:

- a worktree carries **tracked files only**: `.claude/` is untracked on purpose, so the isolated
  session starts **with no hooks and no room config** — off the bus, which is the opposite of the
  goal; `node_modules` is 27 MB and absent; `.set/` (dictation) absent;
- the store lives **outside the repo** (`$SET_AGENT_COMM_DIR`), so every worktree shares it — the
  bus state is not isolated at all, correctly, but it means worktrees answer none of the questions
  on this page;
- nothing in it addresses non-repo shared state: ports, dev servers, databases, `.env`.

Where it *is* right: independent parallel work in different files, which is what the Agent tool
already uses it for. As the answer to "two sessions in one file", it is a measured no.

### E — Do nothing new; surface it where the operator already looks

`sac admin` is read-only by construction and already answers "who is behind on reading". Adding
"which live seats declare overlapping paths" is a derived view, zero risk, and it would have shown
the `tetelek.md` hot spot on day one. It warns nobody at the moment of the write. Cheapest possible
step, and it composes with every other option.

## What none of the five solves

`SYS-057`/`SYS-058` — *"not an ID collision, a content duplicate; the two writers have no shared
'this is already up there' check."* Both writers may have been in different files and still done the
same work. A path-based alarm is structurally blind to it. That failure needs the *semantic* layer —
the letterbox, or a shared "already recorded" check in the writing tool — and it should not be
smuggled into this page's scope.

## Open questions — for Gábor, not for us to assume

1. **Warn or block?** The whole project's discipline is that attention fails open; B is the first
   thing that would fail closed on the user's own work.
2. **Declared or observed scope** (the A-vs-C fork)? Or `focus` gaining an explicit `writes:` list,
   which is the cheap middle and asks the agent for one more thing.
3. **Is the `Bash` blind spot acceptable?** 74% of calls. If not, the alarm has to live somewhere
   other than a tool hook, and there is no obvious somewhere.
4. **Cross-project or same-project only?** Every measurement here is same-project. A seat with `@`
   in the name is on another machine and shares no filesystem.

## Do not disturb — built the same day, and it switches off one thing too many

Raised 2026-08-11 by Gábor, from experience: *an incoming request took the focus off the task.*
`sac quiet [--for 2h|90m|1d] [--off]` already exists (`presence.json`, `seatPresence`, applied in
`wakes()` and nowhere else), delivery is untouched, and `send` tells the **writer** at the moment of
writing — *"Quiet: 'seat' until X — the entry is delivered and read, but interrupts nobody there."*
That last part is the good half: the cost is visible where it can still be redirected.

⚠ **But "being woken" is not one thing, it is two, with very different prices, and `quiet` disables
both with one switch:**

| path | when it fires | can it derail work? |
|---|---|---|
| `sac wait` in a Monitor | mid-task or while idle; **starts a turn** | **yes — this is the one that took the focus** |
| Stop hook | only when the turn would otherwise **end** | no. The work is already finished |

The Stop hook cannot interrupt anything by construction; it is the last net — *you may not end the
turn with unread mail*. `hooks/stop.mjs:63` filters on `m.wakes`, and `inbox` now computes that with
quiet applied, so **a quiet seat's Stop hook never blocks.** Consequences:

- a quiet seat can work all evening and stop with an unread `REQUEST` addressed to it, with nothing
  ever saying so. For a session that does not come back, "not immediately" becomes **never**;
- `sac quiet` with **no expiry** is allowed (`bin/sac.mjs:745`). Open-ended quiet plus no armed
  watcher is a seat that looks reachable and is not — the failure `README:701` calls the weakest
  link in the chain;
- expiry is a stamp on disk, not a timer (correctly — nothing may depend on a live process). So
  **expiry is not an event**: an armed watcher self-heals on its next poll; without one, nothing
  does.

**Proposal: quiet silences the watcher and leaves the Stop hook alone.** It removes the
mid-task derailment, which is the whole complaint, keeps the net that prevents the silent loss, and
needs no new concept — only a way to tell the two readers of `inbox` apart, since today they share
one computation. Plus: make an expiry-less quiet a deliberate act (require `--for`, or mark it
loudly in `sac agents`), because that is the variant that can lose a message quietly and for good.

## Ideas from the same conversation, parked so they are not lost

- **Notify+pull instead of push-with-payload.** A trigger sends *that something happened*
  (`config-touched`, `consumer-a`, one path — ~40 bytes) and never the content; the receiver asks
  through the existing `sac ask` → `policy.mjs` → grant → view → DM path if it cares. No new
  authorization surface, and it reuses steps 3–5 of the build order.
- **The hook as the trigger, not as the target.** Do not invoke another project's hook; let your own
  hook fire and route outward. Fixes the ownership and return-channel problems in one move, and it
  is the same shape as options A–C above.
- ⚠ **There is no outbound policy, anywhere.** `policy.mjs` guards only what this project *releases
  when asked*. A trigger that ships conversation text on a keyword match would be the first feature
  that needs a second, outward-facing evaluator — and the phrase-matching trigger cannot be built
  before it exists.
- **A TTL on a served answer.** A served answer is a fact with a timestamp and nothing invalidates
  it, which is why everyone polls on a timer (six quarter-hourly ones, measured). A capability that
  declared a freshness bound would let a requester know when it went stale instead of re-asking.
- **Rate-limiting is not optional here.** A refactor writing 20 TSX files is 20 outbound events; the
  fan-out section of `cross-project-requests.md` and the heartbeat's own 60 s stamp file are the
  precedent, and the heartbeat's comment is explicit that this is about *correctness*, not speed.
