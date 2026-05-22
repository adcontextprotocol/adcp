---
---

feat(aao): re-introduce `?include=properties` on `GET /api/v1/agents/{agent_url}/publishers` so SDK divergence detectors can run full set-diff, not just count comparison (#4890).

**Why.** The directory's per-publisher `properties_authorized` count is a false-negative trap for divergence detection. Count-equality is not set-equality — a publisher rotating N properties leaves the count unchanged while the underlying set is entirely different. The SDK divergence detector ([adcp-client-python#752](https://github.com/adcontextprotocol/adcp-client-python/pull/752)) currently has to short-circuit to "no divergence" on count match, missing routine publisher rotations against managed-network parent files (the cafemedia ~6,800-publisher shape).

**What this changeset defines** (spec-only — server implementation tracked separately).

1. **Query parameter** (`docs/aao/directory-api.mdx`). `?include=properties` — repeated-key form, same encoding rule as `status`. Default off (preserves the current envelope and payload size). Unknown values return `400`.

2. **Schema delta** (`static/schemas/source/aao/agent-publishers.json`). `PublisherEntry.property_ids: array of string`, present iff request included `include=properties`. Same population `properties_authorized` counts, surfaced as IDs. Per-publisher scope; never network-wide. Order unspecified — consumers treat as a set.

3. **Cost framing.** Roughly per-publisher-property-count × ~16 bytes per ID. On a managed-network parent file (~6,800 publishers × avg 1 property each ≈ 7 KB additional). Opt-in via the include flag so the default page payload is unchanged.

4. **Recommended workflow.** Divergence detectors SHOULD request `include=properties` and compare directory `property_ids[]` against a federated fetch as a set, not as a count.

**Out of scope.** Full property objects inline (not just IDs — consumers fetch detail via existing per-domain primitives). Pagination of very-large-per-publisher property lists (defer to v3 if it becomes a real shape).

**Follow-ups.**
- Server implementation in `server/src/routes/registry-api.ts` + `server/src/db/federated-index-db.ts` — wire `include=properties` through to a SQL projection that surfaces the resolved `property_ids[]` (already computed during `properties_authorized` count derivation per #4836). Update the Zod response schema (`AgentPublishersEntrySchema`) and regenerate `static/openapi/registry.yaml`. Integration test coverage parallel to the existing detail-row tests.
- SDK companion: upgrade `detect_publisher_properties_divergence` to full set-diff (`PublisherDivergence.missing_in_inline` / `.missing_in_federated` populated from `property_ids`, not `None`). Mirror in adcp-client (TS/JS) and adcp-go.
