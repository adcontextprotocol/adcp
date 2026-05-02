---
---

Fix `acquire_rights` step in brand-rights storyboard: capture `rights_id` from the response, not `rights_grant_id`.

`brand/acquire-rights-response.json` defines the field as `rights_id`, but the storyboard YAML was authored against an earlier `rights_grant_id` naming and never reconciled. Spec-compliant brand-rights agents passed `response_schema` validation but failed `context_outputs` capture, which cascade-skipped `rights_enforcement`. The storyboard-internal context key (`rights_grant_id`) is preserved so no other steps need updates. Also corrects the step's `expected:` prose to match (`rights_id` + `status: acquired`). Closes #3892.
