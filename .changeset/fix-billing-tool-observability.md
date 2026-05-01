---
---

fix(addie): emit billing_tool_failed events and detect empty turns (#3721)

Closes the silent-failure gap in Addie's billing tools:

- `billing_tool_failed` person event emitted from every `{ success: false }` path in `send_invoice`, `confirm_send_invoice`, and `create_payment_link`, with `tool`, `lookup_key`, `auth_status`, and `org_id` payload fields for observability.
- `action_required` annotation added to every billing tool failure response so the model is instructed to relay the error to the user rather than producing an empty message.
- `addie_empty_turn` person event emitted (bolt-app.ts and handler.ts) when `applyResponsePipeline` substitutes the empty-turn fallback, and the interaction log is flagged accordingly.
- New `PersonEventType` union members: `billing_tool_failed` and `addie_empty_turn`.
- Prompt rule added to `constraints.md` (Case 4 under "Tool Outcomes") teaching Addie to relay `{ success: false }` billing errors near-verbatim.
- Unit tests in `billing-tool-lockdown.test.ts` assert event emission, `action_required` presence, and no-personId suppression. Tests in `response-postprocess.test.ts` assert the new `EMPTY_RESPONSE_FALLBACK_TEXT` export equals the internal fallback.

Non-breaking: additive event types, optional `personId` param, additive prompt rule, no schema changes.
Refs #3721.
