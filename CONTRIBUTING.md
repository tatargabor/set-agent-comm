# Contributing

**A bug report from real use is worth more to this project than a pull request.** That is not
politeness — it is what the codebase is made of, and this page explains why, so that the ask does
not read as a brush-off.

## What this project is short of

Not code. Every non-obvious branch in here was put there by an **observed failure**, with the date
and the number attached:

```js
// ⚠ Measured 2026-08-09: a heartbeat burning a whole core for 6h09m, orphaned by the
//   test run that spawned it. A synchronous loop in a C++ builtin cannot be caught,
//   timed out, or defended against by the hook's own try/catch.
```

Those comments are the changelog, and they are the reason the design holds. They also mean the
scarce input is **measurement**, and measurement is exactly what a contributor has and the author
does not: every figure in this repository comes from **one person's machine**. That is stated
plainly in the README's limitations, and it is the single most useful thing an outsider can change.

So:

- **Open an issue** describing what happened, on what, with what you saw. Rough is fine. A
  transcript, a `sac stats` line, a screenshot of `sac admin`, "this hook cost me 30 seconds every
  session" — all of it is usable.
- **`sac stats --seats` output is especially welcome.** It reports decisions, wake-ups and volumes;
  it never records what was said. Nothing in it is a message of yours.
- If you have already fixed it locally, say so in the issue and paste the diff there. That is
  faster to act on than a PR, because the fix usually needs a comment explaining the measurement,
  and only you have that.

## Pull requests

They are accepted, and they are harder than they look — not because of gatekeeping, but because of
one convention that cannot be met from outside:

> A change to behaviour carries a dated, measured note about the failure that motivated it.

If you did not measure it, you cannot write that line, and a PR without it either dilutes the
convention or waits for the author to reconstruct a reason. Both are worse than the issue you could
have opened in a minute.

**PRs that do not run into this** and are welcome as-is:

- typos, broken links, unclear wording;
- a fix for something a test already catches (say so — name the test);
- portability: this is developed on Linux, and the macOS path in `parentOf` / the liveness code has
  far less use behind it than the procfs one. Windows is unsupported;
- a new test for behaviour that already exists and is not covered.

## If you do send code

- ESM, no semicolons, double quotes, 2-space indent.
- **No runtime dependency in the core.** `src/store.mjs` is imported by hooks and by cron, where
  there is no `node_modules` and no event loop, so it stays synchronous and dependency-free. The
  package ships with exactly one dependency (the MCP SDK) and that is a budget, not an accident.
- **Assert on the result, not on the call.** Tests point `SET_AGENT_COMM_DIR` at a `mkdtemp`
  directory, spawn the hooks and the CLI as real processes the way Claude Code runs them, and read
  the file system back.
- `npm test` must pass: 230 tests, an MCP round trip over a real stdio server, and two smoke runs.
  None of them spends a token or needs the network.
- Read `CLAUDE.md` first. It lists the invariants, and each one has a measured failure behind it —
  breaking any of them reintroduces a bug that has already cost somebody something.

## What is deliberately out of scope

It is not an orchestrator and not a task dispatcher — two or more **human-led** sessions talk in
it. A proposal that turns it into an agent farm is not a small change to this project; it is a
different one. The scope section in the README is the long version.
