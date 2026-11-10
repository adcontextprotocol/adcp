---
"adcontextprotocol": patch
---

Open the 3.2 schemas that were closed by accident, so a 3.2 validator no longer rejects a newer 3.x payload because it carries a field 3.2 does not know. Backports the 3.3 opening decided by the working group on 2026-11-09.

`additionalProperties` goes from `false` to `true` at 674 of the 775 closed locations in the 3.2 source tree.

101 locations stay closed, matching 3.3: most for a structural reason, and the commercial terms as a hold until 4.0.

- `oneOf` branches told apart only by which keys are present (`a2ui/bound-value.json`, `brand.json`).
- Metric qualifiers and forecast dimensions, which consumers join on.
- The JWS response envelope.
- Privacy boundaries: the TMP match requests, the not-found error, the per-agent permission-denied and billing-not-permitted details, the `get_principal` recognized, unconfigured and failed results, the failed `sync_principal` result, and the `get_reporting_status` unavailable-lookup result.
- The credential-free reporting destinations and the destination `setup` action.
- `placement-presentation`, which carries no key material or markup.
- `patternProperties` maps keyed by IDs.
- Held closed until 4.0: the commercial terms and the hard `proposal-budget-constraint`. This is a hold, not a structural reason; 4.0 gives `commercial_terms` a declared extension point with must-understand.

Where closure was the only thing rejecting a specific field that the protocol defines elsewhere or forbids (for example `trackers` on `unassign`, `staged_update` on `creative.status_changed`, `auth_token` on list-application receipts, or credentials on a notification-config readback), the opened schema now rejects that field by name with `not`. `access_token` on the delivery-ready webhook is rejected as a credential clamp. The same applies to unions whose branches were told apart only by which keys are present: an account ref, compact or not, carries `account_id` or the natural key, not both; a geo-region country entry carries `all_values` or `values`; image bleed is uniform or per-side; a deprecated fused-system postal area carries no `country`; and a reporting-receipt result carries `receipt` or `adjustment_receipt`, a failed one neither. Each node with a named rejection says in its description what it rejects and why, since generated types cannot express `not`. Descriptions of opened schemas no longer say they are closed.

The MCP model-context projection now omits `additionalProperties: true` as well as `false`, since `true` is the JSON Schema default.
