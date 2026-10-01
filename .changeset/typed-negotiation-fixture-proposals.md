---
"adcontextprotocol": patch
---

Fix training-agent `request_proposals`: a brief/criteria-based request (no explicit `product_ids`) in a `comply_test_controller`-seeded session now builds a proposal from the seeded fixture products matching `required_media_buy_support`/`media_buy_frequency_cap`, instead of returning `outcome: rejected`. The proposal-construction path previously only handled seeded fixtures when the caller passed explicit `product_ids`.
