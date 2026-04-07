# Creative Agent Pricing

## Problem

The creative protocol has no surface for pricing. Buyers can't discover what a creative
agent charges or reconcile usage after delivery.

The signals protocol solved this exact problem. `get_signals` returns `pricing_options[]`
per signal. `activate_signal` commits to a pricing option. `report_usage` passes the same
ID back for reconciliation. Creative needs the same loop — adapted for how creative
pricing actually works.

## Context

GitHub issue: #1200

The signals and creative protocols are structurally parallel. Both can be used in bundled
mode (publisher uses the agent behind the scenes, cost absorbed into product pricing) or
unbundled mode (buyer selects and pays for the agent directly). The protocol surface is the
same either way — the difference is just who calls the agent and who pays.

### Consistent vendor pricing pattern

All vendor services use the same pattern: `pricing_options[]` on discovery responses,
`pricing_option_id` in `report_usage`.

| Vendor type | Discovery | `report_usage` ID |
|---|---|---|
| Signals | `get_signals` → `pricing_options[]` per signal | `signal_agent_segment_id` |
| Content standards | `list_content_standards` → `pricing_options[]` per config | `standards_id` |
| Creative | `list_creatives` → `pricing_options[]` per creative | `creative_id` |
| Property lists | `list_property_lists` → `pricing_options[]` per list | `property_list_id` |
| Creative governance | `get_creative_features` → pricing in response | `standards_id` |
| Rights | `get_rights` → `pricing_options[]` per right | `rights_id` |

Vendors commonly offer multiple options per item — volume/commitment tiers, context-specific
rates (premium vs. standard placements), or different pricing models for different product
lines (CPM for rich media, per-unit for social variants).

## Design

### Core principle: pricing is account-scoped

Creative pricing is scoped to the account relationship. The account's rate card
determines the available options. `list_creatives` returns `pricing_options[]` reflecting
the account's negotiated rates.

Creative vendors commonly offer multiple options per creative:
- **Volume/commitment tiers** — lower CPM at higher spend commitments
- **Context-specific rates** — premium placements vs. standard
- **Product-line pricing** — CPM for rich media, per-unit for social variants

The `build_creative` response is authoritative — `vendor_cost` is what the buyer owes
for that specific build, computed from the selected pricing option.

### Core principle: if you charge, you're stateful

Pricing requires identity. You pay for the creative you use. A creative needs a persistent
`creative_id` so that:

- `list_creatives` can show the applicable pricing
- `build_creative` can return the cost computed for that creative
- `report_usage` can identify which creative was used

Agents that charge need to persist creative identity, which makes them stateful. A pure
transformation engine that doesn't charge remains stateless and unchanged.

### Pricing flow

1. **Account setup** — rate card agreed (contractual). Determines pricing for all
   subsequent operations.
2. **Discovery** — `list_creatives` (with `account` and `include_pricing`) returns
   `pricing_options[]` on each creative, reflecting the account's rate card.
3. **Build** — buyer calls `build_creative` with `account`. The agent builds the creative,
   computes the cost under the account's rate card, and the **response** includes:
   - `creative_id` — persistent identity for the built creative
   - `pricing_option_id` — which rate card pricing option was applied
   - `vendor_cost` — what the build cost
   - `currency` — ISO 4217
   - `consumption` — structured details relevant to the pricing model
4. **Report** — `report_usage` carries `creative_id` + `pricing_option_id` for
   reconciliation. Both sides can verify the same rate was applied.

The buyer never selects pricing. The agent tells you what you owe and why.

### Bundled mode

In bundled mode, a publisher uses a creative agent internally — the buyer never sees the
creative agent or its pricing. The cost is absorbed into product pricing.

The protocol surface is the same: the sales agent is the buyer in the creative agent
relationship. It establishes an account with the creative agent, calls `build_creative`
with that account, and handles `report_usage`. The buyer interacts only with the sales
agent's products and pricing.

### Pre-account discovery

A buyer agent that has not established an account with a creative agent cannot see pricing.
This is by design — pricing is contractual, and there is no contract without an account.

Creative agents that charge SHOULD indicate this in their agent description (MCP tool
annotations or A2A Agent Card) so buyer agents can know an account is required before
calling `list_creatives`. The protocol does not define a standard field for this in v1.

