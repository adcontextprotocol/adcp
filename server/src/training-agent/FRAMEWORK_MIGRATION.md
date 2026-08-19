# Training-agent SDK framework migration

Status: active. The public per-tenant MCP routes are built with the
`@adcp/sdk` decisioning framework. `task-handlers.ts` remains the shared
training-domain engine used by the framework adapters and by Addie's in-process
training calls; it is no longer the public route dispatcher.

## Current architecture

- `tenants/registry.ts` constructs one SDK server registry per public profile.
- `v6-*-platform.ts` files implement the SDK platform specialisms.
- `tenants/router.ts` owns authentication, version projection, profile routes,
  and the stateless HTTP transport.
- `task-handlers.ts` owns deterministic sandbox state and legacy domain logic.
  Platform methods call domain handlers directly and translate domain errors to
  `AdcpError` at the platform boundary.
- `executeTrainingAgentTool` remains for trusted in-process training flows. It
  must not be called from an SDK platform method because doing so would create a
  second idempotency/task-dispatch layer inside the framework-owned one.

## AdCP 3.2 media-buy lifecycle

SDK 14 registers the primary seven-tool lifecycle through
`TrainingSalesPlatform.mediaBuyLifecycle`:

- `list_products`
- `request_proposals`
- `refine_proposals`
- `decline_proposals`
- `buy_products`
- `accept_proposal`
- `control_media_buy`

The four discovery/proposal adapters reuse the deterministic product catalog
and proposal state machine. The three commitment/control adapters reuse the
existing media-buy state engine while returning the compact SDK 14 response
shapes. SDK 14 owns request validation, caller authentication, idempotency,
and response projection for all seven tools.

Proposal state is partitioned by the SDK-resolved authenticated principal.
Each proposal record also retains its trusted originating account so
`accept_proposal` returns `PROPOSAL_NOT_FOUND` for a cross-account attempt
without disclosing whether the proposal exists.

Accepted direct purchases and committed proposals persist an immutable
canonical proposal snapshot on the media buy. `get_media_buys` returns that
snapshot and its digest, allowing later amendments and cancellations to bind
to the exact accepted terms.

## 3.x compatibility policy

The deprecated `SalesPlatform` methods remain registered so explicit 3.0 and
3.1 calls to `get_products`, `create_media_buy`, and `update_media_buy` keep
working during the 3.x compatibility window.

- Default 3.2 discovery advertises the native lifecycle, not the deprecated
  aliases.
- 3.0 compatibility registries omit `mediaBuyLifecycle` entirely because SDK
  proposal negotiation is a 3.2 feature.
- Capability projection removes lifecycle and proposal-refinement metadata for
  pre-3.2 callers.
- The current wire bundle is `3.2-beta.2`; `3.2-beta.0` remains only as the
  historical feature-introduction boundary for rejected discovery responses.

## Invariants for future changes

1. Platform adapters call domain handlers directly; never recursively dispatch
   through `executeTrainingAgentTool`.
2. Mutation identity comes from SDK context (`callerMutationScope`,
   `proposalRefinementScope`, and resolved account metadata), never buyer input.
3. Failed mutations must leave revisions and persisted state unchanged.
4. Compact-to-legacy adapters preserve every accepted commercial term or reject
   the request before commitment.
5. Never synthesize package identifiers in a compact response; bind only to IDs
   returned by the media-buy engine.
6. Profile capability metadata is construction-time policy. A request or auth
   extension cannot change the platform's negotiation profile.
7. Keep the static tenant tool catalog aligned with the SDK's live `tools/list`
   response and update the drift test with every registration change.

## Required regression coverage

Changes to the sales platform should cover:

- tool discovery for default 3.2 and explicit 3.0/3.1 compatibility;
- list -> direct buy -> read -> control, including accepted snapshot readback;
- request -> refine/finalize -> accept -> read;
- proposal digest mismatch and cross-account non-disclosure;
- failed control atomicity (no revision increment or partial package change);
- tenant tool-catalog drift, typecheck, and the tenant-routing suite.
