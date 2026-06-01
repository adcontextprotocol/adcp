---
"adcontextprotocol": minor
---

Add `media_buy.creative_approval_mode` to `get_adcp_capabilities` so sellers can declare whether human review can block serving eligibility after creatives are assigned and automated validation passes.

Sellers with any reachable manual-review workflow declare `require_human`, which lets compliance runners skip auto-approval-dependent storyboards instead of reporting false failures. Omission is legacy-unspecified rather than an affirmative `auto_approve` claim; the `pending_creatives_to_start` storyboard now runs only when sellers explicitly declare `auto_approve`.
