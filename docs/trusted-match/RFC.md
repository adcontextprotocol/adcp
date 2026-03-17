# AdCP Trusted Match Protocol (TMP)

**Status**: Draft RFC
**Date**: 2026-03-16
**Authors**: Brian O'Kelley

## Abstract

The Trusted Match Protocol (TMP) is AdCP's real-time execution layer. It enables buyer agents to activate pre-negotiated media buy packages against live context, with optional catalog and creative refinements.

TMP defines two structurally separated operations:

- **Context Match**: "Given this content, which packages should be active?" — carries page/content signals, never user identity.
- **Identity Match**: "For this user, what's their eligibility across packages?" — carries an opaque user token, never page context.

These operations run in independent trusted execution environments (TEE enclaves). The publisher — as the first party who already has both context and identity — joins the results at decision time. Buyers never observe both simultaneously. This separation is not a policy promise; it is a cryptographically attestable architectural constraint.

TMP complements AdCP's planning-time tools (`get_products`, `create_media_buy`) by filling the gap between "we have a deal" and "it delivered." Prices are negotiated at planning time. TMP handles activation.

## Motivation

### The Gap in AdCP Today

AdCP defines a complete lifecycle for agent-to-agent media buying:

| Phase | Tool | Status |
|---|---|---|
| Discovery | `get_products` | Defined |
| Negotiation | `create_media_buy` | Defined |
| **Execution** | **???** | **Missing** |
| Reporting | `get_media_buy_delivery` | Defined |

Execution is currently handled by AXE, a Scope3-specific implementation built on Prebid Server's RTD module. AXE works but is vendor-specific, Prebid-dependent, and sends the full OpenRTB BidRequest (~2-10KB JSON) when only minimal context is needed. TMP generalizes AXE into a protocol-level primitive.

### Why Not OpenRTB

OpenRTB was designed for real-time display auctions. It fails for emerging surfaces:

- **AI assistants** (ChatGPT, Snap AI, Reddit chat): No impression to auction. Sponsored content is selected by relevance, not price competition.
- **Mobile mediation**: Selection is between pre-negotiated deals. The "auction" is really "which deal do I activate?"
- **CTV pod composition**: Multiple packages activate simultaneously. Single-slot auction logic doesn't fit.
- **Retail media carousels**: The buyer needs to specify catalog items, not bid a price.

More fundamentally, OpenRTB bundles user identity with page context in a single request. This is a structural privacy failure that no amount of policy can fix.

### Why Not Auctions

