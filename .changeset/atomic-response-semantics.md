---
"adcontextprotocol": minor
---

Enforce atomic operation semantics with success XOR error response pattern. Task response schemas now use `oneOf` discriminators to ensure responses contain either complete success data OR error information, never both, never neither.

**Response Pattern:**

All mutating operations (create, update, build) now enforce strict either/or semantics:

1. **Success response** - Operation completed fully:
   ```json
   {
     "media_buy_id": "mb_123",
     "buyer_ref": "campaign_2024_q1",
     "packages": [...]
   }
   ```

2. **Error response** - Operation failed completely:
   ```json
   {
     "errors": [
       {
         "code": "INVALID_TARGETING",
         "message": "Tuesday-only targeting not supported",
         "suggestion": "Remove day-of-week constraint or select all days"
       }
     ]
   }
   ```

**Why This Matters:**

Partial success in advertising operations is dangerous and can lead to unintended spend or incorrect targeting. For example:
- Buyer requests "US targeting + Tuesday-only dayparting"
- Partial success returns created media buy without Tuesday constraint
- Buyer might not notice error, campaign runs with wrong targeting
- Result: Budget spent on unwanted inventory

The `oneOf` discriminator enforces atomic semantics at the schema level - operations either succeed completely or fail completely. Buyers must explicitly choose to modify their requirements rather than having the system silently omit constraints.

**Updated Schemas:**

All schemas now use `oneOf` with explicit success/error branches:

- `create-media-buy-response.json` - Success requires `media_buy_id`, `buyer_ref`, `packages`; Error requires `errors` array
- `update-media-buy-response.json` - Success requires `media_buy_id`, `buyer_ref`; Error requires `errors` array
- `build-creative-response.json` - Success requires `creative_manifest`; Error requires `errors` array
- `provide-performance-feedback-response.json` - Success requires `success: true`; Error requires `errors` array
- `webhook-payload.json` - Uses conditional validation (`if/then` with `allOf`) to validate result field against the appropriate task response schema based on task_type. Ensures webhook results are properly validated against their respective task schemas. Updated example to show error-only response for input-required status.

**Schema Structure:**

```json
{
  "oneOf": [
    {
      "description": "Success response",
      "required": ["media_buy_id", "buyer_ref", "packages"],
      "not": {"required": ["errors"]}
    },
    {
      "description": "Error response",
      "required": ["errors"],
      "not": {"required": ["media_buy_id", "buyer_ref", "packages"]}
    }
  ]
}
```

The `not` constraints ensure responses cannot contain both success and error fields simultaneously.

**Benefits:**

- **Safety**: Prevents dangerous partial success scenarios in advertising operations
- **Clarity**: Unambiguous success vs failure - no mixed signals
- **Validation**: Schema-level enforcement of atomic semantics
- **Consistency**: All mutating operations follow same pattern

**Exception: Batch Operations**

`sync_creatives` is intentionally excluded from this pattern because it processes multiple independent items. Per-item success/failure in the results array is appropriate for batch operations where failing the entire batch would hurt UX.

**Migration:**

This is a backward-compatible change. Existing valid responses (success with all required fields) continue to validate successfully. The change prevents invalid responses (missing required success fields or mixing success/error fields) that were technically possible but semantically incorrect.

**Alignment with Protocol Standards:**

This pattern aligns with both MCP and A2A error handling:
- **MCP**: Tool returns either result content OR sets `isError: true`, not both
- **A2A**: Task reaches terminal state `completed` OR `failed`, not both
- **AdCP**: Task payload contains success data XOR errors, enforced at schema level
