# Brand protocol sandbox agent

Spec for an embedded brand protocol agent that Addie invokes during certification exercises. Learners interact with brand protocol tasks (get_brand_identity, get_rights, acquire_rights) through Addie's conversation. Addie translates learner intent into tool calls and shows the results.

## Context

The existing training agent (`server/src/training-agent/`) is a standalone MCP server exposed at `/api/training-agent/mcp`. It handles media-buy tasks (get_products, create_media_buy, etc.) with deterministic responses from in-memory seed data. External agents connect to it over HTTP.

The brand protocol sandbox agent is different. It does not need to be an external MCP server. It is a set of Addie tools that return canned brand protocol responses from in-memory seed data. Addie calls these tools during certification modules C2, C3, and specialist exams, the same way she calls `search_docs` or `get_products` today.

The C2 module already has exercise c2_ex3 ("Rights discovery and acquisition") with empty `sandbox_actions`. This spec fills that gap.

## Seed data

All data lives in a single TypeScript file as typed constants. No database.

### House: Loti Entertainment

```typescript
const HOUSE = {
  domain: "lotientertainment.com",
  name: "Loti Entertainment",
};
```

### Talent roster

Four talent entries. Each covers a different scenario learners encounter during exercises.

#### 1. Daan Janssen (primary example)

Dutch Olympic speed skater, 2x gold medalist. The canonical example from the brand protocol docs.

```typescript
{
  brand_id: "daan_janssen",
  house: HOUSE,
  names: [{ en: "Daan Janssen" }],
  description: "Dutch Olympic speed skater, 2x gold medalist",
  industry: "sports",
  keller_type: "independent",
  tagline: "Speed is a choice",
  logos: [
    { url: "https://cdn.lotientertainment.com/janssen/headshot.jpg", variant: "primary" },
  ],
  // Authorized-only fields
  colors: { primary: "#FF6600", secondary: "#1A1A2E", accent: "#FBA007" },
  fonts: { primary: "Montserrat", secondary: "Open Sans" },
  tone: {
    voice: "enthusiastic, warm, competitive",
    attributes: ["athletic", "Dutch pride", "approachable"],
    dos: ["Reference athletic achievements", "Use Dutch cultural touchpoints"],
    donts: ["No injury references", "No competitor comparisons"],
  },
  voice_synthesis: {
    provider: "elevenlabs",
    voice_id: "janssen_v2",
    settings: { stability: 0.7 },
  },
  visual_guidelines: {
    photography: { realism: "photorealistic", lighting: "bright, natural", framing: ["medium shot", "action shot"] },
    restrictions: ["Never place text over the athlete", "No competitor brand logos in frame"],
  },
  rights: {
    available_uses: ["likeness", "voice", "name", "endorsement"],
    countries: ["NL", "BE", "DE"],
    exclusivity_model: "category",
    content_restrictions: ["approval_required"],
  },
  // Rights offerings
  rights_offerings: [
    {
      rights_id: "janssen_likeness_voice",
      right_type: "talent",
      available_uses: ["likeness", "voice", "name", "endorsement"],
      countries: ["NL", "BE", "DE"],
      exclusivity_status: { available: true, existing_exclusives: ["sportswear (NL) — through 2026-12-31"] },
      pricing_options: [
        {
          pricing_option_id: "cpm_endorsement",
          model: "cpm",
          price: 3.50,
          currency: "EUR",
          uses: ["likeness"],
          description: "Per-impression royalty for AI-generated creatives using likeness",
        },
        {
          pricing_option_id: "monthly_exclusive",
          model: "flat_rate",
          price: 350,
          currency: "EUR",
          period: "monthly",
          uses: ["likeness", "voice"],
          impression_cap: 100000,
          overage_cpm: 4.00,
          description: "Monthly exclusive license for likeness + voice, up to 100K impressions",
        },
      ],
      content_restrictions: ["approval_required"],
      preview_assets: [
        { url: "https://cdn.lotientertainment.com/janssen/headshot.jpg", usage: "preview_only" },
      ],
    },
  ],
  // Acquisition behavior
  acquire_behavior: {
    // Categories that auto-approve
    auto_approve: ["food", "restaurant", "fitness", "travel"],
    // Categories that need talent review
    pending_approval: ["alcohol", "gambling", "pharmaceutical"],
    // Categories blocked by existing exclusivity
    rejected: {
      sportswear: "Active exclusivity with another brand for sportswear in NL through 2026-12-31",
    },
  },
}
```

