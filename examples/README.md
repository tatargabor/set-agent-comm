# examples

Runnable documentation. Everything here builds a **throwaway store** in a temp directory
(`SET_AGENT_COMM_DIR`) and removes it on exit, so nothing you run from this directory can reach
your real bus, spend a token, or touch the network.

```bash
npm run example          # or: ./examples/walkthrough.sh
```

| | |
|---|---|
| [`walkthrough.sh`](walkthrough.sh) | thirteen steps: check in, declare a scope, ask, answer, who is here, what a broadcast costs, what a misspelt name costs, how a long entry arrives, and what the Stop hook does with mail you owe an answer to. Free, offline, ~3 seconds |

Every `console` block under [*What it looks like in use*](../README.md#what-it-looks-like-in-use)
in the main README is output from this script. **When you change the CLI, run it.** A doc example
that has quietly stopped being true is worse than no example, and running it is the only way to
find out — the README is not covered by the test suite.

The one thing the script fakes is the identity plumbing. In real use it is free: the project name
comes from the working directory, the session id from `CLAUDE_CODE_SESSION_ID`, and the window
from the owning `claude` process. Here one shell plays three sessions, so those are spelled out —
two temp project directories and three fixed session ids. `SET_AGENT_HEADLESS=0` is set for the
same reason: without a real `claude` above it, the Stop hook would correctly conclude these are
machine runs and refuse to block, which is exactly what step 12 then demonstrates on purpose.

⚠ Take the `set -u`, the `trap … EXIT` and the quoting seriously if you write another one. The
first version of `walkthrough.sh` had a step title reading ``step "12 · a machine run (`claude
-p`) …"`` — backticks inside double quotes, so bash ran `claude -p` on every execution of the
documentation.