### Consumption details

The `consumption` object on the `build_creative` response carries structured details
about what was consumed. Well-known fields:

| Field | Type | Description |
|---|---|---|
| `tokens` | integer | LLM/generation tokens consumed |
| `images_generated` | integer | Number of images produced |
| `renders` | integer | Number of render passes (video/animation) |
| `duration_seconds` | number | Processing time billed (compute-time models) |

Agents MAY include additional fields. `additionalProperties: true`.

The `consumption` object is informational — it lets the buyer verify that the `vendor_cost`
is consistent with the rate card. It is not the billing source of truth; `vendor_cost` is.

How consumption applies by pricing model:

- **CPM-priced creative**: no consumption on build (cost accrues at serve time). The
  response still returns `pricing_option_id` so the buyer knows which CPM rate applies.
  `vendor_cost` may be zero on the build itself.
- **AI generation**: `{ "tokens": 12400, "images_generated": 3 }`. The agent computed
  the cost from its rate card — the consumption details let the buyer verify.
- **Flat fee**: no per-build consumption (covered by period fee). `vendor_cost` may be
  zero if the creative is covered under an existing subscription.

### What this means for interaction models

| Interaction model | Today | With pricing |
|---|---|---|
| **Transformation (free)** | Stateless. Assets in, manifest out. | Unchanged. No pricing surface. |
| **Transformation (paid)** | Doesn't exist | Agent persists `creative_id` on build output, returns pricing in response. Becomes stateful. |
| **Generation (AI)** | Stateless or library-backed | Returns `pricing_option_id` + cost + consumption in build response. |
| **Ad server (pre-loaded)** | Stateful, has library, uses Accounts | Adds `pricing` to `list_creatives`. Natural fit. |
| **Sales agent with creative** | Stateful, uses Accounts | Adds `pricing` to `list_creatives`. Natural fit. |

### What changes

#### 1. Creative agents that charge MUST implement the Accounts protocol

Today the spec says:

> Agents that host a creative library should also implement the accounts protocol so buyers
> can establish access before querying.

Updated:

> Creative agents that charge for their services MUST implement the Accounts protocol.
> This applies to any creative agent with pricing — ad servers, generation platforms, and
> transformation agents that bill for usage.

#### 2. `account` and `include_pricing` on `list_creatives` request

Add optional `account` (AccountRef) to the `list_creatives` request so the agent knows
which rate card to apply. Without `account`, pricing is omitted from the response.

Add `include_pricing` (boolean, default false) to the `list_creatives` request, following
the existing pattern of `include_snapshot`, `include_assignments`, etc. When false or
omitted, pricing is not computed — avoids unnecessary rate card lookups for callers that
just want a name/status listing.

Add `"pricing"` to the `fields` enum for sparse field selection.

#### 3. `pricing` on `list_creatives` responses

When `include_pricing` is true and `account` is provided, `list_creatives` responses
include `pricing_options[]` on each creative — the pricing options from the account's
rate card. For agents with predetermined rate cards, this typically contains a single
option.

**Two pricing discovery surfaces.** `list_creatives` carries `pricing_options` for
ad servers and library agents. `list_creative_formats` carries `pricing_options` for
transformation and generation agents where the format is the product. An agent MAY
expose pricing on both.

**Schema: vendor pricing option**

Creative and signal agents share a common pricing schema: `vendor-pricing-option.json`.
This replaces the current `signal-pricing-option.json` with a domain-neutral name. The
schema combines `pricing_option_id` with the pricing model discriminated union (cpm,
percent_of_media, flat_fee).

| Model | Creative use case |
|---|---|
| `cpm` | Cost per thousand impressions served — ad server model, DCO platforms |
| `percent_of_media` | Percentage of media spend — agency/platform model |
| `flat_fee` | Fixed charge per period — licensed creative suites, subscription access |
| `per_unit` | Fixed price per unit of work — per format adapted, per image generated, per token, per variant rendered |

```json
{
  "pricing_option_id": "po_video_cpm",
  "model": "cpm",
  "cpm": 0.50,
  "currency": "USD"
}
```

The `pricing_option_id` identifies the specific rate card entry so both sides can
reference it in `report_usage`.

**Per-unit pricing** covers transformation and generation use cases:

