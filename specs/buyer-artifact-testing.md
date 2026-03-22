# Buyer Artifact Testing

## What we're building

Two Addie tools that test a publisher's AdCP agent against real buyer artifacts (RFPs and IOs) instead of synthetic briefs. A media kit is the publisher talking to themselves. An RFP is a buyer telling you what they want. An IO is a deal that closed. Testing against these tells the publisher whether their agent can handle the business they already do.

These tools replace `compare_media_kit`. They return structured data for Addie to interpret — no LLM calls inside the tool.

## Why compare_media_kit falls short

`compare_media_kit` constructs briefs from the publisher's self-description of their inventory. The test inputs are derived from the same source as the thing being tested. This means:

- If the publisher describes their inventory well, the briefs match and the test passes — but it proves nothing about buyer demand
- If the publisher describes their inventory poorly, the briefs are bad and the gaps are noise
- It only tests `get_products` with `buying_mode: brief`. It never touches execution (`create_media_buy`)
- The synthetic briefs have no budget, timing, or format specificity — they can't test whether a buyer agent could actually close a deal

Real buyer artifacts fix all of this. An RFP has the buyer's actual language, budget, timing, and format requirements. An IO has the exact line items that a sales team negotiated. These are ground truth.

## Tool 1: test_rfp_response

### What it does

Takes a structured RFP summary (Addie parses the document in conversation first), constructs one or more `get_products` calls against the publisher's agent, and returns structured comparison data.

The publisher's stated response is the most valuable input. Without it, we're testing discovery in a vacuum. With it, Addie can pinpoint exactly where the agent diverges from how the sales team actually responds to buyers.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "agent_url": {
      "type": "string",
      "description": "Agent URL to test against"
    },
    "rfp": {
      "type": "object",
      "description": "Structured RFP data extracted by Addie from the publisher's document",
      "properties": {
        "brief": {
          "type": "string",
          "description": "Natural language campaign brief extracted from the RFP. This becomes the brief field in get_products."
        },
        "advertiser": {
          "type": "string",
          "description": "Advertiser name from the RFP (used as brand.name in the get_products call)"
        },
        "budget": {
          "type": "object",
          "properties": {
            "amount": { "type": "number" },
            "currency": { "type": "string" }
          },
          "description": "Total budget from the RFP, if stated"
        },
        "flight_dates": {
          "type": "object",
          "properties": {
            "start": { "type": "string", "format": "date" },
            "end": { "type": "string", "format": "date" }
          },
          "description": "Campaign dates from the RFP"
        },
        "channels": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Channels the buyer is asking for (e.g., display, video, ctv, podcast)"
        },
        "formats": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Specific format types requested (e.g., 300x250, pre-roll, mid-roll)"
        },
        "audience": {
          "type": "string",
          "description": "Target audience description from the RFP"
        },
        "kpis": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Performance goals stated in the RFP (e.g., reach, CTR, completed views)"
        },
        "publisher_response": {
          "type": "string",
          "description": "What the publisher would normally propose for this RFP. This is the highest-value input — it lets Addie compare the agent's output against what the sales team actually sends buyers."
        }
      },
      "required": ["brief"]
    }
  },
  "required": ["agent_url", "rfp"]
}
```

### What the tool does (deterministic, no LLM)

1. Validate agent URL, resolve auth (same pattern as existing tools)
2. Construct `get_products` call:
   - `buying_mode: "brief"`
   - `brief`: from `rfp.brief`
   - `brand: { name: rfp.advertiser, url: "https://example.com" }` (or defaults)
3. Execute the call via `AdCPClient`
4. Extract from the response:
   - Products returned (count, names, IDs)
   - Channels covered (from `product.channels`)
   - Formats available (from `product.format_ids`)
   - Pricing models and rates (from `product.pricing_options`)
   - Delivery types (guaranteed vs auction vs fixed)
   - Proposals returned (pre-packaged bundles the agent recommends)
   - Audience/targeting signals present
   - Forecast data (if returned)
   - Brief relevance explanations (from `product.brief_relevance`)
5. Compare against the RFP's stated requirements:
   - Requested channels vs channels returned
   - Requested formats vs formats returned
   - Budget feasibility: sum up minimum spends from pricing options
   - KPI alignment: do products support the measurement/optimization the buyer wants?
6. If `publisher_response` was provided, include it verbatim so Addie can compare what the sales team would send vs what the agent actually returned
7. If `publisher_response` was NOT provided, set a flag so Addie knows to ask for it — the comparison is the whole point

### Output structure

```typescript
interface RfpTestResult {
  agent_url: string;
  rfp_brief: string;  // echo back for context

