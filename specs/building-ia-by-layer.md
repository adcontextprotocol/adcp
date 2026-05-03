# Reorganize `/docs/building` by layer

A proposed information architecture for the `/docs/building` section, organized by the L0–L4 stack model introduced on `/docs/building/sdk-stack`. Goal: turn 13 flat top-level pages plus three half-overlapping subgroups into a single nav whose shape *is* the decision the reader is making.

## Problem

Today `/docs/building` has 13 top-level pages plus `understanding/`, `integration/`, and `implementation/` subgroups. Five of those top-level pages overlap on the same audience — `where-to-start`, `sdk-stack`, `schemas-and-sdks`, `build-an-agent`, `migrate-from-hand-rolled` all answer some version of "how do I start." The result:

- A new reader can't tell which page is the entry point.
- The depth signal (use SDK vs. go lower) is buried — every reader sees every page regardless of how deep they need to go.
- Cross-cutting pages (`version-adaptation`, `schemas-and-sdks`) sit at the same nav level as scoped pages (`grading`, `aao-verified`), which flattens the hierarchy and hides what's foundational.
- Verification surfaces (`conformance`, `aao-verified`, `grading`, `validate-your-agent`, `get-test-ready`, `compliance-catalog`) are scattered across the top level.

## Goal

The nav should answer the reader's first question — *how deep do I need to go?* — with a single decision point, and stop being relevant once they've stopped descending. A reader who picks an SDK and writes L4 should not have to walk past L1 RFC 9421 pages to get to "operating an agent."

## Proposed top-level shape

The L0–L4 spine is the same for both sides of an AdCP conversation — **agent (server)** and **caller (client)** — but the work is asymmetric (server enforces, client consumes). Each layer in the build-by-layer group surfaces both perspectives, with caller-side typically a subset. The reader picks a side at L4 and the lower layers stay parallel.

```
Building
├── Overview                                  ← decision page; replaces today's index + where-to-start
├── Concepts (orthogonal — kept separate)
│   ├── Why AdCP
│   ├── How agents communicate
│   ├── AdCP vs OpenRTB
│   ├── Protocol comparison
│   ├── Security model
│   └── Industry landscape
├── Build by layer                            ← the new spine
│   ├── L4 — Business logic (start here)
│   │   ├── Choose your SDK
│   │   ├── Build an agent (server side, skill-file path)
│   │   ├── Build a caller (client side)
│   │   └── Migrate from hand-rolled
│   ├── L3 — Protocol semantics (going lower)
│   │   ├── Lifecycle state machines        ← server enforces, client handles
│   │   ├── Idempotency                      ← server caches, client generates keys
│   │   ├── Async tasks & webhooks           ← server emits, client receives
│   │   ├── Error handling                   ← server emits, client classifies
│   │   ├── comply_test_controller           (server-only; conformance surface)
│   │   └── Response envelope                ← server populates, client parses
│   ├── L2 — Auth & registry
│   │   ├── Account state                    (server-side multi-tenancy)
│   │   ├── Agent identity & registry lookup ← both sides; client publishes + looks up
│   │   ├── Authentication                   ← both sides
│   │   ├── Brand resolution & AAO bridge    ← both sides
│   │   └── Accounts and agents              (server-side scoping)
│   ├── L1 — Identity & signing
│   │   ├── RFC 9421 message signatures      ← symmetric; mirrored direction
│   │   ├── Webhook verifier tuning          ← server emits, client verifies
│   │   └── Key rotation & KMS               ← both sides
│   └── L0 — Wire & transport                ← symmetric on both sides
│       ├── Schemas
│       ├── MCP integration
│       ├── A2A integration
│       └── A2A response extraction / MCP response extraction
├── Cross-cutting (spans all layers)
│   ├── SDK stack reference                  ← the meta map
│   ├── Version adaptation
│   └── Known ambiguities
├── Verification & trust                     (primarily server-side)
│   ├── Conformance
│   ├── Compliance catalog
│   ├── Validate your agent
│   ├── Grading
│   ├── Get test ready
│   └── AAO Verified
└── Operating                                (both sides; weighted server)
    ├── Operating an agent
    ├── Storyboard troubleshooting
    ├── Transport errors
    ├── Orchestrator design
    └── Seller integration
```

### Server vs client through the nav

Three ways to handle the asymmetry without doubling the page count:

1. **Per-page side-band callouts** (recommended). Each layer-page leads with the server view (which is where the bulk of the work is) and ends with a "Client side" callout that names the (lighter) caller surface. Same pattern the rewritten `sdk-stack` page uses.
2. **Tabs within a page.** Each L0–L3 page exposes Server / Client tabs. Cleaner separation, but tabs hide content from search and from the "scroll the page to learn the layer" reader.
3. **Side-specific subpages.** Every layer-page splits into `…/server` + `…/client`. Cleanest separation, but doubles nav weight and most pages would have a tiny client half.

