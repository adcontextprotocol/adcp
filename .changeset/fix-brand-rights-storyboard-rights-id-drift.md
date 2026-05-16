---
---

Fix `brand-rights` storyboard `acquire_rights` step capturing `rights_grant_id` instead of `rights_id`. The `context_outputs.path` was authored against a draft field name that was never reconciled with the published `brand/acquire-rights-response.json` schema. Also corrects `expected` prose (`rights_grant_id` → `rights_id`, `status: active` → `status: acquired`). Non-protocol change — storyboard YAML only.
