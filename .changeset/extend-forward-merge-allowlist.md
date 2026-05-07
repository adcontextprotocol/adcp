---
---

ci(release): extend forward-merge auto-resolution for known 3.1-track divergences

Adds four files to the auto-resolved set in `forward-merge-3.0.yml`, all routed to `--ours` (main): `training-agent-storyboards.yml`, `runner-output-contract.yaml`, `core/error.json`, `get-adcp-capabilities-response.json`. Same bridge pattern as the existing AUTH_REQUIRED rule (#3811) — main has 3.1-track additions in these files that 3.0.x can't adopt within the patch contract; without the short-circuit, every forward-merge re-discovers the divergence.

Discovered on the 3.0.5 forward-merge, which required manual resolution (#3902). Future 3.0.x patch forward-merges will now auto-open without these five recurring conflicts.

`storyboard-schema.yaml` is intentionally LEFT in the manual-resolution path — both lines legitimately add new doc blocks (3.0.x added `default_agent` in 3.0.5; main has CANONICAL CHECK ENUM additions), and `git checkout --ours` silently drops clean-merged 3.0.x additions. Hybrid resolution needs a human.
