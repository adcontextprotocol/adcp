---
"adcontextprotocol": patch
---

Mirror the current published SDK storyboard compliance bundle into
`static/compliance/source/` as the spec-owned canonical source, add source
authority drift checks, and document the storyboard rollout order:
`spec storyboard change -> reference implementations update -> @adcp/sdk runner
release -> downstream consumers update`.