#### 2. Sofia Reyes

Mexican freestyle swimmer, Pan American gold medalist. Available for different markets and uses than Janssen.

```typescript
{
  brand_id: "sofia_reyes",
  house: HOUSE,
  names: [{ en: "Sofia Reyes" }, { es: "Sofia Reyes" }],
  description: "Mexican freestyle swimmer, Pan American gold medalist",
  industry: "sports",
  keller_type: "independent",
  tagline: "Every stroke counts",
  logos: [
    { url: "https://cdn.lotientertainment.com/reyes/headshot.jpg", variant: "primary" },
  ],
  tone: {
    voice: "determined, joyful, bilingual",
    attributes: ["aquatic", "Latin American pride", "resilient"],
    dos: ["Reference water/swimming metaphors", "Bilingual content welcome"],
    donts: ["No weight/body references", "No rival athlete comparisons"],
  },
  rights: {
    available_uses: ["likeness", "name", "endorsement"],
    countries: ["MX", "US", "CO", "AR"],
    exclusivity_model: "category",
    content_restrictions: ["approval_required"],
  },
  rights_offerings: [
    {
      rights_id: "reyes_likeness",
      right_type: "talent",
      available_uses: ["likeness", "name", "endorsement"],
      countries: ["MX", "US", "CO", "AR"],
      exclusivity_status: { available: true, existing_exclusives: [] },
      pricing_options: [
        {
          pricing_option_id: "cpm_likeness",
          model: "cpm",
          price: 2.80,
          currency: "USD",
          uses: ["likeness"],
          description: "Per-impression royalty for AI-generated creatives using likeness",
        },
        {
          pricing_option_id: "quarterly_bundle",
          model: "flat_rate",
          price: 900,
          currency: "USD",
          period: "quarterly",
          uses: ["likeness", "name", "endorsement"],
          impression_cap: 250000,
          overage_cpm: 3.50,
          description: "Quarterly license for likeness + name + endorsement, up to 250K impressions",
        },
      ],
      content_restrictions: ["approval_required"],
      preview_assets: [
        { url: "https://cdn.lotientertainment.com/reyes/headshot.jpg", usage: "preview_only" },
      ],
    },
  ],
  acquire_behavior: {
    auto_approve: ["food", "beverage", "fitness", "health"],
    pending_approval: ["alcohol", "fashion"],
    rejected: {},
  },
}
```

#### 3. Pieter van Dijk

Dutch cyclist, vegan lifestyle advocate. Exists to demonstrate exclusion filtering — a vegetarian/vegan lifestyle means steakhouse brands get filtered out.

