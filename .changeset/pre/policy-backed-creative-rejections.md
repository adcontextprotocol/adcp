---
"adcontextprotocol": minor
---

Add creative rejection conformance for the one-policy-per-error invariant. The new controller-gated `creative/policy_backed_rejections` storyboard first discovers an isolated product that declares exactly the automatic-redirect and HTTPS-only registry policies, then submits a canonical hosted display tag that deterministically violates both. Conformance requires exactly two `CREATIVE_REJECTED` entries with one `details.policy_id` each. The runner contract also publishes the reusable `array_length` assertion used to grade exact error cardinality.
