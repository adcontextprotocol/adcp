---
"adcontextprotocol": patch
---

Open the 3.2 schemas that were closed by accident, so a 3.2 validator no longer rejects a newer 3.x payload because it carries a field 3.2 does not know. Backports the 3.3 opening decided by the working group on 2026-11-09.

`additionalProperties` goes from `false` to `true` at 671 of the 775 closed locations in the 3.2 source tree.

104 locations stay closed for a structural reason, by the same rules as 3.3:

- `oneOf` branches told apart only by which keys are present (`a2ui/bound-value.json`, `brand.json`).
- The signed commercial terms that `terms_digest` binds, and the hard `proposal-budget-constraint` a seller must understand.
- Metric qualifiers and forecast dimensions, which consumers join on.
- The JWS response envelope.
- Privacy boundaries: the TMP match requests, the not-found error, the per-agent permission-denied and billing-not-permitted details, the `get_principal` and `sync_principal` results, and the `get_reporting_status` unavailable-lookup result.
- The credential-free reporting destinations and the destination `setup` action.
- `placement-presentation`, which carries no key material or markup.
- `patternProperties` maps keyed by IDs.

Where closure was the only thing rejecting a specific field that the protocol defines elsewhere or forbids (for example `trackers` on `unassign`, `staged_update` on `creative.status_changed`, `access_token` on the delivery-ready webhook, `auth_token` on list-application receipts, or credentials on a notification-config readback), the opened schema now rejects that field by name with `not`. Descriptions of opened schemas no longer say they are closed.

The MCP model-context projection now omits `additionalProperties: true` as well as `false`, since `true` is the JSON Schema default.