  // What the agent returned
  agent_response: {
    products_count: number;
    products: Array<{
      product_id: string;
      name: string;
      channels: string[];
      format_ids: Array<{ agent_url: string; id: string }>;
      delivery_type: string;
      pricing_options: Array<{
        pricing_option_id: string;
        pricing_model: string;  // cpm, cpc, cpv, flat_rate, etc.
        price?: number;
        currency?: string;
        minimum_spend?: number;
      }>;
      has_forecast: boolean;
      has_audience_targeting: boolean;
      brief_relevance?: string;
    }>;
    proposals_count: number;
    proposals: Array<{
      proposal_id: string;
      name?: string;
      allocation_count: number;  // how many products in the proposal
      total_budget?: number;
    }>;
  };

  // Gap analysis (deterministic comparisons)
  gaps: {
    channels: {
      requested: string[];
      found: string[];
      missing: string[];
    };
    formats: {
      requested: string[];
      found: string[];
      missing: string[];
    };
    budget: {
      rfp_budget?: { amount: number; currency: string };
      total_minimum_spend: number;  // sum of all minimum_spends
      feasible: boolean | null;     // null if budget not stated in RFP
    };
    kpis: {
      requested: string[];
      supported_measurement: string[];  // from outcome_measurement, metric_optimization
      gaps: string[];
    };
    dates: {
      rfp_start?: string;
      rfp_end?: string;
      noted: boolean;  // dates can't be tested via get_products, just flag them for IO test
    };
  };

