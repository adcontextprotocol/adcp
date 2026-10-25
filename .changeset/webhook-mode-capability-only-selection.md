---
"adcontextprotocol": minor
---

Condition (b) of `request_signature_required` ("payload carries a field that triggers signing regardless of `required_for`") is deprecated in 3.x and removed in 4.0 with the webhook `authentication` block it protects (adcp#7563). It applies only while `legacy_hmac_fallback` is `true`. The documented-exception alternative is recorded as rejected: it makes the verifier parse unauthenticated bytes to decide whether they required authentication.

A verifier now rejects a JSON-RPC batch (a JSON array body) with `request_body_malformed` (SHOULD in 3.2.x, MUST from 3.3, per the existing hardening schedule), replacing the 3.2 interim rule that let a verifier resolve every element (adcp#7565). A signed AdCP request carries exactly one JSON-RPC message.

Conformance: vector `request-signing/negative/027` (and its 3.2 mirror) now declares `applies_when: "webhook_signing.legacy_hmac_fallback == true"` and is graded only for such agents. The functional create fixtures in `media_buy_seller` (two steps), `create_media_buy_async`, `creative_generative/seller` and `sales_broadcast_tv` no longer send `push_notification_config.authentication`, so a signing seller with `legacy_hmac_fallback: false` is not forced to fail either 027 or an unrelated create step. Webhook-emission grading of the 9421 baseline is unchanged.

Composition with the 3.3 rule that `reporting_webhook` and `artifact_webhook` may omit `authentication` (adcp#8177): on those two registrations condition (b) applies only to a request served at 3.3 or later, because `authentication` stays required on a request served below 3.3 and so carries no preference signal there.
