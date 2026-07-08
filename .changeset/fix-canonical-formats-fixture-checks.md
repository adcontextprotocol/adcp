---
"adcontextprotocol": patch
---

Fix `canonical_supported_formats` storyboard: replace hardcoded `capability_id` value assertion with `field_present` check.

`creative.supported_formats[].capability_id` is an agent-local stable identifier — a free-form string that each creative agent defines independently. The storyboard incorrectly used `check: field_value` with the hardcoded value `"training_image_generation"`, causing every creative agent whose capability id differs from the fixture constant to fail this phase. The protocol schema (`get-adcp-capabilities-response.json`) defines `capability_id` as a free-form string with no enum constraint; the storyboard narrative itself states it is "agent-local". Changed to `check: field_present` so the check validates structure rather than a fixture-specific constant.

Also removed a companion `field_absent` check on `creative.supported_formats[1].capability_id` whose own description identified it as a fixture constraint ("only advertises implemented canonical build paths") rather than a protocol requirement. Storyboards must not encode fixture-specific catalog shape as required validations.