```typescript
{
  brand_id: "pieter_van_dijk",
  house: HOUSE,
  names: [{ en: "Pieter van Dijk" }, { nl: "Pieter van Dijk" }],
  description: "Dutch professional cyclist and vegan lifestyle advocate",
  industry: "sports",
  keller_type: "independent",
  tagline: "Fueled by plants",
  logos: [
    { url: "https://cdn.lotientertainment.com/vandijk/headshot.jpg", variant: "primary" },
  ],
  tone: {
    voice: "calm, principled, educational",
    attributes: ["endurance", "sustainability", "plant-based"],
    dos: ["Reference sustainability and endurance", "Plant-based nutrition"],
    donts: ["No meat/dairy promotion", "No fast food"],
  },
  rights: {
    available_uses: ["likeness", "name", "endorsement"],
    countries: ["NL", "BE", "DE", "FR"],
    exclusivity_model: "category",
    content_restrictions: ["approval_required", "vegan_lifestyle_compatible_only"],
  },
  rights_offerings: [
    {
      rights_id: "vandijk_likeness",
      right_type: "talent",
      available_uses: ["likeness", "name", "endorsement"],
      countries: ["NL", "BE", "DE", "FR"],
      exclusivity_status: { available: true, existing_exclusives: ["cycling equipment (EU) — through 2027-03-31"] },
      pricing_options: [
        {
          pricing_option_id: "cpm_likeness",
          model: "cpm",
          price: 2.00,
          currency: "EUR",
          uses: ["likeness"],
          description: "Per-impression royalty for AI-generated creatives",
        },
        {
          pricing_option_id: "monthly_standard",
          model: "flat_rate",
          price: 275,
          currency: "EUR",
          period: "monthly",
          uses: ["likeness", "name"],
          impression_cap: 75000,
          overage_cpm: 3.00,
          description: "Monthly license for likeness + name, up to 75K impressions",
        },
      ],
      content_restrictions: ["approval_required", "vegan_lifestyle_compatible_only"],
      preview_assets: [
        { url: "https://cdn.lotientertainment.com/vandijk/headshot.jpg", usage: "preview_only" },
      ],
    },
  ],
  acquire_behavior: {
    auto_approve: ["cycling", "fitness", "plant_based_food", "sustainability"],
    pending_approval: ["fashion", "technology"],
    rejected: {
      meat: "Dietary lifestyle conflict — talent is a vegan advocate",
      dairy: "Dietary lifestyle conflict — talent is a vegan advocate",
      fast_food: "Dietary lifestyle conflict — talent is a vegan advocate",
      cycling_equipment: "Active exclusivity with another brand for cycling equipment in EU through 2027-03-31",
    },
  },
  // Used for exclusion demos
  exclusion_reasons: {
    steakhouse: "Dietary lifestyle conflict with steakhouse brand",
    meat_brand: "Dietary lifestyle conflict with meat brand",
  },
}
```

#### 4. Yuki Tanaka

Japanese figure skater. Has voice synthesis available — demonstrates the voice_synthesis field and voice-specific rights.

```typescript
{
  brand_id: "yuki_tanaka",
  house: HOUSE,
  names: [{ en: "Yuki Tanaka" }, { ja: "田中ゆき" }],
  description: "Japanese figure skater, World Championship silver medalist",
  industry: "sports",
  keller_type: "independent",
  tagline: "Grace under pressure",
  logos: [
    { url: "https://cdn.lotientertainment.com/tanaka/headshot.jpg", variant: "primary" },
  ],
  tone: {
    voice: "graceful, precise, inspiring",
    attributes: ["elegance", "discipline", "Japanese aesthetics"],
    dos: ["Reference artistry and discipline", "Seasonal/nature imagery"],
    donts: ["No aggressive language", "No direct competitor mentions"],
  },
  voice_synthesis: {
    provider: "elevenlabs",
    voice_id: "tanaka_v1",
    settings: { stability: 0.8, language: "ja" },
  },
  rights: {
    available_uses: ["likeness", "voice", "name", "endorsement"],
    countries: ["JP", "KR", "US"],
    exclusivity_model: "category",
    content_restrictions: ["approval_required"],
  },
  rights_offerings: [
    {
      rights_id: "tanaka_likeness_voice",
      right_type: "talent",
      available_uses: ["likeness", "voice", "name", "endorsement"],
      countries: ["JP", "KR", "US"],
      exclusivity_status: {
        available: false,
        existing_exclusives: ["cosmetics (JP) — through 2027-06-30"],
      },
      pricing_options: [
        {
          pricing_option_id: "cpm_voice",
          model: "cpm",
          price: 5.00,
          currency: "USD",
          uses: ["voice"],
          description: "Per-impression royalty for AI-generated voice content",
        },
        {
          pricing_option_id: "monthly_full",
          model: "flat_rate",
          price: 500,
          currency: "USD",
          period: "monthly",
          uses: ["likeness", "voice", "name"],
          impression_cap: 80000,
          overage_cpm: 6.00,
          description: "Monthly license for full likeness + voice + name, up to 80K impressions",
        },
      ],
      content_restrictions: ["approval_required"],
      preview_assets: [
        { url: "https://cdn.lotientertainment.com/tanaka/headshot.jpg", usage: "preview_only" },
      ],
    },
  ],
  acquire_behavior: {
    auto_approve: ["food", "beverage", "travel", "luxury"],
    pending_approval: ["fashion", "technology", "entertainment"],
    rejected: {
      cosmetics: "Active exclusivity with another brand for cosmetics in JP through 2027-06-30",
    },
  },
}
```

