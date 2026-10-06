---
"adcontextprotocol": minor
---

Clarify `build_creative` refinement compliance: the parent leaf's `compliance` set (`required_disclosures`, `prohibited_claims`) carries forward to every refinement leaf and cannot be removed or narrowed by `message`/`config`; an instruction that drops or contradicts a required disclosure fails the call with `COMPLIANCE_UNSATISFIED` (description extended, no new code); and a refined leaf never inherits its parent's approval state. No new fields.
