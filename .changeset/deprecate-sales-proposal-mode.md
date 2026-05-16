---
"adcontextprotocol": minor
---

spec(specialisms): deprecate sales-proposal-mode (refs #3823 item 4, #3844)

Proposal mode is how guaranteed deals get sold in practice — RFP → proposal → review → finalize → IO signing → live. Auction-based sales don't have proposals; they're bid-by-bid. Today `sales-proposal-mode` (proposals + briefs) and `sales-guaranteed` (IO + guaranteed) are halves of the same flow that force sellers to declare both or pick the wrong one.

Following the established `signed-requests` precedent (deprecated in 3.1, retained until 4.0):

- Adds `sales-proposal-mode` to `x-deprecated-enum-values` in `static/schemas/source/enums/specialism.json`
- Updates `enumDescriptions[sales-proposal-mode]` with the deprecation note + migration path
- Adds a deprecation banner to the storyboard at `static/compliance/source/specialisms/sales-proposal-mode/index.yaml`
- Updates `sales-guaranteed`'s narrative to explain how proposal flows relate to guaranteed selling and why proposal_finalize is not yet folded into its `requires_scenarios`

The clean folding of `proposal_finalize` into `sales-guaranteed.requires_scenarios` (so both flavors of guaranteed selling grade against the proposal lifecycle) needs a wire-level capability flag the storyboard runner can use to skip the scenario as `not_applicable` for direct-buy guaranteed sellers (auction PG, retail SKU; no RFP). The runner gates only on `requires_capability` predicates against `get_adcp_capabilities`, not on scenario-level metadata. Tracked as a follow-up in #3844 (`add supports_proposals capability flag`).

**Migration through 3.x**: sellers that do proposals continue to declare BOTH `sales-guaranteed` AND `sales-proposal-mode` so the proposal flow grades under the proposal-mode specialism's existing storyboard bundle. Pure-direct-buy guaranteed sellers (auction PG, retail SKU) declare only `sales-guaranteed`. The wire shape is unchanged — both enum values remain valid through 3.x.

**At 4.0**: with the `supports_proposals` capability flag in place (#3844), `proposal_finalize` joins `sales-guaranteed.requires_scenarios` with capability-gated skip semantics, the `sales-proposal-mode` enum value is removed, and the storyboard bundle is retired.