### Seed data design notes

- All talent is fictional. No real athletes.
- Pricing is denominated in the talent's home currency (EUR for NL-based, USD for Americas/Japan-based).
- Each talent has at least one `rejected` category to demonstrate exclusivity conflicts.
- Van Dijk exists specifically to show up in the `excluded` array when buyers search for steakhouse/meat campaigns.
- Tanaka has `exclusivity_status.available: false` to show what that field looks like when exclusivity is unavailable.

## Tools

Three Addie tools in `server/src/addie/mcp/brand-sandbox-tools.ts`.

### sandbox_get_brand_identity

Wraps the `get_brand_identity` task. Returns identity data from seed data.

**Tool definition:**

```typescript
{
  name: "sandbox_get_brand_identity",
  description: "Get brand identity data from the Loti Entertainment sandbox roster. Returns public data by default. Set authorized=true to see all fields (simulates a linked account). Use during certification exercises to demonstrate the brand protocol's public vs authorized data model.",
  usage_hints: "use during certification brand protocol exercises to demonstrate get_brand_identity",
  input_schema: {
    type: "object",
    properties: {
      brand_id: {
        type: "string",
        description: "Brand identifier (e.g., 'daan_janssen', 'sofia_reyes', 'pieter_van_dijk', 'yuki_tanaka')",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Optional identity sections to include: description, industry, keller_type, logos, colors, fonts, visual_guidelines, tone, tagline, voice_synthesis, assets, rights",
      },
      use_case: {
        type: "string",
        description: "Intended use case: endorsement, voice_synthesis, likeness, creative_production, media_planning",
      },
      authorized: {
        type: "boolean",
        description: "Simulate an authorized caller (linked via sync_accounts). Default false — returns public-only data.",
      },
    },
    required: ["brand_id"],
  },
}
```

**Behavior:**

1. Look up `brand_id` in seed data. Return error if not found.
2. Always return core fields: `brand_id`, `house`, `names`.
3. If `authorized` is false (default):
   - Return public fields: `description`, `industry`, `keller_type`, basic `logos`, `tagline`.
   - Return `available_fields` listing what authorized access would unlock: `["tone", "voice_synthesis", "assets", "rights", "colors", "fonts", "visual_guidelines"]`.
4. If `authorized` is true:
   - Return all requested `fields` (or all fields if `fields` is omitted).
   - Do not return `available_fields`.
5. If `fields` includes sections requiring authorization and `authorized` is false, omit those fields silently and include them in `available_fields`.
6. Format the response as JSON matching the `get-brand-identity-response.json` schema.

**Example response (public):**

```json
{
  "brand_id": "daan_janssen",
  "house": { "domain": "lotientertainment.com", "name": "Loti Entertainment" },
  "names": [{ "en": "Daan Janssen" }],
  "description": "Dutch Olympic speed skater, 2x gold medalist",
  "industry": "sports",
  "keller_type": "independent",
  "logos": [
    { "url": "https://cdn.lotientertainment.com/janssen/headshot.jpg", "variant": "primary" }
  ],
  "tagline": "Speed is a choice",
  "available_fields": ["tone", "voice_synthesis", "assets", "rights", "colors", "fonts", "visual_guidelines"]
}
```