  // Publisher's stated response — the comparison anchor
  publisher_stated_response?: string;  // what they said they'd normally propose
  has_publisher_response: boolean;     // Addie should ask for this if false
}
```

The tool returns this as structured JSON wrapped in a markdown output string (same pattern as existing tools). Addie interprets the gaps, compares against the publisher's stated response, and coaches.

### Usage hints

```
"use when a publisher shares a real RFP, media brief, or campaign brief and wants to test
how their agent responds. Addie should parse the RFP document first to extract the structured
rfp object. IMPORTANT: before calling this tool, ask the publisher what they would normally
propose for this RFP — that comparison is the highest-value output. After receiving results,
compare the agent's response to the publisher's stated response and coach on the gaps."
```

### When the publisher doesn't have an RFP

Addie can call `test_rfp_response` with an SDK sample brief as the `rfp.brief` field. The tool doesn't know or care whether the brief came from a real RFP or the sample library. Addie tells the publisher: "I don't have a real RFP to test against, so I'll use a standard brief for your vertical — but the results will be much more useful if you share an actual RFP you've received."

Even with a sample brief, the publisher_response comparison still works. "What would you normally propose for a $500K luxury auto campaign?" is a question the publisher can answer regardless of where the brief came from.


## Tool 2: test_io_execution

### What it does

Takes structured IO/proposal line items (Addie parses the document in conversation first), maps them to the agent's actual products and pricing options, and constructs the exact `create_media_buy` JSON a buyer agent would send. Optionally dry-runs it.

This tests the second half of the funnel: can a buyer agent actually *execute* the deal your sales team closes?

### Input schema

```json
{
  "type": "object",
  "properties": {
    "agent_url": {
      "type": "string",
      "description": "Agent URL to test against"
    },
    "line_items": {
      "type": "array",
      "description": "Line items extracted from the IO or proposal by Addie",
      "items": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string",
            "description": "What this line item is (e.g., 'Homepage takeover - 300x250 display, 1M impressions')"
          },
          "channel": {
            "type": "string",
            "description": "Channel if identifiable (display, video, audio, etc.)"
          },
          "format": {
            "type": "string",
            "description": "Format if specified (300x250, pre-roll, etc.)"
          },
          "pricing_model": {
            "type": "string",
            "description": "How it's priced (CPM, CPC, flat rate, etc.)"
          },
          "rate": {
            "type": "number",
            "description": "Unit price (e.g., $12 CPM). Note: IO rates are often negotiated above rate card."
          },
          "quantity": {
            "type": "number",
            "description": "Units (impressions, clicks, etc.)"
          },
          "budget": {
            "type": "number",
            "description": "Line item total spend"
          },
          "start_date": {
            "type": "string",
            "format": "date"
          },
          "end_date": {
            "type": "string",
            "format": "date"
          }
        },
        "required": ["description"]
      },
      "minItems": 1
    },
    "advertiser": {
      "type": "string",
      "description": "Advertiser name from the IO"
    },
    "currency": {
      "type": "string",
      "description": "Currency for all line items (default: USD)"
    },
    "execute": {
      "type": "boolean",
      "description": "If true, actually call create_media_buy on the agent. If false (default), only construct the call and show the exact JSON that would be sent.",
      "default": false
    }
  },
  "required": ["agent_url", "line_items"]
}
```

### What the tool does (deterministic, no LLM)

1. Validate agent URL, resolve auth
2. Call `get_products` with `buying_mode: "wholesale"` to get the agent's full catalog
3. Also extract any proposals from the response — proposals are pre-packaged bundles that may map to IO line items better than individual products (e.g., "Homepage Takeover Package" maps to a proposal, not a single product)
4. For each IO line item, attempt to match against products AND proposals:
   - First check proposals: if a proposal name/description matches the line item (string containment, normalized), prefer it — proposals represent how the publisher actually packages deals
   - Then check individual products using the scoring system below
5. For each matched product, find the best pricing option:
   - Same pricing model as the IO line item
   - Rate comparison (see "Rate comparison" section below)
6. Construct the full `create_media_buy` request body — the exact JSON a buyer agent would send:
   - `packages` array with `{ product_id, pricing_option_id, budget, buyer_ref, start_time, end_time }`
   - `brand`, `account`, `start_time`, `end_time` at the buy level
   - For unmatched line items: flag as unmappable with reason
7. If `execute: true` and at least one line item mapped, submit `create_media_buy` to the agent and include the response
8. Return structured results including the constructed JSON

### Output structure

```typescript
interface IoTestResult {
  agent_url: string;

  // Product catalog from the agent
  catalog: {
    total_products: number;
    channels_available: string[];
    pricing_models_available: string[];
    proposals_count: number;
  };

  // Per line-item mapping results
  line_item_results: Array<{
    line_item_description: string;
    status: "mapped" | "partial" | "unmapped";

    // What it matched to
    match_type?: "proposal" | "product";

    // When matched to a proposal
    matched_proposal?: {
      proposal_id: string;
      name?: string;
      match_reasons: string[];
    };

    // When matched to a product (or partial)
    matched_product?: {
      product_id: string;
      name: string;
      match_quality: "exact" | "close" | "weak";
      match_reasons: string[];  // deterministic: ["channel:display", "format:300x250"]
    };
    matched_pricing_option?: {
      pricing_option_id: string;
      pricing_model: string;
      agent_rate?: number;       // floor_price or rate from the agent
      io_rate?: number;          // rate from the IO
      rate_context: string;      // see "Rate comparison" section
    };

    // When unmapped or partial
    unmapped_reasons?: string[];  // e.g., ["no product with channel:podcast", "no flat_rate pricing option"]

    // The package that would be sent in create_media_buy
    proposed_package?: {
      buyer_ref: string;
      product_id: string;
      pricing_option_id: string;
      budget: number;
      bid_price?: number;
      start_time?: string;
      end_time?: string;
    };
  }>;

