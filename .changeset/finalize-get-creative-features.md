---
"adcontextprotocol": minor
---

Align `get_creative_features` documentation with its already-Final lifecycle stage, and close a phantom error code.

Per [specification-lifecycle](docs/reference/specification-lifecycle.mdx) (a surface with no `x-status` marker that has shipped in a GA release is at the **Final** stage), `get_creative_features` is already Final: none of its schemas (`get-creative-features-request.json`, `get-creative-features-response.json`, `creative-feature-result.json`) carry `x-status: experimental`, it shipped in 3.0 GA, and it is absent from the canonical `experimental_features` list in [experimental-status](docs/reference/experimental-status.mdx). It is listed as a **Required** creative-governance task in `docs/protocol/required-tasks.mdx`, and its capability is advertised via `get_adcp_capabilities.creative_features[]`. The task carried a stale "AdCP 3.0 Proposal — under development" prose banner that contradicted that Final state. This is not a Proposed→Final transition — the lifecycle stage is unchanged — so no decision record is required; it removes a contradictory documentation artifact.

**Changes**

- Removed the proposal `<Info>` banner from `docs/governance/creative/get_creative_features.mdx` and the creative-governance section landing page `docs/governance/creative/index.mdx`. The section's only banner-marked page was `get_creative_features`; `provenance-verification` carries no proposal banner.
- Added `CREATIVE_INACCESSIBLE` to the canonical error-code enum (with `enumDescriptions` and `enumMetadata`, recovery `correctable`). The `get_creative_features` error example documented this code but it was absent from the enum — a documented task surface must not emit a phantom code (#3456 enum-membership criterion). It fires when a creative governance agent cannot retrieve the submitted `creative_manifest` assets at all — distinct from `CREATIVE_NOT_FOUND` (a `creative_id` absent from the agent's library), `CREATIVE_REJECTED` (assets retrieved but failed policy), and `GOVERNANCE_UNAVAILABLE` (agent unreachable; transient).

No schema field changes; no behavior change to the task. The `creative/specification.mdx` (v1 creative model) and `media-buy/specification.mdx` proposal banners are unrelated surfaces and unchanged. The frozen `dist/docs/<version>/` release snapshots still carry the banner by design — they refresh at the next snapshot cut, not on content PRs.

This unblocks the 3.1 creative-feature-oracle gate/rank pipeline (#5311 / #5305), which uses `get_creative_features` as the gate's feature source.

Refs #5311, #5305, #3456.