### sandbox_get_rights

Wraps the `get_rights` task. Searches seed data for matching talent.

**Tool definition:**

```typescript
{
  name: "sandbox_get_rights",
  description: "Search for licensable talent rights in the Loti Entertainment sandbox roster. Returns matches with pricing options. Supports natural language queries — the tool interprets intent, budget, and geography from the query text. Use during certification exercises to demonstrate rights discovery.",
  usage_hints: "use during certification brand protocol exercises to demonstrate get_rights, rights discovery, pricing comparison",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language description of desired rights (e.g., 'Dutch athlete for restaurant brand in Amsterdam, budget 400 EUR/month')",
      },
      uses: {
        type: "array",
        items: { type: "string" },
        description: "Rights uses being requested: likeness, voice, name, endorsement",
      },
      buyer_brand: {
        type: "object",
        properties: {
          domain: { type: "string" },
          brand_id: { type: "string" },
        },
        description: "Buyer's brand for compatibility filtering",
      },
      countries: {
        type: "array",
        items: { type: "string" },
        description: "Countries where rights are needed (ISO 3166-1 alpha-2)",
      },
      brand_id: {
        type: "string",
        description: "Search within a specific brand's rights",
      },
      include_excluded: {
        type: "boolean",
        description: "Include filtered-out results with reasons. Default false.",
      },
    },
    required: ["query", "uses"],
  },
}
```

**Behavior:**

This tool uses deterministic matching, not LLM calls. The matching logic:

1. If `brand_id` is provided, filter to that talent only.
2. If `countries` is provided, filter to talent available in at least one of those countries.
3. Filter to talent whose `available_uses` includes at least one of the requested `uses`.
4. For each matching talent, compute `match_score` based on:
   - Country overlap with query (if query mentions a country): +0.3
   - Use overlap (fraction of requested uses available): +0.3
   - Budget fit (if query mentions a budget and a flat_rate option is within range): +0.2
   - Base score for any match: +0.2
   - Cap at 1.0
5. Generate `match_reasons` from the matching criteria.
6. If `include_excluded` is true, include talent that matched on query but was filtered for compatibility reasons (e.g., van Dijk excluded for steakhouse queries). Use keyword matching on the query: if query contains "steakhouse", "steak", "meat", "burger", "bbq", van Dijk goes into `excluded`.
7. Sort results by `match_score` descending.
8. Format as JSON matching `get-rights-response.json` schema.

**Example response:**

```json
{
  "rights": [
    {
      "rights_id": "janssen_likeness_voice",
      "brand_id": "daan_janssen",
      "name": "Daan Janssen",
      "description": "Dutch Olympic speed skater, 2x gold medalist",
      "right_type": "talent",
      "match_score": 0.92,
      "match_reasons": [
        "Available for food/restaurant brands in NL",
        "Within budget at 350 EUR/month",
        "Athletic brand aligns with restaurant quality positioning"
      ],
      "available_uses": ["likeness", "voice", "name", "endorsement"],
      "countries": ["NL", "BE", "DE"],
      "exclusivity_status": {
        "available": true,
        "existing_exclusives": ["sportswear (NL) — through 2026-12-31"]
      },
      "pricing_options": [
        {
          "pricing_option_id": "cpm_endorsement",
          "model": "cpm",
          "price": 3.50,
          "currency": "EUR",
          "uses": ["likeness"],
          "description": "Per-impression royalty for AI-generated creatives using likeness"
        },
        {
          "pricing_option_id": "monthly_exclusive",
          "model": "flat_rate",
          "price": 350,
          "currency": "EUR",
          "period": "monthly",
          "uses": ["likeness", "voice"],
          "impression_cap": 100000,
          "overage_cpm": 4.00,
          "description": "Monthly exclusive license for likeness + voice, up to 100K impressions"
        }
      ],
      "content_restrictions": ["approval_required"],
      "preview_assets": [
        { "url": "https://cdn.lotientertainment.com/janssen/headshot.jpg", "usage": "preview_only" }
      ]
    }
  ],
  "excluded": [
    {
      "brand_id": "pieter_van_dijk",
      "name": "Pieter van Dijk",
      "reason": "Dietary lifestyle conflict with steakhouse brand"
    }
  ]
}
```