  // Summary
  summary: {
    total_line_items: number;
    mapped: number;
    partial: number;
    unmapped: number;
    total_io_budget: number;
    mappable_budget: number;  // budget of mapped + partial line items
    budget_coverage_pct: number;
  };

  // The full create_media_buy request body — the exact JSON a buyer agent would send.
  // This is the artifact the publisher takes to their engineering team.
  proposed_media_buy_request?: {
    brand: { name: string; url: string };
    account: string;
    start_time: string;
    end_time: string;
    packages: Array<{
      buyer_ref: string;
      product_id: string;
      pricing_option_id: string;
      budget: number;
      bid_price?: number;
      start_time?: string;
      end_time?: string;
    }>;
    total_budget: number;
    unmapped_line_items: string[];  // descriptions of line items that couldn't be mapped
  };

  // Execution result (only if execute was true and attempted)
  execute_result?: {
    success: boolean;
    media_buy_id?: string;
    status?: string;
    packages_created?: number;
    error?: string;
    raw_response?: Record<string, unknown>;  // full agent response for Addie to inspect
  };
}
```

### Usage hints

```
"use when a publisher shares a real IO, insertion order, proposal, or media plan and wants to
test whether a buyer agent could execute those line items through their agent. Addie should
parse the IO document first to extract structured line_items, then call this tool. The output
includes the exact create_media_buy JSON a buyer agent would send — share this with the
publisher so they can take it to their engineering team. Explain which line items map, which
don't, and what the rate differences mean."
```


## Rate comparison

IO rates and agent rates are not directly comparable. IO rates are negotiated — they're often above rate card because a sales team added value (audience targeting, premium placement, measurement guarantees, relationship pricing). Agent rates are typically floor prices or programmatic rate card.

**The tool should NOT flag "agent rate is lower than IO rate" as a problem.** That's expected. What matters:

- **Agent rate higher than IO rate**: Possible misconfiguration. The agent's floor price is above what the sales team negotiated. A buyer agent would reject this or negotiate down.
- **Agent rate much lower than IO rate (>50% difference)**: Worth noting. The publisher may be underpricing their programmatic inventory vs their direct sales. Not a bug, but a business insight.
- **Agent rate same as IO rate**: Clean match. The agent's rate card aligns with negotiated deals.

The `rate_context` field in the output should use these labels:
- `"aligned"` — rates within 20% of each other
- `"agent_higher"` — agent floor/rate above IO rate (potential issue)
- `"agent_lower"` — agent rate below IO rate (expected for programmatic vs direct, note if gap is large)
- `"no_comparison"` — one or both rates not available


## Matching logic (for test_io_execution)

The line-item-to-product matching must be deterministic. No LLM calls.

### Proposal matching (checked first)

Before scoring individual products, check if any proposals from the `get_products` response match the line item. A proposal is a pre-packaged bundle — "Homepage Takeover Package", "Video Sponsorship Bundle" — that represents how the publisher actually sells.

Match proposals by normalized string containment between the line item description and the proposal name/description. If a proposal matches, use it and skip individual product matching for that line item. Proposals represent the publisher's preferred packaging — if a buyer's IO line item maps to a proposal, that's the strongest signal.

### Channel matching

Normalize both sides to lowercase. Direct string match. Map common aliases:
- "online video" / "olv" / "pre-roll" / "mid-roll" -> check against `olv`
- "connected tv" / "ctv" / "ott" -> check against `ctv`
- "programmatic display" / "banner" -> check against `display`
- "digital audio" / "streaming audio" -> check against `audio`
- "digital out of home" / "dooh" / "outdoor digital" -> check against `dooh`
- "newsletter" / "email" -> check against `email`

### Format matching

Normalize format IDs by stripping the `agent_url` prefix and comparing the `id` portion. Match dimension strings like "300x250" against format IDs containing those dimensions. This is fuzzy but deterministic — string containment, not semantic similarity.

### Pricing model matching

Direct string comparison after normalization:
- "cost per thousand" / "cpm" -> `cpm`
- "cost per click" / "cpc" -> `cpc`
- "flat" / "flat rate" / "sponsorship" -> `flat_rate`
- "cost per view" / "cpv" / "cpcv" -> `cpv`
- "cost per action" / "cpa" / "cost per acquisition" -> `cpa`

### Match ranking

Score each candidate product per line item:
- +3 points: channel match
- +2 points: format match
- +2 points: pricing model match
- +1 point: delivery_type match (guaranteed vs auction)

Take the highest-scoring product. Ties broken by product order in the response.

- Score >= 5: `"exact"` match quality
- Score 3-4: `"close"`
- Score 1-2: `"weak"`
- Score 0: `"unmapped"`


## Conversational flow

This is how Addie guides the publisher through the process. The tools only handle the execution steps — Addie handles everything else.

### RFP flow

```
1. Publisher shares RFP (PDF, text, or describes it)
2. Addie parses the RFP → extracts brief, channels, budget, dates, audience, KPIs
3. Addie asks: "What would you normally propose for this RFP? This is the most
   valuable part — I'll compare your sales team's response to what your agent returns."
