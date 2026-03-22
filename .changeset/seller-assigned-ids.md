---
"adcontextprotocol": major
---

Remove buyer_ref, buyer_campaign_ref, and campaign_ref. Seller-assigned media_buy_id and package_id are canonical. Add idempotency_key to all mutating requests. Replace structured governance-context.json with opaque governance_context string in protocol envelope and check_governance.