### sandbox_acquire_rights

Wraps the `acquire_rights` task. Returns deterministic outcomes based on seed data scenarios.

**Tool definition:**

```typescript
{
  name: "sandbox_acquire_rights",
  description: "Acquire rights from the Loti Entertainment sandbox roster. Returns acquired (with generation credentials), pending_approval, or rejected based on the campaign category and talent's existing contracts. Use during certification exercises to demonstrate the acquire_rights flow.",
  usage_hints: "use during certification brand protocol exercises to demonstrate acquire_rights, rights clearance, generation credentials",
  input_schema: {
    type: "object",
    properties: {
      rights_id: {
        type: "string",
        description: "Rights offering identifier from sandbox_get_rights",
      },
      pricing_option_id: {
        type: "string",
        description: "Selected pricing option from the rights offering",
      },
      buyer: {
        type: "object",
        properties: {
          domain: { type: "string" },
          brand_id: { type: "string" },
        },
        required: ["domain"],
        description: "Buyer's brand identity",
      },
      campaign: {
        type: "object",
        properties: {
          description: { type: "string", description: "How the rights will be used" },
          uses: { type: "array", items: { type: "string" }, description: "Rights uses for this campaign" },
          countries: { type: "array", items: { type: "string" }, description: "Campaign countries" },
          estimated_impressions: { type: "integer", description: "Estimated total impressions" },
          start_date: { type: "string", description: "Campaign start date (YYYY-MM-DD)" },
          end_date: { type: "string", description: "Campaign end date (YYYY-MM-DD)" },
        },
        required: ["description", "uses"],
        description: "Campaign details for rights clearance",
      },
    },
    required: ["rights_id", "pricing_option_id", "buyer", "campaign"],
  },
}
```

**Behavior:**

1. Look up `rights_id` in seed data. Return error if not found.
2. Validate `pricing_option_id` exists in that offering. Return error if not found.
3. Determine status from the talent's `acquire_behavior` and the `campaign.description`:
   - Extract keywords from `campaign.description` (lowercase).
   - Check against `rejected` keys first. If any keyword matches, return `rejected` with the reason.
   - Check against `pending_approval` keys. If any keyword matches, return `pending_approval`.
   - Otherwise return `acquired`.
4. For `acquired` status, build the response with:
   - `terms` populated from the pricing option and campaign dates.
   - `generation_credentials` with placeholder keys (e.g., `rk_mj_sandbox_...` for likeness, `rk_el_sandbox_...` for voice).
   - `restrictions` from the talent's content_restrictions.
   - `disclosure` with required=true and text referencing the talent and Loti Entertainment.
   - `rights_constraint` as a simplified object with validity period and country restrictions.
5. For `pending_approval`, return `detail` and `estimated_response_time: "48h"`.
6. For `rejected`, return the `reason` from `acquire_behavior.rejected`.

**Example response (acquired):**