Recommend **option 1**: it matches the asymmetry (server-heavy with a smaller mirrored client surface) without doubling pages. The two L4 entries (`Build an agent` and `Build a caller`) are the explicit fork; below L4 the side-band approach handles the divergence.

## Per-page disposition

Every existing page in `docs/building/`:

| Current path | New home | Notes |
|---|---|---|
| `building/index` | `building/index` (rewritten) | Becomes a single decision page that absorbs `where-to-start` + the section-overview content. Delete the three Card-Group hand-off into Understanding / Foundations / Implementation. |
| `building/where-to-start` | merged into `building/index` | Same audience, same content shape — they fight each other. |
| `building/sdk-stack` | `building/cross-cutting/sdk-stack` | Stays as the meta-map; the layered nav is its embodiment. |
| `building/schemas-and-sdks` | split: SDK list → `building/by-layer/L4/choose-your-sdk`; schemas content → `building/by-layer/L0/schemas` | Two concerns under one title today. |
| `building/build-an-agent` | `building/by-layer/L4/build-an-agent` | The L4 server-side entry point. |
| *(new page)* | `building/by-layer/L4/build-a-caller` | The L4 client-side entry point. Does not exist today; pulls existing caller content from `/docs/protocol/calling-an-agent` into a build-shaped page. |
| `building/migrate-from-hand-rolled` | `building/by-layer/L4/migrate-from-hand-rolled` | Logically L4 (deciding which layer to swap), even though the content discusses lower layers. |
| `building/version-adaptation` | `building/cross-cutting/version-adaptation` | Cuts across L0–L3. |
| `building/get-test-ready` | `building/verification/get-test-ready` | |
| `building/validate-your-agent` | `building/verification/validate-your-agent` | |
| `building/grading` | `building/verification/grading` | |
| `building/conformance` | `building/verification/conformance` | |
| `building/compliance-catalog` | `building/verification/compliance-catalog` | |
| `building/aao-verified` | `building/verification/aao-verified` | The trust mark; sits at the end of the verification group. |
| `building/operating-an-agent` | `building/operating/operating-an-agent` | |
| `building/understanding/*` (6 pages) | `building/concepts/*` | Rename group; content unchanged. "Concepts" reads better than "Understanding AdCP" as a sibling to "Build by layer." |
| `building/understanding/index` | `building/concepts/index` | Rename only; rewrite the group landing copy to match the new "Concepts" framing. |
| `building/integration/index` | *delete* | Replaced by per-layer landings (L0, L1, L2). The current Foundations group landing has no equivalent under "Build by layer." Redirect to `building/by-layer/L0`. |
| `building/implementation/index` | *delete* | Same — replaced by per-layer landings (L1, L3) plus `building/operating/`. Redirect to `building/by-layer/L3` (most-cited destination for current Implementation-group inbound links). |
| `building/integration/mcp-guide` | `building/by-layer/L0/mcp-guide` | |
| `building/integration/a2a-guide` | `building/by-layer/L0/a2a-guide` | |
| `building/integration/a2a-response-format` | `building/by-layer/L0/a2a-response-format` | |
| `building/integration/context-sessions` | `building/by-layer/L2/context-sessions` | Sessions are an L2 concern (principal scoping over time). |
| `building/integration/authentication` | `building/by-layer/L2/authentication` | |
| `building/integration/account-state` | `building/by-layer/L2/account-state` | |
| `building/integration/accounts-and-agents` | `building/by-layer/L2/accounts-and-agents` | |
| `building/implementation/task-lifecycle` | `building/by-layer/L3/task-lifecycle` | |
| `building/implementation/async-operations` | `building/by-layer/L3/async-operations` | |
| `building/implementation/webhooks` | `building/by-layer/L3/webhooks` | |
| `building/implementation/error-handling` | `building/by-layer/L3/error-handling` | |
| `building/implementation/comply-test-controller` | `building/by-layer/L3/comply-test-controller` | |
| `building/implementation/orchestrator-design` | `building/operating/orchestrator-design` | Runtime design pattern. |
| `building/implementation/security` | `building/by-layer/L1/security` | RFC 9421 implementation profile. |
| `building/implementation/webhook-verifier-tuning` | `building/by-layer/L1/webhook-verifier-tuning` | Signature verification tuning. |
| `building/implementation/transport-errors` | `building/operating/transport-errors` | Operational concern. |
| `building/implementation/mcp-response-extraction` | `building/by-layer/L0/mcp-response-extraction` | |
| `building/implementation/a2a-response-extraction` | `building/by-layer/L0/a2a-response-extraction` | |
| `building/implementation/seller-integration` | `building/operating/seller-integration` | |
| `building/implementation/storyboard-troubleshooting` | `building/operating/storyboard-troubleshooting` | |
| `building/implementation/known-ambiguities` | `building/cross-cutting/known-ambiguities` | Cuts across the spec. |

