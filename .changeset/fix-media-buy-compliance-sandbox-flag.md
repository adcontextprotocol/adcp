---
---

fix(compliance): add sandbox: true to create_media_buy sample_requests that use fixture product IDs

Four media_buy_seller storyboard steps sent fixture product IDs (sports_preroll_q2, outdoor_ctv_q2, outdoor_display_q2, outdoor_video_q2) and a synthetic proposal_id (balanced_reach_q2) in create_media_buy sample_requests without sandbox: true on the account reference. Seller agents correctly reject unknown IDs with PRODUCT_NOT_FOUND under real catalog validation, causing the harness to report false failures against the seller.

Fixed by adding sandbox: true to the account natural key in the sample_request of:
- protocols/media-buy/index.yaml (create_buy/create_media_buy)
- protocols/media-buy/scenarios/governance_conditions.yaml (buy_with_conditions/create_media_buy_conditions)
- protocols/media-buy/scenarios/proposal_finalize.yaml (accept_proposal/create_media_buy)
- protocols/media-buy/scenarios/governance_denied.yaml (buy_denied/create_media_buy_denied)

Scenarios with controller_seeding: true and explicit fixtures blocks (governance_approved.yaml, delivery_reporting.yaml) are not affected — those product IDs are seeded into the seller's test environment before the scenario runs.
