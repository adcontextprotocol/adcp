---
"adcontextprotocol": minor
---

spec(specialisms): deprecate sales-proposal-mode — proposal-driven flows merge into sales-guaranteed (refs #3823 item 4)

Proposal mode is how guaranteed deals get sold in practice — RFP → proposal → review → finalize → IO signing → live. Auction-based sales don't have proposals; they're bid-by-bid. Today `sales-proposal-mode` (proposals + briefs) and `sales-guaranteed` (IO + guaranteed) are halves of the same flow that force sellers to declare both or pick the wrong one.

Following the established `signed-requests` precedent (deprecated in 3.1, retained until 4.0), this PR:

- Adds `sales-proposal-mode` to `x-deprecated-enum-values` in `static/schemas/source/enums/specialism.json`
- Updates `enumDescriptions[sales-proposal-mode]` with the deprecation note + migration path
- Adds `media_buy_seller/proposal_finalize` to `sales-guaranteed`'s `requires_scenarios` so the proposal lifecycle actually grades under the new specialism — sellers that declare `generates_proposals` capability grade against the proposal flow, sellers without it grade proposal_finalize as `not_applicable` (the scenario already declares `generates_proposals` capability so the runner skips gracefully)
- Updates `sales-guaranteed`'s narrative to reflect that proposal flows are part of guaranteed selling
- Adds a deprecation banner to the storyboard at `static/compliance/source/specialisms/sales-proposal-mode/index.yaml`

The storyboard bundle and enum value are retained through 3.x for backward compatibility — sellers that declare `sales-proposal-mode` continue to grade against the existing flow without any wire break. New sellers should declare `sales-guaranteed`. At 4.0 the enum value is removed and the storyboard bundle is retired.

Migration for existing sellers: in `get_adcp_capabilities.specialisms[]`, replace `sales-proposal-mode` with `sales-guaranteed` (or declare both during the transition window). The `proposal_finalize` scenario at `static/compliance/source/protocols/media-buy/scenarios/proposal_finalize.yaml` is unchanged — sellers still grade against it through whichever parent specialism they declare.