```json
{
  "rights_id": "janssen_likeness_voice",
  "status": "acquired",
  "brand_id": "daan_janssen",
  "terms": {
    "pricing_option_id": "monthly_exclusive",
    "amount": 350,
    "currency": "EUR",
    "period": "monthly",
    "uses": ["likeness", "voice"],
    "impression_cap": 100000,
    "overage_cpm": 4.00,
    "start_date": "2026-04-01",
    "end_date": "2026-06-30",
    "exclusivity": {
      "scope": "Exclusive licensee for Daan Janssen in NL for food/restaurant brands",
      "countries": ["NL"]
    }
  },
  "generation_credentials": [
    {
      "provider": "midjourney",
      "rights_key": "rk_mj_sandbox_abc123",
      "uses": ["likeness"],
      "expires_at": "2026-06-30T23:59:59Z"
    },
    {
      "provider": "elevenlabs",
      "rights_key": "rk_el_sandbox_def456",
      "uses": ["voice"],
      "expires_at": "2026-06-30T23:59:59Z"
    }
  ],
  "restrictions": [
    "All generated creatives must be submitted for approval before distribution",
    "No modification of talent likeness beyond approved AI generation parameters"
  ],
  "disclosure": {
    "required": true,
    "text": "Features AI-generated likeness of Daan Janssen, used under license from Loti Entertainment"
  },
  "approval_webhook": "https://sandbox.lotientertainment.com/rights/janssen_likeness_voice/approve",
  "usage_reporting_url": "https://sandbox.lotientertainment.com/rights/janssen_likeness_voice/usage"
}
```

**Example response (rejected):**

```json
{
  "rights_id": "janssen_likeness_voice",
  "status": "rejected",
  "brand_id": "daan_janssen",
  "reason": "Active exclusivity with another brand for sportswear in NL through 2026-12-31"
}
```

## Architecture

### File structure

```
server/src/addie/mcp/brand-sandbox-tools.ts   # Tool definitions, handlers, seed data
```

Single file. Seed data, tool definitions, handler functions, and exports all in one place. The training agent pattern (`server/src/training-agent/`) splits across multiple files because it is a standalone MCP server. The sandbox tools are Addie tools — they follow the same pattern as `certification-tools.ts` and `brand-tools.ts`.

### Exports

```typescript
export const BRAND_SANDBOX_TOOLS: AddieTool[];
export function createBrandSandboxToolHandlers(): Map<string, ToolHandler>;
```

### Registration

Register alongside certification tools in `bolt-app.ts`, inside the per-request tool assembly block:

```typescript
import { BRAND_SANDBOX_TOOLS, createBrandSandboxToolHandlers } from './mcp/brand-sandbox-tools.js';

// In the per-request tool assembly:
const brandSandboxHandlers = createBrandSandboxToolHandlers();
allTools.push(...BRAND_SANDBOX_TOOLS);
for (const [name, handler] of brandSandboxHandlers) {
  allHandlers.set(name, handler);
}
```

These tools are always registered (same as certification tools). They are lightweight (in-memory data, no external calls) and cost minimal context tokens. The `sandbox_` prefix and usage_hints make it clear to the model when to use them.

### No state

Unlike the training agent which tracks session state for media buys, the brand sandbox tools are stateless. Each call returns a deterministic response from seed data. There is no session, no database, no state between calls.

## Certification integration

### C2: Brand protocol module

Update the c2_ex3 exercise to reference the sandbox tools. Migration:

```sql
UPDATE certification_modules SET exercise_definitions = jsonb_set(
  exercise_definitions,
  '{2}',  -- c2_ex3 is the third exercise (index 2)
  '{
    "id": "c2_ex3",
    "title": "Rights discovery and acquisition",
    "description": "Your client runs a steakhouse in Amsterdam and wants a Dutch athlete for their next campaign. Use the sandbox to search for available talent, evaluate pricing options, and attempt to acquire rights. Notice how some talent gets excluded for compatibility reasons.",
    "sandbox_actions": [
      { "tool": "sandbox_get_rights", "guidance": "Search for Dutch athlete talent with likeness and voice uses. Include excluded results to see compatibility filtering." },
      { "tool": "sandbox_get_brand_identity", "guidance": "Get the full brand identity for your top match. Compare public vs authorized data." },
      { "tool": "sandbox_acquire_rights", "guidance": "Attempt to acquire rights. Try both a food/restaurant campaign (should succeed) and a sportswear campaign (should be rejected due to exclusivity)." }
    ],
    "success_criteria": [
      "Can construct an effective natural-language rights query with appropriate filters (uses, geography, budget)",
      "Evaluates pricing options by comparing CPM vs flat rate for the campaign size",
      "Identifies relevant restrictions and exclusions in the rights response",
      "Understands the acquire_rights flow: request, pending_approval, credential issuance",
      "Can explain how generation credentials connect to creative production"
    ]
  }'::jsonb
) WHERE id = 'C2';
```

