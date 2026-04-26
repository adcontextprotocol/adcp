---
name: call-adcp-agent
description: Wire-level invariants for any AdCP buyer call — idempotency_key replay semantics, account `oneOf` variants, async `status:'submitted'`+`task_id` polling, error recovery from `adcp_error.issues[]`. Load before any per-protocol task skill (adcp-media-buy, adcp-creative, adcp-signals, adcp-governance, adcp-si, adcp-brand) when calling an AdCP agent as a buyer.
adcp_version: "3.x"
type: cross-cutting
---

# Call an AdCP agent

## Overview

AdCP (Ad Context Protocol) agents expose a fixed tool surface (`get_products`, `create_media_buy`, `get_signals`, …) over MCP or A2A. Tool names come from `get_adcp_capabilities`; exact request/response shapes come from `get_schema(tool_name)` when the agent exposes it, otherwise from the bundled JSON Schemas your SDK ships (the layout differs by SDK — see "Discovery chain" below). This skill teaches the invariants that don't live cleanly in any schema: cross-tool patterns, async flow, error recovery.

## When to Use

- User wants to call a publisher / SSP / retail media network over AdCP
- Tool names like `get_products`, `create_media_buy`, `sync_creatives`, `get_signals` appear in the available-tools list
- Agent card advertises `protocolVersion: '0.3.0'` with `skills` listing AdCP tool names
- **Not this skill:** building an AdCP seller agent (see `@adcp/client/skills/build-seller-agent/` and analogous SDK skills)

## Discovery chain

Walk these in order on first contact:

1. **Agent card** (A2A) or **`tools/list`** (MCP): returns tool NAMES. AdCP MCP servers no longer publish per-tool parameter schemas in `tools/list` — everything shows `{type: 'object', properties: {}}`. Don't try to infer shape from here.
2. **`get_adcp_capabilities`**: returns supported protocols (`media_buy`, `signals`, `creative`, …), AdCP major versions, feature flags. Tells you WHICH tools this agent supports, not how to call them.
3. **`get_schema(tool_name)`** *(when the agent exposes it — pending standardization in [#3057](https://github.com/adcontextprotocol/adcp/issues/3057), not yet universal)*: returns the JSON Schema for a tool's request/response. Preferred over reading bundled schemas when available.
4. **Bundled schemas** (offline, authoritative): every SDK ships the AdCP JSON Schemas locally. Path differs by SDK — spec repo source uses `dist/schemas/<version>/bundled/`, `@adcp/client` puts them at `schemas/cache/<version>/bundled/` after `npm run sync-schemas`, Python and Go SDKs use their own conventions. **Don't hardcode a path** — let the SDK's loader find them, or ask the developer. Each schema is `<protocol>/<tool>-{request,response}.json` once you locate the bundle. The canonical source for every SDK is `https://adcontextprotocol.org/protocol/<version>.tgz`.

## Non-obvious rules every buyer must follow

### `idempotency_key` is required on every mutating tool

UUID format. The key is your retry-safety guarantee — and the most common way naive callers create duplicate media buys is by misunderstanding it:

- **Same key on retry → replay.** The server returns the SAME response — same `task_id`, same `media_buy_id`, same shape, byte-for-byte. Use this for transport-level retries (timeout, 5xx, dropped connection).
- **Fresh key on retry → NEW operation.** Generating a new UUID because the previous attempt failed is how you double-book. Reuse the key until you've seen a terminal response (success, error, or non-retryable error).
- **Same key, different body → server-defined.** Most agents return the original cached response and ignore the body change. Don't rely on it — pick a fresh key only when you genuinely want a new operation.
- For async flows, the replayed response carries the **same `task_id`**, so polling continues against the same task instead of forking a duplicate.

Required on: `create_media_buy`, `update_media_buy`, `sync_creatives`, `sync_audiences`, `sync_accounts`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `activate_signal`, `acquire_rights`, `log_event`, `report_usage`, `provide_performance_feedback`, `report_plan_outcome`, `create_property_list`, `update_property_list`, `delete_property_list`, `create_collection_list`, `update_collection_list`, `delete_collection_list`, `create_content_standards`, `update_content_standards`, `calibrate_content`, `si_initiate_session`, `si_send_message`.

Missing the key → `adcp_error.code: 'VALIDATION_ERROR'` with `/idempotency_key` in `issues`.

### `account` is a `oneOf` — pick ONE variant, send ONLY its fields

Probably the single most common stumble for naive LLMs. `account` is a discriminated union. Per AdCP 3.0, two variants on `create_media_buy` / `update_media_buy`:

```json
// variant 0: by seller-assigned id (from sync_accounts or list_accounts)
"account": { "account_id": "seller_assigned_id" }

// variant 1: by natural key (brand + operator, optional sandbox)
"account": { "brand": { "domain": "acme.com" }, "operator": "sales.example" }
```

**Do NOT merge required fields across variants** — `additionalProperties: false` on each variant means `{account_id, brand}` fails BOTH. Pick one variant and send only its fields. Always check the specific tool's schema because other tools (e.g. `sync_creatives`) may accept a superset.

### `brand` takes `{domain}` — not `{brand_id}`

```json
"brand": { "domain": "acme.example" }
```

### Async responses: `status: 'submitted'` means "queued, poll later"

A mutating tool can return one of three shapes:

```json
// Success (sync): the work is done
{ "media_buy_id": "mb_123", "packages": [...], "confirmed_at": "..." }

// Submitted (async): the work is queued
{ "status": "submitted", "task_id": "tk_abc", "message": "Awaiting IO signature" }

// Error: don't retry without fixing
{ "errors": [{ "code": "PRODUCT_NOT_FOUND", "message": "..." }] }
```

When you see `status: 'submitted'`, the work is NOT complete. Poll via `tasks/get` (A2A) or the MCP async task extension, using the `task_id`. Over A2A the AdCP `task_id` also rides on `artifact.metadata.adcp_task_id` — both work.

### `packages[*]` on media buys

```json
"packages": [
  { "buyer_ref": "pkg_1", "product_id": "p_from_catalog", "budget": 10000, "pricing_option_id": "po_xyz" }
]
```

`budget` is a **number** (not `{amount, currency}` — currency is implied by the pricing option). Required per package: `product_id`, `budget`, `pricing_option_id`. `buyer_ref` is optional but strongly recommended as a buyer-side correlation id across retries and reporting.

## Error envelope — read `issues[]` to recover

Every validation failure produces:

```json
{
  "adcp_error": {
    "code": "VALIDATION_ERROR",
    "recovery": "correctable",
    "field": "/first/offending/pointer",
    "issues": [
      {
        "pointer": "/account",
        "keyword": "oneOf",
        "message": "must match exactly one schema in oneOf",
        "variants": [
          { "index": 0, "required": ["account_id"],        "properties": ["account_id"] },
          { "index": 1, "required": ["brand", "operator"], "properties": ["brand", "operator", "sandbox"] }
        ]
      },
      { "pointer": "/brand/domain", "keyword": "required", "message": "must have required property 'domain'" }
    ]
  }
}
```

- `issues[].pointer` — RFC 6901 JSON Pointer to the field.
- `issues[].keyword` — AJV keyword (`required`, `type`, `oneOf`, `anyOf`, `additionalProperties`, `format`, `enum`).
- `issues[].variants` — when the keyword is `oneOf` or `anyOf`, each entry lists one variant's `required` + declared `properties`. **Pick ONE variant**, send only its `required` fields. This is the fastest recovery path when you didn't know the field was a union.

Patch the pointers, don't re-guess what the skill or the `variants` already told you, resend. Three attempts should cover every field.

## Minimal working examples

### get_products

```json
{
  "buying_mode": "brief",
  "brief": "premium CTV sports inventory for live NBA finals in major US markets"
}
```

Returns `{ products: [{ product_id, name, description, delivery_type, pricing_options, ... }] }`.

### create_media_buy

```json
{
  "idempotency_key": "<uuid>",
  "account": { "account_id": "seller_assigned_id" },
  "brand": { "domain": "acme.example" },
  "start_time": "2026-05-01T00:00:00Z",
  "end_time": "2026-05-31T23:59:59Z",
  "packages": [
    {
      "buyer_ref": "pkg_1",
      "product_id": "<product_id from get_products>",
      "budget": 10000,
      "pricing_option_id": "<pricing_option_id from product.pricing_options>"
    }
  ]
}
```

If you don't have a `seller_assigned_id`, use the natural-key variant instead:
`"account": { "brand": { "domain": "acme.example" }, "operator": "sales.example" }`.

Returns **either** `{ media_buy_id, packages: [...], confirmed_at }` (sync) **or** `{ status: 'submitted', task_id, message }` (async — guaranteed / IO-signed flows).

### sync_creatives

```json
{
  "idempotency_key": "<uuid>",
  "account": { "account_id": "seller_assigned_id" },
  "creatives": [
    {
      "creative_id": "cr_1",
      "name": "My Creative",
      "format_id": { "agent_url": "https://creatives.adcontextprotocol.org", "id": "video_1920x1080" },
      "assets": {}
    }
  ]
}
```

Per-creative required: `creative_id`, `name`, `format_id: { agent_url, id }`, `assets` (shape depends on `format_id`; start with `{}` then fill required asset keys per format spec). Returns `{ creatives: [{ creative_id, action, status }] }` — items may fail individually without failing the batch.

### get_signals

```json
{
  "signal_spec": "female professionals 25-54 in major US metros"
}
```

Returns `{ signals: [{ signal_agent_segment_id, match_rate, pricing, ... }] }`. Note: the identifier field is `signal_agent_segment_id` (not `signal_id`) — used as input to `activate_signal` below.

### activate_signal

```json
{
  "idempotency_key": "<uuid>",
  "signal_agent_segment_id": "sig_premium_ctv_sports",
  "destinations": [
    { "type": "platform", "platform": "the-trade-desk" }
  ]
}
```

`destinations[]` is a `oneOf`: either `{type: 'platform', platform, account?}` OR `{type, agent_url, account?}`. Pick one shape per destination.

## Transport notes

- **MCP**: `tools/call` with `{ name: 'tool_name', arguments: {...} }`. Returns `{ content, structuredContent, isError? }`. Read `structuredContent` for the typed response.
- **A2A**: `message/send` with a `DataPart` of shape `{ skill: 'tool_name', input: {...} }` (the legacy key `parameters` is also accepted). Returns an A2A `Task`; the typed response is at `task.artifacts[0].parts[0].data`.

Both transports share: idempotency, error shape, schema enforcement, and handler semantics. If a call works on one, the equivalent call works on the other.

## Gotchas I keep seeing

1. **Merging `oneOf` variants**: see the account section above. If you see three `additionalProperties` errors under one pointer, you merged. Drop to one variant.
2. **`budget` as an object**: it's a number. Currency comes from the `pricing_option`.
3. **`brand.brand_id` instead of `brand.domain`**: spec uses `domain`.
4. **Forgetting `idempotency_key`**: required on every mutating tool; see the list above.
5. **Treating A2A `Task.state: 'completed'` as AdCP completion**: A2A task state = transport call lifecycle. AdCP-level completion is in the artifact's payload (`structuredContent.status` or `data.status`). A `completed` A2A task can still carry a `submitted` AdCP response.
6. **`format_id` as a string**: `format_id` is always an object `{ agent_url, id }` (and sometimes `{ width, height, duration_ms }` for dimensions). Sending `"format_id": "video_1920x1080"` fails with an `additionalProperties` / `type` error — pass the object.

## Symptom → fix

Quick lookup before reading the full envelope. Match what you see in `adcp_error.issues[*]`, apply the fix:

| Symptom | What it means | Fix |
|---|---|---|
| `keyword: 'oneOf'` with `variants[]` | Discriminated union — you sent fields from multiple variants, or none | Pick ONE variant from `variants[]`. Send only its `required` fields. |
| 2-3 `additionalProperties` errors at the same pointer | You merged `oneOf` variants ({account_id, brand, operator, …}) | Drop to one variant. Don't keep "extra" fields "for completeness". |
| `keyword: 'required'`, `pointer: '/idempotency_key'` | Mutating tool, no UUID | Generate fresh UUID per logical operation. Reuse it on retries. |
| `keyword: 'type'` or `additionalProperties` at `/budget` | Sent `{amount, currency}` | `budget` is a number. Currency is implied by `pricing_option_id`. |
| `additionalProperties` at `/format_id` (string passed) | Sent `"format_id": "video_..."` | `format_id` is `{agent_url, id}` — always an object. |
| `keyword: 'enum'` at `/destinations/*/type` | Made-up destination type | Use `'platform'` (with `platform`) or `'agent'` (with `agent_url`). |
| Response carries `status: 'submitted'` and `task_id` | Async — work is queued, NOT done | Poll via `tasks/get` (A2A) or the MCP async task extension using `task_id`. |
| `recovery: 'transient'` (rate limit, 5xx, timeout) | Server-side, retry-safe | Retry with the **same** `idempotency_key`. |
| `recovery: 'correctable'` | Buyer-side fix | Read `issues[]`, patch the pointers, resend. Most cases close in one attempt. |
| `recovery: 'terminal'` (account suspended, payment required, …) | Requires human action | Don't retry. Surface to the user. |
| HTTP 401 with `WWW-Authenticate` header | Missing or expired credential | Add `Authorization` per the agent's auth spec; re-auth if applicable. |

If your symptom isn't here, fall through to the next section.

## If you get stuck

Priority order:

1. Re-read the failure's `issues[]`. The pointer list plus this skill covers 80% of cases.
2. Call `get_schema(tool_name)` if the agent exposes it (see [#3057](https://github.com/adcontextprotocol/adcp/issues/3057) for the pending standard).
3. Read the bundled JSON Schema for `<protocol>/<tool>-request.json` — see Discovery chain step 4 for path resolution. If you can't locate the SDK's schema cache, ask the developer or fall back to `get_schema()`.
4. Consult the per-protocol skill (`adcp-media-buy`, `adcp-creative`, …) for specialism-specific patterns.

## Related

- [Calling an agent (docs)](https://adcontextprotocol.org/docs/protocol/calling-an-agent) — human-readable narrative form of this skill
- `skills/adcp-media-buy/`, `skills/adcp-creative/`, `skills/adcp-signals/`, `skills/adcp-governance/`, `skills/adcp-si/`, `skills/adcp-brand/` — per-protocol task skills (layered on top of this one)
- `@adcp/client/skills/build-seller-agent/SKILL.md` — building agents on the other side of the call
- Bundled JSON Schemas — canonical for every tool, version-pinned. Path differs by SDK (see Discovery chain step 4). Pulled from the protocol tarball at `/protocol/<version>.tgz`.
