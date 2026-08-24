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
- A2A 1.0 Agent Card advertises `https://adcontextprotocol.org/extensions/adcp/v3` under `capabilities.extensions[]`, with `skills` listing AdCP task names
- **Not this skill:** building an AdCP seller agent (see `@adcp/client/skills/build-seller-agent/` and analogous SDK skills)

## Discovery chain

Walk these in order on first contact:

1. **Agent card** (A2A) or **`tools/list`** (MCP): returns tool NAMES. For A2A 1.0, confirm the versioned AdCP profile under `capabilities.extensions[]` and activate it with `A2A-Extensions` on every call. Don't infer runtime AdCP capabilities from extension params.
2. **`get_adcp_capabilities`**: returns supported protocols (`media_buy`, `signals`, `creative`, …), AdCP major versions, feature flags. Tells you WHICH tools this agent supports, not how to call them.
3. **`get_schema(tool_name)`** *(when the agent exposes it — pending standardization in [#3057](https://github.com/adcontextprotocol/adcp/issues/3057), not yet universal)*: returns the JSON Schema for a tool's request/response. Preferred over reading bundled schemas when available.
4. **Bundled schemas** (offline, authoritative): every SDK ships the AdCP JSON Schemas locally. Path differs by SDK — spec repo source uses `dist/schemas/<version>/bundled/`, `@adcp/client` puts them at `schemas/cache/<version>/bundled/` after `npm run sync-schemas`, Python and Go SDKs use their own conventions. **Don't hardcode a path** — let the SDK's loader find them, or ask the developer. Each schema is `<protocol>/<tool>-{request,response}.json` once you locate the bundle. The canonical source for every SDK is `https://adcontextprotocol.org/protocol/<version>.tgz`.

## Non-obvious rules every buyer must follow

### `idempotency_key` is required on every mutating tool

UUID format. The key is your retry-safety guarantee — and the most common way naive callers create duplicate media buys is by misunderstanding it:

- **Same key on retry → replay.** The server returns the SAME response — same `task_id`, same `media_buy_id`, same shape, byte-for-byte. Use this for transport-level retries (timeout, 5xx, dropped connection).
- **Fresh key on retry → NEW operation.** Generating a new UUID because the previous attempt failed is how you double-book. Reuse the key until you've seen a terminal response (success, error, or non-retryable error).
- **Same key, different canonical body → `IDEMPOTENCY_CONFLICT`.** Servers MUST reject. Do not silently apply the second body; do not silently replay the first. If your planner re-ran and produced different bytes, the intent changed — mint a new key.
- **Same key while first request still running → `IDEMPOTENCY_IN_FLIGHT`.** Server returns this with top-level `error.retry_after` (seconds) when it doesn't want to block. Wait the hint and retry with the **same key** — minting a fresh key here turns a safe retry into a double-execution race.
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

When you see `status: 'submitted'`, the work is NOT complete. Under the AdCP v3 A2A profile, the enclosing A2A Task is completed and the AdCP `task_id` appears only in the artifact DataPart. Poll by sending fresh profile invocations of `get_task_status` with that `task_id`; do not poll the completed A2A Task and do not look for `artifact.metadata.adcp_task_id`. On MCP, use the AdCP polling task the agent advertises.

### `packages[*]` on media buys

```json
"packages": [
  { "buyer_ref": "pkg_1", "product_id": "p_from_catalog", "budget": 10000, "pricing_option_id": "po_xyz" }
]
```

`budget` is a **number** (not `{amount, currency}` — currency is implied by the pricing option). Required per package: `product_id`, `budget`, `pricing_option_id`. `buyer_ref` is optional but strongly recommended as a buyer-side correlation id across retries and reporting.

### Webhook signing — omit `authentication` for new integrations

When you include `push_notification_config` in a request, do **not** set `authentication`
unless you are integrating with a legacy receiver. Omitting `authentication` selects the
default: the seller signs each inbound webhook POST with its RFC 9421
`adcp_use: "webhook-signing"` key, published at the `jwks_uri` in its own `brand.json`
`agents[]` entry. You verify against the seller's JWKS. No shared secret crosses the wire.

Presence of `authentication` is a **switch, not a fallback** — it opts the seller into
Bearer or HMAC-SHA256 and disables 9421 for that registration. A buyer MUST NOT attempt
"try 9421 first, fall back to HMAC" verification — mode is fixed at registration time.

The `authentication` block (Bearer / HMAC-SHA256) is deprecated and sellers MAY decline
to support it. It is removed in AdCP 4.0. The `token` field (a correlation token echoed
back in the webhook payload) is separate from `authentication` and is not deprecated.

See [Webhook callbacks](https://adcontextprotocol.org/docs/building/implementation/security#webhook-callbacks) for the
full verifier checklist and downgrade-resistance rules.

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

**Required fields — every conformant validator surfaces these:**

- `issues[].pointer` — RFC 6901 JSON Pointer to the field.
- `issues[].keyword` — AJV keyword (`required`, `type`, `oneOf`, `anyOf`, `additionalProperties`, `format`, `enum`).
- `issues[].variants` — when the keyword is `oneOf` or `anyOf`, each entry lists one variant's `required` + declared `properties`. **Pick ONE variant**, send only its `required` fields. This is the fastest recovery path when you didn't know the field was a union.

**Spec-optional wire fields — sellers MAY emit per `error.json`:**

- `issues[].schema_id` — `$id` of the rejecting (sub-)schema (e.g. `/schemas/3.1.0/core/activation-key.json`). Diagnostic; the actionable lever is `discriminator` + `variants` + `pointer`. Sellers MUST omit when the rejection is against a private extension or pre-release element. See [error-handling.mdx](../docs/protocol/error-handling.mdx).
- `issues[].discriminator` — `[{property_name, value}, …]` pairs identifying the const-discriminated `oneOf`/`anyOf` variant the validator selected from values present in the payload. Reads as "you targeted this branch; the missing/wrong fields are at the same level." Compound discriminators like `audience-selector`'s `(type, value_type)` produce two-entry arrays. Example: `discriminator: [{property_name: 'type', value: 'key_value'}]` plus `pointer: '/deployments/0/activation_key/key'` and `keyword: 'required'` means "you picked the `key_value` activation_key variant and it requires top-level `key` and `value`."

Both fields are optional in the spec — their presence shortens recovery; their absence just means falling back to `pointer` + `keyword` + `variants`. They are wire-level: a Python or Go caller reading the raw JSON sees them as `schema_id` and `discriminator`. SDKs that normalize keys (e.g. `@adcp/sdk` camelCases to `schemaId`) surface the SDK-shaped name.

**Recovery order:** patch the `pointer`s using `keyword` + `variants`, resend. If `discriminator` is present, prefer it — it names the branch directly so you don't have to walk `variants`. If `schema_id` is present, use it for diagnostic logging only. Three attempts should cover every field.

> **SDK-side enrichment.** Some SDKs synthesize additional fields client-side after parsing — e.g. `@adcp/sdk` adds `hint` (one-sentence curated recipes for known shape gotchas) and `allowedValues` (closed enum lists for `keyword: 'enum'`). These are **not** wire fields and are not emitted by sellers; if you're not using that SDK, you won't see them regardless of the seller. When present, prefer them over walking `variants`. See your SDK's docs for the full list.

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
      "format_kind": "video_hosted",
      "format_option_ref": { "scope": "product", "format_option_id": "video_1920x1080_30s" },
      "assets": {
        "video_main": {
          "asset_type": "video",
          "url": "https://cdn.acme.example/video-30s.mp4",
          "mime_type": "video/mp4",
          "width": 1920,
          "height": 1080,
          "duration_ms": 30000
        }
      }
    }
  ]
}
```

Per-creative required: `creative_id`, `name`, canonical `format_kind`, and `assets`. Include `format_option_ref` when the selected product has multiple declarations with the same kind or when you need to route to one exact product option. Asset keys and constraints come from the selected canonical product declaration. Returns `{ creatives: [{ creative_id, action, status }] }` — items may fail individually without failing the batch.

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
- **A2A 1.0**: activate `https://adcontextprotocol.org/extensions/adcp/v3`, then Send Message with exactly one invocation DataPart of shape `{ skill: 'tool_name', input: {...} }`. `parameters` is not an alias. Optional TextParts are advisory. Read the authoritative DataPart from the completed Task artifact.

