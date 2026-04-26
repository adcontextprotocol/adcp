---
---

Bumps `@adcp/client` 5.17.0 → 5.18.0. The release ships our `get_media_buys` request-builder fix (adcp-client#987 closing #983), the broader placeholder-ID enricher audit (#991), schema-aware brand/account injection in the storyboard runner (#943), the new `a2a_context_continuity` validator for multi-step storyboards (#962), A2A wire-shape capture (#904), and triage-bot ergonomics that close the loop on adcp#3121 (#992, #993).

Two breakages surfaced and fixed:

- **Hint type widening.** `StoryboardStepHint` widened from `ContextValueRejectedHint` to a five-kind union (`context_value_rejected | shape_drift | missing_required_field | format_mismatch | monotonic_violation`). `renderAllHintFixPlans` in `server/src/addie/services/storyboard-fix-plan.ts` now accepts the broader type and filters to `context_value_rejected` for the existing render path. Richer rendering for the other four kinds is a follow-up — today they're silently dropped from the fix-plan section, but the runner's per-hint `message` field still surfaces them upstream.

- **Strict request-schema validation in storyboard runner.** The `create_property_list` request schema declares `additionalProperties: false`; `pagination-integrity-property-lists.yaml` was passing a `list_type: "inclusion" | "exclusion"` field that isn't in the schema. 5.18.0's runner rejects unknown fields strictly. Removed the `list_type` field — it never affected agent behavior (no handler reads it).

Multi-page upgrade for `get_media_buys_pagination_integrity` deferred — adcp-client's convention extractor populates `context.media_buy_id` from the first-page response, then the request-builder injects that ID and turns the second call into an ID-lookup. Filed adcp-client#998 with the diagnosis and fix options. Storyboard stays at the single-step pagination-envelope assertion until the SDK fix lands.
