---
"adcontextprotocol": patch
---

Make the `impairment.coherence` terminal-buy carve-out explicit for the health-iff rule. The original lifecycle.mdx text only said terminal-status buys "MAY remain unreported even when a referenced resource is offline" — addressing impairments-list staleness but not the `impairments[]` ↔ `health` biconditional. Read strictly, the biconditional bound every buy regardless of status, which a strict runner could fail on a `completed` buy that legitimately carries stale `health: "impaired"` with an empty `impairments[]`.

Aligns the spec with the runner pragma already in `@adcp/sdk` 7.6.0 ([adcp-client#1801](https://github.com/adcontextprotocol/adcp-client/pull/1801)): all three rules — forward, inverse, health-iff — relax on terminal-status buys. The runner grades them only against non-terminal buys; the spec text now says the same thing explicitly.

`lifecycle.mdx § Compliance § Out of scope` extended with the biconditional relaxation. `compliance-catalog.mdx` Cross-resource invariants row mirrors the wording.

Closes #4635.