4. Publisher describes their typical response (products, pricing, packages)
5. Addie calls test_rfp_response with the structured data + publisher_response
6. Addie interprets results by comparing agent output to the publisher's stated response:
   - "Your agent returned 4 products covering display and video, but the RFP also asks
     for podcast and your sales team would normally include it. That's a channel gap —
     buyers asking for audio won't find it through your agent."
   - "Your team normally quotes $12 CPM for this audience. Your agent's floor price is
     $8 CPM. That's expected if $12 is your negotiated rate, but worth checking that
     your programmatic pricing is intentional."
   - "The buyer wants completed-view measurement. Your sales team includes this in every
     video proposal, but your video product doesn't declare metric_optimization with
     completed_views — a buyer agent wouldn't know you support it."
   - "Your agent returned a proposal called 'Premium Video Package' that bundles pre-roll
     and mid-roll — that's a good match for how your team would normally package this."
7. Addie suggests specific fixes prioritized by business impact
```

If the publisher doesn't provide their typical response in step 4, Addie should still run the test but flag it clearly: "I can test what your agent returns, but without knowing what your sales team would normally propose, I can't tell you what's missing. Want to share what you'd typically send back for this type of RFP?"

### IO flow

```
1. Publisher shares IO or proposal
2. Addie parses it → extracts line items with descriptions, pricing, quantities, dates
3. Addie calls test_io_execution with structured line items
4. Addie interprets results:
   - "3 of 5 line items map cleanly to your agent's products. Here's the exact
     create_media_buy JSON a buyer agent would send:" [shows the JSON]
   - "The homepage takeover maps to your 'Premium Display — Homepage' product via
     the 'Homepage Takeover Package' proposal. Clean match."
   - "The newsletter sponsorship doesn't have a match — your agent doesn't have an
     email/newsletter product. A buyer agent would have to skip this line or contact
     your sales team directly. If newsletter is a real revenue line, you should add it."
   - "Your agent quotes $10 CPM floor for video pre-roll, but this IO has it at $14.
     That's normal — IO rates are negotiated above rate card. A buyer agent bidding
     at $10 would clear your floor and the deal would execute."
5. For unmapped line items, Addie explains what the publisher would need to add to
   their agent (new products, pricing options, channels)
6. If the publisher wants to test execution: "Want me to dry-run this? I'll send the
   create_media_buy to your agent and we'll see if it accepts the order."