The fundamental problem with building on auction semantics (including CloudX's OpenAuction) is that auctions assume adversarial competition over a scarce resource. But most real-time ad decisioning is:

- **Filtering**: "Which of my pre-bought packages apply to this context?"
- **Steering**: "Within an active package, which catalog items or creative variants should I prefer?"
- **Eligibility**: "Is this user frequency-capped or high-intent for any of these packages?"

An auction is one way to resolve conflicts when multiple packages match. It is a resolution strategy, not the protocol primitive. Making the auction the protocol forces every surface into a bidding paradigm, even when relevance, editorial judgment, or priority ordering is more appropriate.

TMP returns matching packages. What the publisher does with them — priority, auction, relevance scoring, editorial selection — is the publisher's decision.

## Design Principles

1. **Pre-negotiated, not real-time priced.** Prices are agreed at planning time via `create_media_buy`. TMP activates packages; it doesn't negotiate prices.

2. **Publisher-controlled activation.** The publisher defines the package set and sends it to buyers. Buyers select from what's offered. The publisher already knows how to activate each package (line item, PMP, SDK render, etc.).

3. **Privacy by structural separation.** User identity and page context MUST travel in independent requests, processed in independent TEE enclaves. The protocol makes it architecturally impossible for buyers — or the router — to observe both simultaneously.

4. **Catalog-aware.** Buyers can express preferences within package bounds: preferred GTINs, creative variants, eligible promotions, carousel ordering.

5. **Surface-agnostic.** The same protocol works for web display, AI chat, mobile apps, CTV, DOOH, and retail media.

6. **Resolution-agnostic.** TMP returns activated packages. How the publisher chooses among them is not TMP's concern.

## Architecture

### The TMP Router

TMP assumes a **router** that sits between publishers and buyer agents. The router consists of two independent components running in separate TEE enclaves:

```
┌─────────────────────────────────────────────────────────────────┐
│                        TMP Router                               │
│                                                                 │
│  ┌──────────────────────┐     ┌───────────────────────────┐    │
│  │  Context Router      │     │  Identity Router           │    │
│  │  (TEE Enclave)       │     │  (TEE Enclave)             │    │
│  │                      │     │                             │    │
│  │  Sees:               │     │  Sees:                      │    │
│  │  • page context      │     │  • opaque user tokens       │    │
│  │  • content signals   │     │  • package IDs              │    │
│  │  • package lists     │     │                             │    │
│  │                      │     │  Never sees:                │    │
│  │  Never sees:         │     │  • URLs                     │    │
│  │  • user tokens       │     │  • content signals          │    │
│  │  • any identity      │     │  • any page context         │    │
│  │                      │     │                             │    │
│  │  Attests:            │     │  Attests:                   │    │
│  │  "No user data       │     │  "No context data           │    │
│  │   touched"           │     │   touched"                  │    │
│  └──────────────────────┘     └───────────────────────────┘    │
│           │ no shared state            │                        │
└───────────┼────────────────────────────┼────────────────────────┘
            │                            │
            └────────────┬───────────────┘
                         │
                   Publisher joins
                   (on publisher infrastructure)
```

The router:

- Reads adagents.json to discover authorized buyer agents and their TMP capabilities
- Fans out Context Match requests to agents (via the Context Router enclave)
- Fans out Identity Match requests to agents (via the Identity Router enclave)
- Merges responses and returns unified results to the publisher
- Provides TEE attestation that the two enclaves share no state

The router is infrastructure, not a protocol participant. It does not make decisions. Prebid is the natural home for this, generalizing what AXE does today into a multi-buyer, multi-surface router.

### Request Flow

```
Publisher                TMP Router                    Buyer Agents
   │                        │                              │
   │                   ┌────┴────┐                         │
   │   Context Match   │ Context │                         │
   │  ─────────────►   │ Router  │  ── context ─────────►  │ Agent A
   │  (context +       │ (TEE)   │  ── context ─────────►  │ Agent B
   │   packages)       │         │  ◄── [p1,p3,catalog] ─  │ Agent A
   │  ◄─────────────   │         │  ◄── [p2,signals] ────  │ Agent B
   │  (merged)         └────┬────┘                         │
   │                        │                              │
   │  (temporal gap, fuzzed by publisher)                  │
   │                        │                              │
   │                   ┌────┴────┐                         │
   │  Identity Match   │Identity │                         │
   │  ─────────────►   │ Router  │  ── user token ──────►  │ Agent A
   │  (user token +    │ (TEE)   │  ── user token ──────►  │ Agent B
   │   package IDs)    │         │  ◄── eligibility ─────  │ Agent A
   │  ◄─────────────   │         │  ◄── eligibility ─────  │ Agent B
   │  (merged)         └────┬────┘                         │
   │                        │                              │
   ▼                                                       │
Publisher joins context                                    │
+ identity responses and                                   │
activates packages                                         │
```

### Agent Capability Declaration

Buyer agents declare TMP capabilities on their existing AdCP agent endpoint in adagents.json. No separate endpoints are needed:

```json
{
  "authorized_agents": [
    {
      "url": "https://buyer.scope3.com/adcp",
      "authorized_for": "Media buying and trusted matching",
      "authorization_type": "property_tags",
      "property_tags": ["all_web"],
      "capabilities": {
        "planning": ["get_products", "create_media_buy"],
        "tmp": {
          "context_match": true,
          "identity_match": true,
          "catalog_refinement": true,
          "wire_formats": ["capnp", "json"]
        }
      }
    },
    {
      "url": "https://buyer.brandx.com/adcp",
      "authorized_for": "Sponsored product activation",
      "authorization_type": "property_ids",
      "property_ids": ["retail_homepage", "search_results"],
      "capabilities": {
        "tmp": {
          "context_match": true,
          "catalog_refinement": true,
          "wire_formats": ["json"]
        }
      }
    }
  ]
}
```

## Protocol Specification

### Context Match

**Purpose**: Given page/content context and a set of available packages, determine which packages should be active and how they should be configured.

**Privacy constraint**: Contains NO user identity information. Processed in the Context Router TEE enclave.

#### Request

```
ContextMatchRequest {
  # Request metadata
  request_id        :Text       # unique, for logging/debugging only
  timestamp         :UInt64     # unix millis

  # Property context (from adagents.json)
  property_id       :Text       # matches adagents.json property_id
  property_type     :PropertyType  # website | ai_assistant | mobile_app | ctv_app | dooh | audio
  surface           :Text       # page_view | conversation_turn | app_screen | pod_break | etc.

  # Content signals (privacy-safe, no PII)
  content {
    url             :Text       # page URL or content identifier
    domain          :Text       # publisher domain
    content_hash    :Text       # opaque hash of page/conversation content
    topic_ids       :List(Text) # structured topic taxonomy IDs
    sentiment       :Float32    # -1.0 to 1.0
    language        :Text       # ISO 639-1
    content_rating  :Text       # brand safety classification
  }

  # Available packages (buyer selects from these)
  available_packages :List(AvailablePackage)
}

AvailablePackage {
  package_id        :Text       # from the media buy
  media_buy_id      :Text       # parent media buy
  format_ids        :List(Text) # supported formats
  catalog_ids       :List(Text) # eligible catalog items (if catalog-bound)
}
```

#### Response

```
ContextMatchResponse {
  request_id        :Text       # echo back

  # Which packages to activate
  activate          :List(PackageActivation)

  # Enrichment signals (additive, not package-specific)
  signals {
    segments        :List(Text)           # audience/contextual segments
    targeting_kvs   :List(KeyValuePair)   # key-value pairs for ad server targeting
  }
}

PackageActivation {
  package_id        :Text       # from available_packages

  # Catalog refinements (optional)
  preferred_gtins   :List(Text) # ordered preference for catalog items
  preferred_tags    :List(Text) # content tags for carousel/recommendation
  exclude_gtins     :List(Text) # items to suppress

  # Creative refinements (optional)
  creative_variant  :Text       # preferred variant ID
  creative_ids      :List(Text) # specific creative assets, ordered by preference

  # Promotion refinements (optional)
  eligible_promotions :List(Text) # active promotions to feature
}

KeyValuePair {
  key               :Text
  value             :Text
}
```

### Identity Match

**Purpose**: For a given user (identified by opaque token), determine their eligibility status across a set of packages. This gives the publisher an eligibility matrix they can merge with the context match results.

**Privacy constraint**: Contains NO page context, content signals, or URL information. Processed in the Identity Router TEE enclave.

#### Request

```
IdentityMatchRequest {
  request_id        :Text       # unique, NOT correlated to any context match request_id
  timestamp         :UInt64     # fuzzed relative to context match request

  # Opaque user identity (publisher-scoped)
  user_token        :Text       # publisher-generated, opaque to buyer
                                # buyer can map to their own identity graph
                                # but cannot reverse to PII

  # Packages to evaluate eligibility for
  package_ids       :List(Text)
}
```

#### Response

```
IdentityMatchResponse {
  request_id        :Text

  eligibility       :List(PackageEligibility)
}

PackageEligibility {
  package_id        :Text
  eligible          :Bool       # overall eligibility

  # Reason flags (all optional, buyer provides what they can)
  frequency_capped  :Bool       # user has hit frequency cap
  audience_match    :Bool       # user is in target audience
  intent_score      :Float32    # 0.0-1.0, buyer's model of user intent
  recency           :UInt8      # 0=unknown, 1=new, 2=returning, 3=lapsed

  # Catalog-level eligibility (optional)
  catalog_eligibility :List(CatalogEligibility)
}

CatalogEligibility {
  gtin              :Text
  eligible          :Bool
  reason            :Text       # "already_purchased" | "in_cart" | "viewed_recently"
}
```

### Publisher-Side Join

The publisher combines both responses to make the final activation decision. This join happens entirely on the publisher's infrastructure. Neither the buyer agents nor the router see the joined result.

```
For each package in context_match_response.activate:

  1. Look up identity_match_response.eligibility for this package_id
  2. If frequency_capped → skip (or deprioritize)
  3. If not audience_match → optionally skip (publisher's choice)
  4. Use intent_score as a ranking signal among competing packages
  5. Filter preferred_gtins through catalog_eligibility
     (remove items the user already purchased, etc.)
  6. Activate via publisher's mechanism:
     • Ad server → activate line item / PMP deal with targeting KVs
     • AI platform → include in response generation context
     • Mobile SDK → pass to rendering layer
     • Retail media → populate carousel with eligible, preferred GTINs
```

The publisher already knows how to activate packages — that's the whole point. TMP just tells them which packages to activate and provides eligibility signals to refine the decision.

## Privacy Architecture

### Structural Separation via TEE

The protocol's privacy guarantee is architectural and attestable:

1. **Context Router enclave**: Processes Context Match requests. Contains page/content signals and package lists. Cannot access user tokens or identity data. Provides TEE attestation of its code and data isolation.

2. **Identity Router enclave**: Processes Identity Match requests. Contains opaque user tokens and package IDs. Cannot access URLs, content signals, or page context. Provides TEE attestation of its code and data isolation.

3. **No shared state**: The two enclaves have no shared memory, no shared database, no communication channel. This is verifiable through TEE attestation (e.g., AWS Nitro Enclave PCR measurements).

4. **Temporal decorrelation**: Publishers SHOULD introduce random delay (recommended: 100-2000ms, uniformly distributed) between context and identity requests. Publishers MAY batch identity requests across multiple page views to further obscure timing correlation.

### What the Buyer Can Learn

From **Context Match**:
- Which publisher pages/content exist (by content hash, topic, domain)
- Which packages are potentially available on those pages
- Content signals (topics, sentiment, language, brand safety)
- They CANNOT learn which users see which pages

From **Identity Match**:
- Which user tokens exist (opaque, publisher-scoped)
- Those users' eligibility status for packages
- They CANNOT learn which pages those users are viewing

### What the Buyer Cannot Learn

- Association between a user token and a page URL or content
- Cross-page user browsing profiles
- That user X saw content Y
- Timing correlation between context and identity (due to fuzzing + separate enclaves)

### What the Router Cannot Learn

Because context and identity are processed in separate TEE enclaves with no shared state:

- The router operator cannot join context + identity even if they wanted to
- This is attestable: any party can verify the enclave measurements to confirm separation
- Compromise of one enclave does not compromise the other

### Comparison to OpenRTB

| Signal | OpenRTB | TMP |
|---|---|---|
| User ID + page URL | Same request | Separate TEE enclaves |
| Device fingerprint | Included | Never sent |
| IP address | Included | Never sent |
| Raw cookies | Included | Never sent |
| GPS coordinates | Included | Never sent |
| Browsing history | Via cookie sync | Impossible by design |
| Verification | Trust the exchange | TEE attestation |

## Wire Format

### Binary Encoding

Requests and responses SHOULD use Cap'n Proto for binary serialization:

- **Zero-copy reads**: Fields readable directly from wire buffer without deserialization
- **Schema evolution**: New fields addable without breaking existing implementations
- **Small wire size**: Typical Context Match request is 100-300 bytes (vs. 2-10KB for OpenRTB JSON)

JSON encoding MAY be supported for development and debugging. Implementations MUST support Cap'n Proto; JSON support is OPTIONAL.

### Transport

Requests are HTTP/2 POST with binary body. Content type: `application/x-capnp` (binary) or `application/json` (debug mode).

The TMP Router discovers buyer agents and their capabilities from adagents.json. The router calls each authorized agent's existing AdCP endpoint — `context_match` and `identity_match` are capabilities of the agent, not separate services. The request type field distinguishes the operation.

### Latency Budget

TMP is designed for sub-50ms end-to-end latency (publisher → router → agents → router → publisher). This is achievable because:

- Binary encoding eliminates serialization overhead
- Pre-negotiated packages mean no price computation
- TEE enclaves run native code, not interpreted
- Fan-out is parallel with first-response-wins timeout semantics

Buyer agents that consistently exceed the latency budget MAY be deprioritized or skipped by the router.

## Relationship to Existing Systems

### AdCP Planning-Time Tools

TMP is the execution-time complement to planning-time tools:

| Phase | Tool | What Happens |
|---|---|---|
| Discovery | `get_products` | Buyer finds available inventory via natural language briefs |
| Negotiation | `create_media_buy` | Buyer and seller agree on packages, pricing, targeting, budgets |
| **Execution** | **TMP** (`context_match` + `identity_match`) | **Buyer activates packages for specific contexts and users** |
| Reporting | `get_media_buy_delivery` | Both sides measure what delivered |

### Prebid Integration

The natural infrastructure for the TMP Router is a new Prebid project. This generalizes what AXE does today (single buyer, Prebid Server RTD, web-only) into a multi-buyer, multi-surface router.

For existing Prebid Server web deployments, the router integrates as a module replacing the current Scope3-specific RTD module with a generic TMP module that speaks Context Match and Identity Match to any authorized buyer agent.

AXE becomes Scope3's implementation of the `context_match` and `identity_match` capabilities behind their existing AdCP agent endpoint. Other buyer agents implement the same capabilities.

### CloudX OpenAuction

CloudX's TEE-based auction is complementary. When a publisher wants verifiable competitive selection among activated packages:

1. Publisher collects Context Match responses from multiple buyer agents (via TMP Router)
2. Publisher submits activated packages (with pre-negotiated prices) to a CloudX TEE auction
3. TEE produces an attestation proof of fair winner selection
4. Publisher activates the winning package

The auction is a resolution strategy that sits on top of TMP. TMP handles matching; CloudX handles competition. Publishers choose their resolution strategy.

CloudX's TEE infrastructure (AWS Nitro Enclaves, attestation, key management) is also directly applicable to the TMP Router's Context and Identity enclaves. CloudX could provide the trusted infrastructure layer for the entire protocol.

### OpenRTB

TMP is not a replacement for OpenRTB in its core use case (programmatic display/video auctions between strangers). It addresses surfaces and use cases where OpenRTB is the wrong fit:

- AI assistants and chatbots
- Mobile mediation with pre-negotiated deals
- CTV pod composition
- Retail media and sponsored products
- Any surface where packages are pre-negotiated and the publisher already knows how to activate them

Over time, as more buying moves to pre-negotiated packages via AdCP, more execution moves from OpenRTB auctions to TMP activation. The two protocols can coexist — a publisher might use AdCP+TMP for premium direct and OpenRTB for residual programmatic.

## Surface-Specific Guidance

### Web (with ad server)

The publisher has GAM, Kevel, or similar. Packages map to line items or PMPs.

- **Context Match**: Router sends page URL, content signals, available packages. Buyer responds with activated packages + targeting KVs.
- **Identity Match**: Router sends user token, package IDs. Buyer responds with eligibility (frequency caps, audience match).
- **Activation**: Publisher sets targeting KVs on the ad request; ad server activates matching line items.

### AI Assistant (ChatGPT, Snap AI, Reddit chat)

The platform has no traditional ad server. Sponsored content is woven into conversational responses.

- **Context Match**: Router sends conversation topic hash, sentiment, surface type. Buyer responds with activated packages + preferred catalog items/promotions.
- **Identity Match**: Router sends session token. Buyer responds with eligibility (frequency caps, past interaction recency).
- **Activation**: Platform includes activated package content in response generation. Platform's own relevance model determines placement and phrasing.

### Mobile SDK (mediation)

The app uses a mediation layer. Packages map to network deals.

- **Context Match**: Router sends app ID, placement type, content context. Buyer responds with activated packages.
- **Identity Match**: Router sends device token (IDFV or publisher-scoped). Buyer responds with eligibility.
- **Activation**: SDK activates the corresponding network deals. If multiple packages are active, SDK applies its own priority/waterfall logic.

### Retail Media

The retailer manages sponsored product placements across search results, category pages, and carousels.

- **Context Match**: Router sends search query hash, category context, available sponsored product packages. Buyer responds with activated packages + preferred GTINs + promotion eligibility.
- **Identity Match**: Router sends shopper token. Buyer responds with catalog eligibility (already purchased, in cart, viewed recently).
- **Activation**: Retailer populates carousel/search results with eligible GTINs from activated packages, filtered by catalog eligibility.

### CTV Pod Composition

The broadcaster or FAST channel composes ad pods with multiple slots.

- **Context Match**: Router sends show/episode context, pod position, available packages across multiple slots. Buyer responds with activated packages per slot + creative variants (15s vs 30s cutdown).
- **Identity Match**: Router sends household token. Buyer responds with eligibility (frequency caps per household, competitive separation).
- **Activation**: Ad server composes the pod from activated packages, respecting competitive separation and frequency constraints.

## Open Questions

1. **Batching**: Should Context Match support batching multiple surfaces in one request (e.g., a CTV pod with 5 break positions, or a retail page with 3 carousel slots)?

2. **Caching semantics**: Can the router or buyers indicate that a Context Match response is cacheable for N seconds? High-traffic pages with stable content would benefit significantly.

3. **Temporal decorrelation specification**: How precisely should the fuzzing between context and identity requests be specified? Minimum delay? Distribution? Is the router responsible for fuzzing, or the publisher?

4. **User token lifecycle**: Should the protocol specify how publishers generate opaque user tokens (rotating, per-session, per-buyer), or is this entirely publisher-defined? Per-buyer tokens would prevent cross-buyer correlation but increase complexity.

5. **Enrichment-only agents**: Some agents only provide enrichment signals (segments), not package activation. Distinct capability, or just a Context Match response with empty `activate`?

6. **TEE implementation requirements**: Must the router use AWS Nitro Enclaves specifically, or should the spec be TEE-agnostic (supporting Intel SGX, ARM TrustZone, etc.)? What are the minimum attestation requirements?

7. **Capability discovery latency**: How does the router learn latency characteristics of each buyer agent? Declared in adagents.json, or learned empirically via adaptive timeouts?

8. **Package conflict resolution**: When multiple buyer agents activate the same placement, is resolution purely the publisher's concern? Should TMP provide priority hints?

9. **Prebid governance path**: What's the right entry point for launching a "Prebid TMP Router" — a Prebid RFC, a standalone project, or an extension of the existing RTD module framework?

10. **Cap'n Proto schema versioning**: How do we handle schema evolution as TMP matures? Cap'n Proto supports additive changes natively, but what about breaking changes?

## Implementation Roadmap

### Phase 1: Protocol Schemas (~1 week)

Formalize TMP types into AdCP's schema system:
- Cap'n Proto `.capnp` schema files for all four message types
- JSON Schema equivalents for AdCP schema registry (`adcontextprotocol.org/schemas/v3/`)
- TypeScript types in `@adcp/client` NPM package
- Python types in `adcp` PyPI package
- adagents.json schema extension: add `tmp` capability block

Owner: AdCP governance / Emma Mulitz.

### Phase 2: Scope3 Context Match Capability (~2-3 weeks, parallel with Phase 1)

Add `context_match` handler to Scope3's existing AdCP agent endpoint. This is AXE decision logic repackaged as a TMP capability.

Key decision: the existing AXE logic lives in Go (Prebid Server RTD module) but the agentic platform is Node.js. Planning-time tools (get_products, create_media_buy) tolerate hundreds of milliseconds. Context Match needs sub-50ms. Options:
- **Go service**: Extract AXE logic into a standalone Go service behind the AdCP agent endpoint. Faster, reuses existing code.
- **Node.js handler**: Reimplement in the agentic-adapters platform. Consistent architecture, but may not meet latency.

Recommendation: Go service for the hot path, with the Node.js agent proxying to it.

### Phase 3: Scope3 Identity Match Capability (~3 weeks, after Phase 2)

New capability: given opaque user token + package list, return eligibility matrix.

Requires:
- User token → Scope3 internal ID mapping
- Frequency cap state lookup
- Audience membership evaluation against package targeting
- Intent scoring (may be V2)

### Phase 4: TMP Router MVP (~2-3 weeks, parallel with Phase 2)

Minimal Go router service:
- Reads adagents.json to discover agents with TMP capabilities
- HTTP/2 endpoints for Context Match and Identity Match from publishers
- Proxies to single buyer agent (Scope3) — no fan-out yet
- JSON wire format
- No TEE — runs as a regular service

Replaces Scope3 RTD module in Prebid Server: instead of RTD making Scope3-specific API calls with the full BidRequest, Prebid Server calls the TMP Router with a ContextMatchRequest. Router calls Scope3's context_match capability.

### Phase 5: Multi-Buyer Fan-Out (~2 weeks, after Phase 4)

- Parallel HTTP/2 calls with adaptive timeouts
- Response merging (union of activated packages, concatenation of signals)
- Package conflict detection
- Degradation handling (slow agent → skip)

### Phase 6: Cap'n Proto Wire Format (~1-2 weeks, after Phase 4)

- Generate Go code from `.capnp` schemas
- Content negotiation: `Accept: application/x-capnp` vs `application/json`
- Benchmark wire size and latency improvements

### Phase 7: TEE Enclaves (~4-6 weeks, after Phase 5)

Separate Context Router and Identity Router into AWS Nitro Enclaves:
- Dockerfile-based enclave builds (CloudX patterns)
- Key management and attestation proof generation
- PCR measurement verification
- Attestation tooling for publishers

CloudX collaboration significantly accelerates this phase. Their existing Nitro Enclave infrastructure (build scripts, key management, COSE attestation parsing, PCR verification) is directly applicable.

### Phase 8: Platform SDKs (~2-3 weeks per platform, after Phase 4)

- Mobile SDK (Swift/Kotlin): Lightweight TMP client for apps
- AI Platform API: REST endpoint for AI assistants
- Prebid.js client: JavaScript TMP client for client-side web

### Critical Path

```
Phase 1 (schemas) ─────────────────────────────────────────►
Phase 2 (context match) ───► Phase 4 (router MVP) ───► Phase 5 (multi-buyer)
Phase 3 (identity match)           │                          │
                                   ▼                          ▼
                             Phase 6 (capnp)            Phase 7 (TEE)
                                                              │
                                                              ▼
                                                        Phase 8 (SDKs)
```

**Fastest demo**: Phases 1 + 2 + 4 in parallel. ~3-4 weeks to a working Scope3 Context Match via TMP Router, replacing the RTD module for a single publisher. JSON, no TEE, single buyer. Proves the protocol.

### Key Decisions

1. **Router language**: Go (latency + Prebid alignment + CloudX TEE compatibility).
2. **Context Match hot path**: Separate Go service, not Node.js agentic-adapters.
3. **CloudX engagement**: Phase 7 TEE work is dramatically easier with their collaboration. Relationship status?
4. **Org home**: Launch under `adcontextprotocol/` GitHub org, migrate to Prebid after proving out.
5. **First publisher**: Ideally someone already running Scope3 RTD module for direct A/B comparison.
