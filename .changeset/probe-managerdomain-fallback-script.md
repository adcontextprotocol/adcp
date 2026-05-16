---
---

chore(scripts): add real-world managerdomain fallback probe

Ad-hoc developer tool (`server/scripts/probe-managerdomain-fallback.ts`)
that hits live DNS / public web against a small fixture of known
publisher-manager pairs and asserts the AdAgentsValidationResult
envelope.

Not for CI — meant as a manual probe a developer runs after touching
adagents-manager.ts to confirm the path still does what we think
against real managed-network publishers. Fixtures cover the direct
path (craftgossip), Mediavine fallback (homestratosphere), Freestar
fallback (momtastic, expected to fail closed since freestar.com does
not yet serve a manifest), and a non-404 control (raptive.com 403).

Surfaced three real-world divergences to follow up on, captured in
the fixture rationales:

1. craftgossip's adagents.json fails JSON validation.
2. homestratosphere's fallback to mediavine.com does not reach the
   scope gate — likely a validator schema delta against Mediavine's
   `agent_url` field naming.
3. freestar.com 404s on /.well-known so its delegating publishers
   (momtastic) fail closed today.

Usage:
  npx tsx server/scripts/probe-managerdomain-fallback.ts --verbose

Existed as a manual `curl` exercise before — moving the fixture set
into version control so the next regression is caught on demand
rather than after merge. The original gap (the explicit-publisher-
scoping bug fixed in #4283) is exactly what this would have caught.
