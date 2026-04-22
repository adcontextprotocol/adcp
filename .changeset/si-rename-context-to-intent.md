---
"adcontextprotocol": minor
---

**Breaking (SI, experimental):** On `si_get_offering` and `si_initiate_session` requests, the natural-language user-intent field is renamed from `context` to `intent`. `context` on these requests now refers to the universal opaque-echo object (`/schemas/core/context.json`), matching every other AdCP subprotocol. `si_terminate_session` already conformed and is unchanged. Treated as `minor` under the experimental-surface carve-out (`x-status: experimental` + 6-week notice policy from `docs/reference/experimental-status`). SI consumers must rename the field and stop relying on `context` being typed as a string. Closes #2774.
