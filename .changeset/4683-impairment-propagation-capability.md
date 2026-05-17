---
"adcontextprotocol": minor
---

New capability `capabilities.media_buy.impairment_propagation` on `get_adcp_capabilities` — sellers declare how they propagate dependency-resource impairments (creative rejection, audience suspension, catalog withdrawal, event source insufficient, property depublication) to buyers.

Three postures, each a real-world pattern:
- **`snapshot`** (default) — seller populates `media_buy.health` and `media_buy.impairments[]` on `get_media_buys` reads. The `impairment.coherence` compliance assertion grades the propagation. Premium guaranteed sellers tend toward this.
- **`webhook_only`** — seller fires `notification-type: impairment` webhooks but does NOT mirror the impairments on the buy snapshot. Buyers reconcile state from the push channel alone. High-throughput SSPs / DSPs tend toward this when state lives in the event stream.
- **`out_of_band`** — seller propagates outside the AdCP protocol surface entirely (email to trafficker, dashboard, partner-specific notification feed). Long-tail and enterprise-bundled platforms tend toward this.

Sellers declaring `webhook_only` or `out_of_band` are not graded by the `impairment.coherence` storyboard scenarios (`dependency_impairment`, `dependency_impairment_cardinality`) — those grade `not_applicable` for those postures. Their compliance bar is the webhook contract or the offline agreement, not snapshot coherence.

Docs: `lifecycle.mdx § Compliance` extended with a paragraph describing the capability and how it gates the snapshot-coherence rules. Each posture documented as a legitimate operational pattern, not a workaround.

Runtime gating in the compliance runner is the adcp-client follow-up — once the runner reads the capability and grades `not_applicable` accordingly, the storyboard scenarios will skip cleanly on `webhook_only` / `out_of_band` sellers. Spec-side declaration ships in this PR; runner-side `not_applicable` enforcement tracked in the adcp-client follow-up.

Closes #4683.
