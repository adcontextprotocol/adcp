---
---

spec(adagents): tighten `revoked_publisher_domains[]` — rollback resilience, un-revoke flow, `compliance_violation` framing

Closes the four semantic gaps identified in #4507 after PR #4504's revocation block landed.

1. **Append-only durability on the validator side.** A `(publisher_domain, revoked_at)` tuple that a validator has previously observed MUST be treated as still-revoked for 7 days from the validator's first observation, even if the entry vanishes from a subsequent fetch. Closes the rollback gap where an attacker re-serves a stale file with `revoked_publisher_domains[]` removed and `last_updated` advanced — the existing non-monotonic-`last_updated` check only fires on backward `last_updated`. Durability now lives on the validator's cached state, not on the network's retention SHOULD.

2. **Re-authorization flow.** Documented the un-revoke procedure: networks remove the entry from `revoked_publisher_domains[]` only *after* the 7-day validator durability window has elapsed since `revoked_at`. Removing sooner is a no-op against validators that observed the original revocation. For time-bounded compliance pulls, prefer out-of-band coordination — the schema deliberately doesn't expose a re-authorize-before-7-days back door, which would be indistinguishable from a rollback attack.

3. **`compliance_violation` framing.** Tightened the `reason` enum description: operator-internal self-classification for review routing, not a public accusation. Recommended `other` for un-adjudicated third-party allegations (regulator inquiries, advertiser complaints, ongoing investigations) to avoid discoverable adverse statements about the publisher. Compared to sellers.json, which carries no reason field for the same exposure reason.

4. **Extension-field disclaimer.** Added a one-liner noting that extension fields on revocation entries have no normative effect — validators MUST ignore unknown fields, and extensions cannot loosen revocation semantics or carry side-channel reinstatement signals.

Files touched: `docs/governance/property/managed-networks.mdx`, `static/schemas/source/adagents.json` (description-only changes, no field additions). Existing files validate unchanged.
