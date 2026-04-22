---
---

Bump @adcp/client to 5.11.0 to pick up the storyboard runner fix that
honors `step.sample_request` in the `get_rights` request builder
(adcontextprotocol/adcp-client#792).

Restores the `brand_rights/governance_denied` scenario (and peer
brand-rights scenarios) that relied on scenario-specific `query` /
`uses` / `buyer` fields. With the prior builder, `get_rights` hit
the wire with a generic fallback and a caller-domain `brand_id`,
so `rights[0]` was undefined, `$context.rights_id` didn't resolve,
and `acquire_rights` failed with `rights_not_found` before the
training agent's existing `GOVERNANCE_DENIED` check could fire.

CI floors rebaselined: legacy 36→43 clean / 295→336 steps,
framework 21→25 clean / 241→244 steps.

Closes #2846.