```json
{
  "pricing_option_id": "po_gen_per_image",
  "model": "per_unit",
  "unit": "image",
  "unit_price": 0.15,
  "currency": "USD"
}
```

The `unit` field is a free-form string describing what is counted (e.g., `"format"`,
`"image"`, `"token"`, `"variant"`, `"render"`, `"evaluation"`). The buyer discovers
the per-unit rate at `list_creatives` time and verifies it against the `consumption`
object on the `build_creative` response.

#### 4. `account` on `build_creative` request

Add an optional `account` field (AccountRef). When present, the creative agent:

- Applies account-specific pricing from the rate card
- Records the build against the account for billing
- Can enforce account-level quotas or entitlements

When absent, the agent either applies default pricing or rejects the request if it
requires an account.

#### 5. Pricing fields on `build_creative` response

The `build_creative` response gains pricing fields on **both** success variants
(`BuildCreativeSuccess` and `BuildCreativeMultiSuccess`):

| Field | Type | Description |
|---|---|---|
| `pricing_option_id` | string | Which rate card pricing option was applied |
| `vendor_cost` | number | Cost incurred for this build (may be 0 for CPM-priced creatives where cost accrues at serve time) |
| `currency` | string | ISO 4217 currency code |
| `consumption` | object | Structured consumption details (see schema above) |

For `BuildCreativeMultiSuccess` (multi-format builds), the pricing fields are top-level
and represent the **total cost** of the entire build call. Individual manifests do not
carry their own pricing — the agent bills for the build operation, not per-format.

For async builds (`status: "working"` with `context_id` polling), pricing fields appear
on the **final completed response** only, not on intermediate status responses. The cost
is only known when the build finishes.

#### 6. `creative_id` on `report_usage` records

`report_usage` already supports `signal_agent_segment_id` for signals and `standards_id`
for governance. Add `creative_id` as the creative-specific identifier so vendors can
correlate usage to specific creatives.

