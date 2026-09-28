---
"adcontextprotocol": patch
---

Fix the `reporting_core` storyboard's non-empty exact-read phase so a conformant seller can complete it. The phase now re-prepares the same sandbox account as the obligation lifecycle (`reporting_core_lab`) instead of a second `reporting_core_nonempty_lab` account. Storyboard runners address controller and `get_media_buy_delivery` calls with the test-kit account, so the second account ID named a ledger the controller never wrote to. The two rejection steps (`exact_nonempty_reject_mixed_selector`, `exact_nonempty_reject_rc0`) now declare `expect_error: true`, matching every other storyboard that grades an `error_code`. The fixed RFC 8785/JCS vector and all of its assertions are unchanged.
