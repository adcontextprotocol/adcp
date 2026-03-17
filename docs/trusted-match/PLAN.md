# Trusted Match Protocol — Project Plan

## What This Is

TMP (Trusted Match Protocol) is AdCP's real-time execution layer. It fills the gap between `create_media_buy` (planning time) and `get_media_buy_delivery` (reporting). When a user visits a page, opens an app, or chats with an AI assistant, TMP determines which pre-negotiated packages should activate and how they should be configured.

## Origin

This work started as research into whether Cap'n Proto could improve the Scope3 RTD module in Prebid Server. That led to a broader insight: the RTD module pattern (send full OpenRTB BidRequest to a vendor, get signals back) is the wrong abstraction for real-time package activation. The right abstraction is:

1. Publisher sends available packages + content context → buyer says which to activate
2. Publisher sends user token + package list → buyer returns eligibility matrix
3. Publisher joins both results and activates packages via their own ad server/platform/SDK

This is what TMP defines. The two operations (Context Match and Identity Match) run in separate TEE enclaves so buyers never see user identity paired with page context.

## Key Design Decisions

- **Pre-negotiated, not real-time priced.** Prices are agreed at planning time. TMP activates; it doesn't bid.
- **Publisher-controlled.** Publisher sends the menu (available packages). Buyer selects from it.
- **Privacy by structural separation.** Context and identity in separate TEE enclaves. Not a policy — an architectural constraint, attestable via Nitro Enclaves.
- **Catalog-aware.** Buyers specify preferred GTINs, creative variants, promotions within package bounds.
- **Matching, not auctioning.** Auctions are a resolution strategy that sits on top. The protocol primitive is matching.
- **TMP Router handles fan-out.** Infrastructure (potential Prebid project) that reads adagents.json, fans out to N buyer agents, merges responses.
- **Agents declare capabilities, not endpoints.** `context_match` and `identity_match` are capabilities on existing AdCP agent URLs.

## Related Work

- **CloudX OpenAuction** (github.com/cloudx-io/openauction): TEE-based auction in Go with Nitro Enclaves. Complementary — their auction is a resolution strategy on top of TMP. Their TEE infrastructure (enclave builds, attestation, key management) is directly applicable to the TMP Router.
- **AXE (Agentic eXecution Engine)**: Scope3's current implementation of real-time package activation via Prebid Server RTD module. TMP generalizes AXE into a protocol-level primitive.
- **Prebid Server Scope3 RTD module**: The Go code that sends full OpenRTB BidRequests to Scope3's API. Would be replaced by a generic TMP module.

## Documents in This Directory

### Documentation (for the AdCP docs site)

| File | Purpose |
|---|---|
| `index.mdx` | Overview — what TMP is, execution gap, lifecycle fit |
| `execution-gap.mdx` | Motivation — why OpenRTB and auctions are wrong for execution |
| `context-and-identity.mdx` | Core concepts — both operations with retail walkthrough |
| `privacy-architecture.mdx` | Privacy — TEE enclaves, attestation, what each party learns |
| `router-architecture.mdx` | Infrastructure — dual-enclave router, fan-out, Prebid relationship |
| `surfaces/web.mdx` | Web publishers with ad servers |
| `surfaces/ai-assistants.mdx` | AI chat monetization |
| `surfaces/mobile.mdx` | Mobile mediation |
| `surfaces/retail-media.mdx` | Sponsored products with GTIN refinement |
| `surfaces/ctv.mdx` | CTV pod composition |
| `specification.mdx` | Formal spec — message types, field tables, conformance |

### Internal

| File | Purpose |
|---|---|
| `RFC.md` | Full RFC with implementation roadmap and open questions |
| `PLAN.md` | This file — project context for anyone picking up the work |

## Navigation Integration

These docs should appear in `docs.json` as a new Protocol domain:

```
[Protocol]
  ...
  [Trusted Match]
    docs/trusted-match/index
    [Concepts]
      docs/trusted-match/execution-gap
      docs/trusted-match/context-and-identity
      docs/trusted-match/privacy-architecture
    [Building]
      docs/trusted-match/router-architecture
    [Surface Guides]
      docs/trusted-match/surfaces/web
      docs/trusted-match/surfaces/ai-assistants
      docs/trusted-match/surfaces/mobile
      docs/trusted-match/surfaces/retail-media
      docs/trusted-match/surfaces/ctv
    [Reference]
      docs/trusted-match/specification
```

## Existing Pages That Need Updates

1. **Media Buy index** — add TMP to the lifecycle table
2. **AXE page** (`docs/media-buy/advanced-topics/agentic-execution-engine`) — reframe as predecessor, link to TMP
3. **adagents.json page** — document the `capabilities.tmp` extension
4. **Protocol architecture page** — add TMP to ecosystem mapping

## Implementation Roadmap (from RFC)

| Phase | What | Effort |
|---|---|---|
| 1 | Protocol schemas (capnp + JSON Schema + @adcp/client types) | ~1 week |
| 2 | Scope3 Context Match capability (Go service behind AdCP agent) | ~2-3 weeks |
| 3 | Scope3 Identity Match capability | ~3 weeks |
| 4 | TMP Router MVP (Go, single buyer, JSON, no TEE) | ~2-3 weeks |
| 5 | Multi-buyer fan-out | ~2 weeks |
| 6 | Cap'n Proto wire format | ~1-2 weeks |
| 7 | TEE enclaves (CloudX collaboration accelerates) | ~4-6 weeks |
| 8 | Platform SDKs (mobile, AI, Prebid.js) | ~2-3 weeks each |

**Fastest demo**: Phases 1+2+4 in parallel → ~3-4 weeks to Scope3 Context Match via TMP Router replacing RTD module for one publisher.

## Key Decisions Still Needed

1. **CloudX engagement**: Phase 7 TEE work is dramatically easier with their collaboration. Relationship status?
2. **Prebid governance**: Does the router launch under `adcontextprotocol/` first, or go directly to Prebid?
3. **First publisher**: Who tests TMP first? Ideally someone already running Scope3 RTD module.
4. **Go vs Node.js for Context Match hot path**: Sub-50ms latency favors Go. Agentic platform is Node.js. Recommendation: Go service proxied through the agent endpoint.