### C3: Creative workflows module

C3 covers creative asset workflows. The sandbox_get_brand_identity tool is useful here for demonstrating how a creative agent retrieves brand guidelines before generating content.

Add a demo_scenario to C3's lesson plan:

```sql
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{demo_scenarios}',
  '[
    {
      "description": "Retrieve brand identity for creative production — show how a creative agent gets colors, fonts, visual guidelines, and tone before generating content",
      "tools": ["sandbox_get_brand_identity"],
      "expected_outcome": "Learner sees how authorized identity data feeds into creative generation parameters"
    }
  ]'::jsonb
) WHERE id = 'C3';
```

### Specialist exams

The S1 (Media Buy Specialist) and any future rights-focused specialist modules can use all three sandbox tools in their lab exercises. The sandbox provides a controlled environment where learners demonstrate end-to-end workflows: discover rights, evaluate options, acquire, and understand how generation credentials flow to creative agents.

## Implementation stages

### Stage 1: Seed data and tool definitions

**Goal:** `brand-sandbox-tools.ts` with typed seed data and three tool definitions.

**Deliverables:**
- Seed data as TypeScript constants with full type annotations
- `BRAND_SANDBOX_TOOLS` array with three tool definitions
- `createBrandSandboxToolHandlers()` returning a Map of handler functions
- Handler for `sandbox_get_brand_identity` (public vs authorized logic)
- Handler for `sandbox_get_rights` (deterministic matching)
- Handler for `sandbox_acquire_rights` (status determination from campaign description)

**Success criteria:**
- All three handlers return valid JSON matching their respective schemas
- `sandbox_get_brand_identity` correctly withholds authorized fields when `authorized=false`
- `sandbox_get_rights` returns van Dijk in excluded array for steakhouse queries
- `sandbox_acquire_rights` returns all three statuses for appropriate campaign descriptions

**Tests:**
- Unit tests for each handler with representative inputs
- Test public vs authorized identity responses
- Test exclusion filtering (steakhouse query should exclude van Dijk)
- Test acquire_rights status determination (food=acquired, alcohol=pending, sportswear=rejected)
- Validate responses against JSON schemas

### Stage 2: Registration and C2 exercise update

**Goal:** Tools available in Addie's conversation and C2 exercise references them.

**Deliverables:**
- Import and register sandbox tools in `bolt-app.ts`
- Migration updating c2_ex3 sandbox_actions to reference the three tools
- Import and register in `register-baseline-tools.ts` (for eval-service)

**Success criteria:**
- Addie can call sandbox tools during certification conversations
- `start_certification_module` for C2 shows the updated exercise with tool references
- Tools appear in Addie's tool list during conversations

**Tests:**
- Integration test: start C2 module, verify exercise output includes sandbox tool references

### Stage 3: C3 demo scenario and documentation

**Goal:** C3 uses the sandbox for creative workflow demos. Exercise guidance is clear.

**Deliverables:**
- Migration adding demo_scenario to C3 lesson plan
- Verify the teaching flow works: Addie teaches C2, runs the exercises, learners interact with sandbox data

**Success criteria:**
- C3 demo scenario references sandbox_get_brand_identity
- Teaching context in C2 and C3 mentions the sandbox tools where appropriate

### Stage 4: Changeset and cleanup

**Goal:** Ship it.

**Deliverables:**
- Changeset (--empty, since this is Addie behavior not protocol)
- Verify all tests pass
- Remove IMPLEMENTATION_PLAN.md

**Success criteria:**
- `npm test` passes
- `npm run typecheck` passes
- `npm run lint` passes
