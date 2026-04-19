---
"adcontextprotocol": minor
---

Mark Brand Rights Lifecycle, Campaign Governance, and TMP as experimental for AdCP 3.0.

These surfaces are part of the core protocol but are not yet frozen. Sellers implementing them MUST declare the corresponding feature id in `experimental_features`:

- `brand.rights_lifecycle` — `get_rights`, `acquire_rights`, `update_rights` and their support schemas (`rights-pricing-option`, `rights-terms`). Added late in the 3.0 cycle; first enterprise deployments will expose edge cases in partial rights, sublicensing, and revocation.
- `governance.campaign` — `sync_plans`, `check_governance`, `report_plan_outcome`, `get_plan_audit_logs`. Multi-party governance semantics (approval conflicts, audit provenance, tie-breaking) are not yet settled.
- `trusted_match.core` — the full Trusted Match Protocol. Privacy architecture will evolve with regulator engagement; TMPX, country-partitioned identity, and Offer macros are expected to change.

Schemas carry `x-status: experimental`. Task reference pages and the campaign-governance and TMP specifications carry a banner. `experimental_features` on `get_adcp_capabilities` is the machine-readable runtime declaration.

Breaking changes to experimental surfaces require 6 weeks' notice; the full contract is in `docs/reference/experimental-status.mdx`.
