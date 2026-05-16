---
"adcontextprotocol": minor
---

spec(creative): add `bills_through_adcp` capability + `BILLING_OUT_OF_BAND` error.

PR #2879 softened the creative-ad-server conformance so ad servers that bill out of band (flat license, SaaS contract, bundled enterprise — CM360 is the canonical case) stay spec-valid without returning `pricing_options`. Two follow-ups close that loop on the wire:

- `capabilities.creative.bills_through_adcp` (boolean, default false/absent) on the `get_adcp_capabilities` response — a pre-call discriminator so buyer agents can pre-filter creative agents across a portfolio before establishing an account just to probe pricing. When `true`, buyers can expect `pricing_options` on `list_creatives`, `pricing_option_id`/`vendor_cost` on `build_creative`, and `report_usage` that accepts records against the rate card.
- `BILLING_OUT_OF_BAND` (recovery: terminal) on the error-code enum — the standard code for a per-record `report_usage` rejection where the record is well-formed but the account bills via a non-AdCP channel. Distinct from `BILLING_NOT_SUPPORTED` (media-buy `billing`-value rejection) and `BILLING_NOT_PERMITTED_FOR_AGENT` (per-buyer-agent commercial gate) — signals that the entire billing surface is offline for this account, not that a specific value or caller is rejected. The code itself is the discriminator; no `error.details` shape is defined (mirroring `CONFIGURATION_ERROR`).

Strictly additive — no existing agents break. Agents that don't declare `bills_through_adcp` remain in the probe-to-discover mode buyers already tolerate. Both follow `held-for-next-minor` / 3.1 on the drift registry.

Closes #2881, #2882. Builds on #2879.

Files:
- `static/schemas/source/protocol/get-adcp-capabilities-response.json` — `bills_through_adcp` added to the `creative` block alongside `has_creative_library` / `supports_generation` / `supports_transformation` / `supports_compliance`.
- `static/schemas/source/enums/error-code.json` — `BILLING_OUT_OF_BAND` in enum, `enumDescriptions`, and `enumMetadata`.
- `scripts/error-code-drift-dispositions.json` — `held-for-next-minor` / `3.1` entry.
- `specs/creative-agent-pricing.md` — pre-account-discovery and capabilities-change sections updated.
- `static/compliance/source/specialisms/creative-ad-server/index.yaml` — `report_usage` narrative references the standard code (replaces "vendor codes are fine today" placeholder).
- `docs/protocol/get_adcp_capabilities.mdx` — capability table row + example.
