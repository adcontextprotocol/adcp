---
---

Fix four storyboard-schema drift issues surfaced by end-to-end seller / brand-rights builds against `@adcp/client`:

- **#2520** — `measurement_terms_rejected` scenarios now send `makegood_policy.available_remedies` (with valid enum values) instead of the stale `makegood_policy.remedy_types`, so the scenario reaches the seller's handler instead of tripping Zod validation.
- **#2517** — `brand_rights/governance_denied` now includes the required `revocation_webhook` and `idempotency_key` on the `acquire_rights` sample; `rights_enforcement.acquire_expired_rights` also gains the missing `idempotency_key`.
- **#2516** — `sales-broadcast-tv` `push_notification_config.authentication` uses the canonical `schemes: […]` + `credentials` shape (was the singular, schema-invalid `scheme:` form), and the delivery-monitoring phase adds `expect_webhook` grading for the C3-supersedes-live and C7-supersedes-C3 `window_update` webhooks (gated on the `webhook_receiver_runner` contract so runs without a receiver grade as not_applicable rather than fail).
- **#2521** — All four governance-handshake scenarios (`governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery`) move out of the media-buy protocol baseline and every `sales-*` specialism into a new opt-in `governance-aware-seller` specialism that owns the full handshake. All four scenarios list `sync_governance` in `required_tools`, so pure sellers without governance composition cannot exercise any of them — gating the whole set behind a single explicit claim parallels the other `governance-*` specialisms (`governance-spend-authority`, `governance-delivery-monitor`).
