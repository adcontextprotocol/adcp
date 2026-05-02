---
"adcontextprotocol": minor
---

Add `media_buy.supports_proposals` capability flag to `get_adcp_capabilities` response (closes #3844).

**Problem:** The `proposal_finalize` conformance storyboard had no capability gate, meaning every `sales-guaranteed` seller would eventually be required to grade against it — including auction-based PG, retail SKU, and quoted-rate direct-buy sellers that have no proposal engine.

**Change:** `get-adcp-capabilities-response.json` gains an optional boolean `supports_proposals` under `media_buy`. When `true`, the seller commits to the full proposal lifecycle against the standard conformance brief: `buying_mode: 'brief'` returning `proposals[]`, `buying_mode: 'refine'` returning an updated proposal, and `buying_mode: 'refine'` with `action: 'finalize'` transitioning the proposal to committed status. When `false` or absent, the seller serves products directly without proposal abstraction.

`static/compliance/source/protocols/media-buy/scenarios/proposal_finalize.yaml` gains a `requires_capability: { path: media_buy.supports_proposals, equals: true }` gate so the storyboard runner can skip the scenario as `capability_unsupported` for sellers that do not declare proposal support.

**Non-breaking:** Fully additive. The field is optional with no default; `media_buy` has no `additionalProperties: false` constraint; existing `get_adcp_capabilities` responses and validators are unaffected. The storyboard `requires_capability` gate only adds skip paths — sellers that previously graded `proposal_finalize` as not applicable continue to do so.

**Sequencing:** This is step 1 of the sales-proposal-mode deprecation path (#3823 item 4, #3840). Step 2 (adding `proposal_finalize` to `sales-guaranteed.requires_scenarios`) follows once the runner's `requires_capability` predicate is confirmed. Step 4 (4.0 removal of `sales-proposal-mode` enum value) follows at the next major.