Every paid creative has a persistent `creative_id` (that's what makes the agent stateful),
so this field is always available for usage reporting.

#### Example: creative usage in `report_usage`

```json
{
  "reporting_period": {
    "start": "2026-03-01T00:00:00Z",
    "end": "2026-03-31T23:59:59Z"
  },
  "usage": [
    {
      "account": { "account_id": "acct_acme_creative" },
      "creative_id": "cr_88201",
      "pricing_option_id": "po_video_cpm",
      "impressions": 2400000,
      "vendor_cost": 1200.00,
      "currency": "USD"
    }
  ]
}
```

### What doesn't change

- **`report_usage` structure** — the schema already supports `pricing_option_id` and is
  vendor-type agnostic. Adding `creative_id` is a small addition.
- **Free creative agents** — stateless transformation agents that don't charge continue
  to work exactly as they do today. No account, no pricing, no persistence required.
- **Bundled creative** — when a publisher uses a creative agent internally, the buyer
  never sees the creative agent's pricing. The cost is absorbed into product pricing.
  The sales agent is the buyer in the creative agent relationship.
- **`sync_creatives`** — asset sync is about getting creatives into a library. Pricing is
  discovered via `list_creatives`, not during sync.
- **`list_creative_formats`** — now carries `pricing_options` per format for transformation/generation agents.

### Pricing models by interaction model

| Interaction model | Pricing surface | Likely models |
|---|---|---|
| Transformation (free) | None | N/A — stateless, no pricing |
| Transformation (paid) | `list_creatives` + `build_creative` response | per_unit, cpm, flat_fee |
| Generation (AI) | `list_creatives` + `build_creative` response | per_unit, flat_fee, cpm |
| Ad server (pre-loaded) | `list_creatives` + `build_creative` response | cpm, flat_fee |
| Sales agent with creative | `list_creatives` + `build_creative` response | cpm, percent_of_media |

## Schema changes

### Renamed schema: `vendor-pricing-option.json`

Rename `signal-pricing-option.json` to `vendor-pricing-option.json`. The schema is
domain-neutral: combines `pricing_option_id` with the pricing model discriminated union.
Used by both signal and creative agents. Update all `$ref` paths in signal schemas.

### New schema: `creative-consumption.json`

Structured consumption details for `build_creative` responses:

```json
{
  "type": "object",
  "properties": {
    "tokens": { "type": "integer", "minimum": 0, "description": "LLM/generation tokens consumed" },
    "images_generated": { "type": "integer", "minimum": 0, "description": "Number of images produced" },
    "renders": { "type": "integer", "minimum": 0, "description": "Number of render passes" },
    "duration_seconds": { "type": "number", "minimum": 0, "description": "Processing time billed" }
  },
  "additionalProperties": true
}
```

### Modified schemas

| Schema | Change |
|---|---|
| `list-creatives-request.json` | Add optional `account` (AccountRef), `include_pricing` (boolean), `"pricing"` to `fields` enum |
| `build-creative-request.json` | Add optional `account` (AccountRef) |
| `build-creative-response.json` | Add optional `pricing_option_id`, `vendor_cost`, `currency`, `consumption` to both success variants |
| `report-usage-request.json` | Add optional `creative_id` (string) to usage record |
| All schemas referencing `signal-pricing-option.json` | Update `$ref` to `vendor-pricing-option.json` |

### New fields on existing response objects

| Response | Field | Type |
|---|---|---|
| `list_creatives` response creative objects | `pricing_options` | `VendorPricingOption[]` |

## Capabilities change

No new capability flag needed. An agent that charges has pricing on its creatives. An
agent that doesn't, doesn't. The buyer discovers pricing by its presence in
`list_creatives` responses and `build_creative` responses.

The spec language around Accounts needs updating as described above.

## Documentation impact

### Specification (`docs/creative/specification.mdx`)

- Add a **Pricing** section after the Creative Status Lifecycle section
- Document the pricing flow: account setup → discover via `list_creatives` → build
  returns cost → report usage
- Explain that creative pricing is predetermined per account (rate card), unlike signals
  where the buyer selects from multiple options
- Add `account` and `include_pricing` to the `list_creatives` requirements
- Add `account` to the `build_creative` request requirements
- Add pricing fields to the `build_creative` response requirements (both success variants)
- Note that async builds return pricing only on the final response
- Strengthen the Accounts requirement: any agent that charges MUST implement Accounts
- Add `creative_id` to the `report_usage` description
- Update interaction models section: note that a paid transformation agent is stateful
- Add the creative `report_usage` example

### Implementation guide (`docs/creative/implementing-creative-agents.mdx`)

- Update the "Three interaction models" section: clarify that paid transformation agents
  become stateful (persist `creative_id`, implement Accounts, return pricing in
  `build_creative` response)
- Add a "Pricing" section explaining the account → discover → build → report flow
- Include a "Adding pricing to a stateless agent" walkthrough: minimum Accounts
  implementation, what `creative_id` persistence requires, the transition from stateless
  to stateful
- Clarify that rate cards are predetermined per account — the agent applies the right
  rate, the buyer doesn't select
- Clarify: free transformation agents remain stateless and unchanged

### Accounts docs (`docs/accounts/tasks/report_usage.mdx`)

- Add the creative usage example alongside the existing signals example
- Document `creative_id` as a usage record field

### Task reference pages

- `list_creatives`: document `account` and `include_pricing` on request, optional
  `pricing_options` on creative objects in response
- `build_creative`: document `account` on request, pricing fields on response (both
  success variants), async behavior

## Training impact

### S2: Creative mastery (`docs/learning/specialist/creative.mdx`)

The current module tests three interaction models and cross-platform skills but has no
pricing dimension.

**Updated "What you'll demonstrate":**

- Add: "Understand creative agent pricing: how rates are established via accounts, how
  `list_creatives` shows your rate, how `build_creative` returns cost, and how
  `report_usage` closes the loop"

**New lab exercise:**

- **Creative pricing** — Uses the same sandbox ad server from Lab 2 (interaction models),
  extended with pricing:
  1. Establish an account with the ad server
  2. `list_creatives` with `account` and `include_pricing: true` — observe per-creative
     pricing reflecting your rate card
  3. Switch to a second sandbox account, `list_creatives` again — observe different
     pricing from a different rate card
  4. `build_creative` with `account` — examine `pricing_option_id`, `vendor_cost`,
     `consumption` in the response
  5. `build_creative` without `account` — observe the rejection error
  6. Call `report_usage` with `creative_id` + `pricing_option_id`, verify the values
     match what `build_creative` returned
  7. Explain: why is `vendor_cost` zero on a CPM-priced creative at build time?
  8. Compare the entire flow with the Lab 1 stateless transformation agent (no account,
     no pricing, no persistence)

**Signals/creative pricing contrast:**

Include a brief conceptual section in the pricing lab:
- All vendor services use `pricing_options[]` on discovery responses and
  `pricing_option_id` in `report_usage`. Signals, content standards, creative agents,
  and property list agents all follow this pattern.
- Vendors commonly offer multiple options — volume tiers, context-specific rates,
  or different models per product line (CPM for rich media, per-unit for social
  variants).

**Assessment dimensions:**

| Dimension | Weight | What Addie evaluates |
|-----------|--------|---------------------|
| Interaction models | 20% | Correctly identifies and works with all three creative agent types |
| Cross-platform | 25% | Adapts creatives across channels and formats |
| Compliance | 25% | Configures disclosures, provenance, and regulatory requirements |
| Pricing and accounts | 15% | Understands rate cards, reads pricing from `list_creatives`, interprets build costs, closes the `report_usage` loop |
| Analytical skill | 15% | Interprets creative feature evaluation and delivery results |

### S3: Signals and audiences (`docs/learning/specialist/signals.mdx`)

Add a callout noting that creative pricing works differently (contractual vs.
transactional) with a link to S2. Helps learners who take S3 first understand the
protocols as a coherent system.

### Practitioner tracks

**Buyer track** (`docs/learning/tracks/buyer.mdx`): C3 already teaches `build_creative`.
Add a key concept: "Creative agents can charge for their services. When they do,
`list_creatives` shows pricing from your account's rate card, and `build_creative` returns
the cost incurred. You do not select pricing — it is predetermined by your account
relationship." Add a reading list entry pointing to the creative pricing specification
section.

**Publisher track** (`docs/learning/tracks/publisher.mdx`): Light mention that bundled
creative agent costs are absorbed into product pricing. Buyers don't see them. The sales
agent is the buyer in the creative agent relationship.

### Sandbox training agents

Extend the existing sandbox ad server (Lab 2 agent) with pricing:

**Two sandbox accounts with different rate cards:**

| Account | Video CPM | Display flat fee |
|---------|-----------|-----------------|
| `sandbox-buyer-standard` | $0.50 | $100/month |
| `sandbox-buyer-premium` | $0.25 | $75/month |

**Minimum creative library for pricing exercises:**

| Creative | Pricing model | Teaching purpose |
|----------|--------------|-----------------|
| Pre-loaded video ad | CPM | `vendor_cost` is 0 at build time — cost accrues at serve |
| Display banner | Flat fee | `vendor_cost` may be 0 — covered by subscription |
| AI-generated native ad | CPM + consumption | Non-zero `vendor_cost` with `consumption` details |

**Behavioral requirements:**
- `list_creatives` without `account` returns creatives but no pricing
- `list_creatives` with `account` + `include_pricing: true` returns pricing per creative
- `build_creative` without `account` on a paid agent returns a clear error
- `build_creative` with `account` returns all pricing fields
- `report_usage` with mismatched `pricing_option_id` returns a descriptive error

The existing stateless transformation agent remains free — this contrast teaches the
boundary between free/stateless and paid/stateful.

## Implementation stages

### Stage 1: Schema

Rename `signal-pricing-option.json` to `vendor-pricing-option.json` and update all refs.
Add `creative-consumption.json`. Add `account` and `include_pricing` to
`list-creatives-request.json`. Add `account` to `build-creative-request.json`. Add pricing
fields to both success variants in `build-creative-response.json`. Add `creative_id` to
`report-usage-request.json`. Add `pricing` to `list_creatives` response creative objects.

### Stage 2: Specification

Update `specification.mdx` with pricing section, Accounts requirement, interaction model
clarification, async behavior, and task updates.

### Stage 3: Documentation

Update implementation guide (including "adding pricing to a stateless agent" walkthrough),
task reference pages, and accounts docs.

### Stage 4: Training

Update S2 module (new dimension, lab exercise, signals/creative contrast), S3 callout,
buyer practitioner track key concept, and sandbox agents.