Both transports share: idempotency, error shape, schema enforcement, and handler semantics. If a call works on one, the equivalent call works on the other.

## Gotchas I keep seeing

1. **Merging `oneOf` variants**: see the account section above. If you see three `additionalProperties` errors under one pointer, you merged. Drop to one variant.
2. **`budget` as an object**: it's a number. Currency comes from the `pricing_option`.
3. **`brand.brand_id` instead of `brand.domain`**: spec uses `domain`.
4. **Forgetting `idempotency_key`**: required on every mutating tool; see the list above.
5. **Treating A2A `Task.state: 'completed'` as AdCP completion**: A2A task state = transport invocation lifecycle. AdCP-level completion is in the artifact DataPart. A completed A2A task can carry a submitted AdCP response; invoke `get_task_status` with its DataPart `task_id`.
6. **Using deprecated `format_id` in a new workflow**: AdCP 3.2 creatives use `format_kind` plus optional `format_option_ref`. Read these from the selected product's `format_options[]`; use `format_id` only when deliberately interoperating with an older 3.x peer.

## Symptom → fix

Quick lookup before reading the full envelope. Match what you see in `adcp_error.issues[*]`, apply the fix:

| Symptom | What it means | Fix |
|---|---|---|
| `keyword: 'oneOf'` with `variants[]` | Discriminated union — you sent fields from multiple variants, or none | Pick ONE variant from `variants[]`. Send only its `required` fields. |
| `discriminator: [{property_name, value}]` on a `required` issue | Seller's validator inferred which branch you targeted; you missed required fields IN that branch | Read the `discriminator` pair, fill the missing required fields at the same level (don't nest under the discriminator property name). |
| `hint:` field present (SDK-side enrichment, not on the wire) | Your SDK matched a curated shape-gotcha rule | Apply the hint directly — it's the validated fix path. |
| 2-3 `additionalProperties` errors at the same pointer | You merged `oneOf` variants (`` `{account_id, brand, operator, …}` ``) | Drop to one variant. Don't keep "extra" fields "for completeness". |
| `keyword: 'required'`, `pointer: '/idempotency_key'` | Mutating tool, no UUID | Generate fresh UUID per logical operation. Reuse it on retries. |
| `keyword: 'type'` or `additionalProperties` at `/budget` | Sent `{amount, currency}` | `budget` is a number. Currency is implied by `pricing_option_id`. |
| `required` at `/format_kind` | Sent only a deprecated `format_id`, or omitted the canonical selector | Copy `format_kind` and, when needed, `format_option_ref` from the selected product's `format_options[]`. |
| `keyword: 'enum'` at `/destinations/*/type` | Made-up destination type | Use `'platform'` (with `platform`) or `'agent'` (with `agent_url`). |
| Response carries `status: 'submitted'` and `task_id` | Async — work is queued, NOT done | On the AdCP v3 A2A profile, invoke `get_task_status`; on MCP, use the advertised AdCP polling task. |
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
