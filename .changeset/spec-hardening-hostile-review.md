---
---

docs(spec-hardening): close out hostile-reviewer punch list

Lands normative text and non-goal declarations addressing the hostile-reviewer
critique on trust, commerce, and governance semantics:

- `docs/building/understanding/security-model.mdx` — adds three bullets to "What AdCP does not do in 3.0": OAuth 2.1 is not required (mTLS / API key / RFC 9421 are the three mechanisms), cross-currency buys are deferred, protocol-level delivery disputes reconcile out-of-band.
- `docs/building/implementation/error-handling.mdx` — adds RFC 2119 normative section for throttling response behavior (MUST honor retry_after, SHOULD back off with jitter, MUST NOT retry non-throttling errors as if throttled).
- `docs/governance/campaign/specification.mdx` — adds "Both checks must pass" subsection stating the invariant that buyer-side intent and seller-side planned-delivery checks are complementary and both MUST pass against the same governance authority; contradictory conditions resolve to `denied`.
- `docs/governance/embedded-human-judgment.mdx` — adds register framing note explaining why the five principles use principles language rather than RFC 2119 (enforceable surface lives in check_governance, TERMS_REJECTED, and lifecycle tasks).
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — adds billing-grade vs best-effort normative paragraph: default is best-effort unless seller declares a finalization window in capabilities.
- `docs/governance/content-standards/index.mdx` — adds "Versioning and mid-flight amendments" section establishing pinned-at-buy as the default, with per-policy `evaluation_mode: continuous` opt-in for policies that must track regulatory changes.

Closes #2406, #2408, #2410, #2412, #2413, #2414. References #2405 (dispute flow, post-GA) and #2409 (FX cross-border, post-GA) via the Security Model non-goals list.
