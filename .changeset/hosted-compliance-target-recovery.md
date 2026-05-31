---
"adcontextprotocol": patch
---

Fix hosted compliance target recovery after temporary `adcp.supported_versions`
declaration regressions. Diagnostic storyboard flows now re-derive the hosted
target from the agent's live supported versions, preferring `3.1-rc`, then
`3.1-beta`, then `3.0`; canonical badge-writing flows keep the stable `3.0`
target when the agent still advertises it and only fall forward when no stable
target is available. Canonical flows now also revoke stale public `3.0` badges
when confirmed capabilities no longer advertise `3.0` support.

Also patch the affected `media_buy_state_machine`,
`measurement_terms_rejected`, and universal idempotency fixture copies to use
forward-looking Q3 2026 windows, repair selected prerelease
`measurement_terms_rejected` idempotency aliases, and fail the compliance build
when a mutating storyboard step authors a stable or duplicate generated
`idempotency_key`.