```

### Full sequence

The recommended testing journey for a publisher:

```
1. evaluate_agent_quality (comply)
   "Does your agent speak AdCP correctly?"
   Fix protocol issues first — if get_products returns invalid schemas,
   nothing else matters.

2. test_rfp_response
   "Does your agent surface the right inventory for what buyers ask for?"
   Share an RFP + what you'd normally propose. See where the agent diverges.

3. test_io_execution
   "Can a buyer agent execute deals through your agent?"
   Share an IO from a closed deal. See the exact JSON a buyer would send
   and whether your agent would accept it.
```

Addie should guide publishers through this sequence naturally. If they jump to IO testing but have protocol failures, point them back to compliance first.


## Buying mode coverage

### What's tested now

- `test_rfp_response` uses `buying_mode: "brief"` — tests discovery from a buyer's natural language request
- `test_io_execution` uses `buying_mode: "wholesale"` — gets full catalog to match IO line items against

### What's not tested (future)

- `buying_mode: "refine"` — the iterative narrowing flow (brief → "show me more like this" → "remove that one" → buy). This is how sophisticated buyer agents actually work: they don't go from brief straight to IO. They refine.

Refine testing is a natural next step but requires a multi-turn simulation, not a single tool call. It would look like: "start with this brief, then refine by including products X and Y, omitting Z, and show me more like W." That's a separate tool or a mode of test_rfp_response for a future iteration.


## What happens to compare_media_kit

Deprecate it. Add a deprecation notice in the tool description pointing to `test_rfp_response` and `test_io_execution`. Keep it functional for 2 releases so existing conversations referencing it don't break.

When a publisher doesn't have an RFP or IO handy, Addie should still be able to help:

1. **Use SDK sample briefs.** Addie can call `test_rfp_response` with a sample brief as the `rfp.brief` field. The tool doesn't know or care whether the brief came from a real RFP or the sample library. Even with a sample brief, the publisher_response comparison works: "What would you normally propose for a $500K luxury auto campaign?"

2. **evaluate_agent_quality still exists.** It tests protocol correctness. These tools test business readiness. They're complementary:
   - `comply()`: "Does your agent speak AdCP correctly?"
   - `test_rfp_response`: "Does your agent surface the right inventory for what buyers ask for?"
   - `test_io_execution`: "Can a buyer agent execute deals through your agent?"


## Implementation notes

### File location
Both tools go in `server/src/addie/mcp/member-tools.ts`, following existing patterns.

### Auth resolution
Use the existing `resolveAgentAuth()` and `validateAgentUrl()` helpers. Same public test agent fallback behavior.

### AdCPClient usage
Same pattern as `compare_media_kit`:
```typescript
const { AdCPClient } = await import('@adcp/client');
const agentConfig = {
  id: 'target', name: 'target',
  agent_uri: resolved.resolvedUrl,
  protocol: 'mcp' as const,
  ...(resolved.authToken && resolved.authType === 'basic'
    ? { headers: { 'Authorization': `Basic ${resolved.authToken}` } }
    : resolved.authToken ? { auth_token: resolved.authToken } : {}),
};
const multiClient = new AdCPClient([agentConfig], { debug: false });
const client = multiClient.agent('target');
```

### Tool set registration
Add both tools to the `agent_testing` tool set in `server/src/addie/tool-sets.ts`.

### Error handling
Same pattern: auth errors suggest `save_agent`, connection errors report the URL, all errors return strings (not throws) for Addie to interpret.

### Input size limits
- `rfp.brief`: 5000 chars
- `rfp.publisher_response`: 3000 chars
- `line_items`: max 20 items
- `line_item.description`: 500 chars each

### Prompt updates
Update `server/src/addie/prompts.ts`:
- Add both tools under "Adagents & Agent Testing"
- Include the testing sequence (comply → RFP → IO)
- Emphasize that `publisher_response` is the highest-value input for RFP testing
- Note that `compare_media_kit` is deprecated in favor of these tools
