#!/usr/bin/env node
// Stands in for `claude -p` in the tests (see `SET_AGENT_TRIAGE_BIN`). Spending a real model call
// per assertion would make this suite slow, non-deterministic, and billable — and what these
// tests are about is what `sac wait` DOES with a verdict, not how the verdict is reached.
//
// `SET_AGENT_TRIAGE_SAYS`: yes | no | junk (unparseable) | hang (never answers).
const says = process.env.SET_AGENT_TRIAGE_SAYS || "yes"
if (says === "hang") setInterval(() => {}, 1000)
else if (says === "junk") console.log("I'm afraid I can't help with that.")
else console.log("```json\n" + JSON.stringify({ wake: says === "yes", why: "stub" }) + "\n```")