## Cross-cutting page handling

Three pages don't fit cleanly under one layer and need a `cross-cutting/` group at peer level to "Build by layer":

- **SDK stack reference** — by definition spans all layers; it *is* the map.
- **Version adaptation** — touches L0 (wire), L3 (error), and the SDK majors story.
- **Known ambiguities** — spec-level edge cases that surface across layers.

A fourth case to flag — **schemas-and-sdks** today bundles the SDK-coverage matrix (L4 picking question) with the schema-bundle reference (L0 wire concern). The spec proposes splitting it; the SDK list goes under L4 ("Choose your SDK"), the schema-bundle reference goes under L0.

## Redirect map

Mintlify supports redirects via `docs.json` `redirects[]`. Every moved page needs an entry. Skeleton:

```json
{
  "redirects": [
    { "source": "/docs/building/where-to-start", "destination": "/docs/building" },
    { "source": "/docs/building/integration/mcp-guide", "destination": "/docs/building/by-layer/L0/mcp-guide" },
    { "source": "/docs/building/implementation/task-lifecycle", "destination": "/docs/building/by-layer/L3/task-lifecycle" }
    // … one entry per moved page; ~30 total
  ]
}
```

Inbound link audit also needed: `rg "docs/building/" docs/ server/ -l` to catch internal cross-links the move would break. Most cross-links are anchor-targets within `sdk-stack` and the storyboard-error pages; both stay where they are or move predictably.

## Phasing

Two options:

1. **Single PR.** All page moves + redirects + nav rewrite + the new `building/index` decision page in one shot. Simpler review (the mental model is whole), riskier merge (every internal link in the docs needs to land in the same commit).
2. **Three PRs.**
   - PR1 — Add the new `building/index` decision page; leave existing pages in place. Low risk; tests the new entry point.
   - PR2 — Move pages into `by-layer/`, `concepts/`, `cross-cutting/`, `verification/`, `operating/` subdirs; add all redirects. The big one.
   - PR3 — Split `schemas-and-sdks` into `L0/schemas` + `L4/choose-your-sdk`; rewrite the merged content.

Recommend **option 2** — PR1 and PR3 are each independently shippable, and PR2 is a mechanical move that's easier to review on its own.

## Decisions

Locked in 2026-05-03 in conversation with Brian:

1. **Concepts (renamed from "Understanding AdCP").** Group-title strings don't drive search rankings; page titles do, and those don't change. Low-cost, better hierarchy signal.
2. **Hosted implementations table stays on `sdk-stack`.** It sits next to the SDK coverage matrix because it answers the same question with a different shape ("library vs deployable agent"). Moving to `Operating` would split a unified comparison.
3. **Sidebar depth: three levels is fine.** Mintlify renders nested groups well. Default-expand state: L4 expanded (the recommended path); L0/L1/L2/L3 collapsed (so the sidebar isn't a wall of links). Readers actively descending click each layer open deliberately.
4. **Caller-side asymmetry: per-page side-band callouts.** Matches the real asymmetry (server-heavy with a lighter mirrored client surface), keeps both perspectives indexable on one page, avoids tab content disappearing from search. Explicit L4 fork (`Build an agent` vs `Build a caller`) gives caller-only readers a top-of-page entry point.
5. **`/docs/protocol/calling-an-agent` overlap: fork.** `/protocol/` keeps the spec-level reference (what `get_adcp_capabilities` returns, agent-card fields). `/building/by-layer/L4/build-a-caller` becomes the implementation guide (install SDK, write a calling app, handle errors, ingest reporting). Different audiences, different shapes; the build-side page is what's missing.

## Deferred

1. **Verification placement.** Whether the verification group lives under `/building` (today), gets promoted to a top-level section, or splits (trust narrative top-level + build-loop tools under `/building`) — **deferred until the AAO Verified L3/L4 reframing lands.** The current `(Spec)` / `(Live)` qualifier framing is being reconsidered as L3 Verified (protocol-correct, storyboard-issued) vs L4 Verified (real-inventory-behaving-correctly, observation-issued), which would map cleanly onto the L0–L4 spine of the rest of the build section. Tracked under the [Trust, Identity, and Governance in AdCP master epic](https://github.com/adcontextprotocol/adcp/issues/3925) and the [canonical test campaigns RFC](https://github.com/adcontextprotocol/adcp/issues/3046). Revisit verification placement once that reframing is decided — the mapping may make the "promote vs split" question answer itself.

## Non-goals

- Rewriting page content. This spec is about IA, not copy. A few merges (where-to-start → index, schemas-and-sdks split) require rewriting; everything else is pure relocation + redirects.
- Touching `/docs/protocol/`, `/docs/registry/`, or other top-level sections. Caller-side material may want a layered home eventually but is out of scope here.
- Changing the L0–L4 model itself. The spec on `sdk-stack` is the source of truth; this IA spec just embodies it in nav.
