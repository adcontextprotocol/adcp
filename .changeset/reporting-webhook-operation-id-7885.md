---
"adcontextprotocol": minor
---

feat(schema): add `operation_id` to `core/reporting-webhook.json` (fixes #7885).

`media_buy_delivery` webhook payloads require `operation_id`, but a buyer who registers only `reporting_webhook` in `create_media_buy` had no way to supply one — sellers had to invent a value (spec-forbidden), emit a schema-invalid payload, or send nothing (Embedded Sales Agent fails closed and skips delivery webhooks entirely). The registration schema now carries `operation_id` with the same constraints as `push_notification_config.operation_id` (`minLength: 1`, `maxLength: 255`, `^[A-Za-z0-9_.:-]{1,255}$`).

Behavior rules: the seller MUST echo the buyer-supplied value verbatim into every webhook payload's `operation_id` field on each `media_buy_delivery` report sent to that registration, and MUST NOT derive it by parsing the reporting webhook URL (the URL is opaque to the seller). The member is optional in 3.x for schema compatibility, but a seller MUST NOT emit `media_buy_delivery` webhooks to a registration that omits it — the fail-closed behavior is now the specified behavior; the field is expected to become required in 4.0.

Minor classification: this adds an optional field with normative echo rules, landing on the 3.3 line on main. It does not alter any previously-conformant emission that carried an operation_id, and previously-conformant sellers that omitted it were already unable to emit a schema-valid `media_buy_delivery` payload for these registrations.
