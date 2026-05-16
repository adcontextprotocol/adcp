---
---

spec(errors): register `error-details/agent-permission-denied.json` + shared `enums/error-scope.json` discriminator vocabulary.

`PERMISSION_DENIED` recovery shape for the per-buyer-agent commercial gate (`scope: "agent"` + `status: suspended | blocked` or `reason: sandbox_only`) is now registered with `additionalProperties: false` plus `oneOf` exclusivity on `status`/`reason`, so cross-language SDKs can dispatch on the discriminator without parsing prose. The shared `error-scope.json` enum names the union vocabulary (`capability | account | agent`); each per-shape error-details schema constrains its own subset.

Closes #3883. Builds on #3831 (registered `BILLING_NOT_PERMITTED_FOR_AGENT` + cross-tenant onboarding oracle clamp).

Cross-tenant clamp mirrored from `BILLING_NOT_PERMITTED_FOR_AGENT`: sellers MUST emit `details.scope: "agent"` only when buyer-agent identity has been established via signed-request derivation or a credential-to-agent mapping; otherwise return `PERMISSION_DENIED` and omit `error.details.scope`. Recovery on the per-agent gate is terminal-pending-onboarding — agents MUST surface to a human rather than auto-retrying.

Files:
- `static/schemas/source/enums/error-scope.json` — *new*. Shared discriminator vocabulary.
- `static/schemas/source/error-details/agent-permission-denied.json` — *new*. Clamped recovery shape.
- `static/schemas/source/enums/error-code.json` — `PERMISSION_DENIED` description + recovery suggestion expanded.
- `static/schemas/source/error-details/billing-not-supported.json` — `scope` description cross-references shared vocabulary.
- `docs/building/implementation/error-handling.mdx` — new "Per-Agent Authorization Gate" subsection with dispatch example and example envelope.
