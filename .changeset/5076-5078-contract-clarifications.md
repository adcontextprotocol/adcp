---
"adcontextprotocol": minor
---

Clarify media-buy and creative contract edge cases for the 3.1 beta.

Adds normative guidance for canonical-format matching: legacy named formats are normalized before comparison, product capability checks are directional, under-specified requests do not satisfy fixed product constraints, and range constraints require containment rather than overlap.

Documents the stored-creative adapter handoff boundary: buyers send only `creative_id` on the AdCP wire, while any generic `id` alias is seller-side adapter compatibility data copied from `creative_id`.

Tightens media-buy lifecycle semantics by requiring `revision` on create/get/update success responses and requiring `confirmed_at` on created/read media buys while allowing `null` only for provisional buys that already have a `media_buy_id` and are retrievable before seller commitment.

This is a 3.1 beta schema tightening that catches the schemas up to existing normative `MUST` text for `revision` and commitment timestamps, rather than a new post-GA contract. The nullable `confirmed_at` shape is buyer-observable (`string | null` instead of only `string`) so buyers can distinguish committed synchronous creates from provisional buys that exist but are not yet seller-committed.
