---
"adcontextprotocol": major
---

Complete the Account migration for property-list and collection-list task families. Removes the deprecated `principal: string` field everywhere it appeared and replaces it with `account: $ref /schemas/core/account-ref.json`, bringing these two families in line with every other task family in AdCP 3.0 (media-buy, creative, signals, content-standards, account).

## Motivation

Per the glossary (`docs/reference/glossary.mdx:228`), `Principal` is deprecated: AdCP now splits authentication (**Agent**) from billing/platform mapping (**Account**). Every request family that needs account scoping already uses `account: $ref /schemas/core/account-ref.json` — except property-list and collection-list, which still carried the legacy `principal` field. This PR finishes the migration so there is a single, consistent identity primitive across the spec.

A protocol-expert audit in #2333 confirmed that without this change, the training agent is forced to use `brand.domain` as a session-key proxy — a training-only workaround that diverges from how real sellers derive isolation (auth-derived Agent scoped to Account).

## Breaking changes

**Schema rename (4 files):** `principal: string` removed; `account: $ref /schemas/core/account-ref.json` added.
- `static/schemas/source/property/property-list.json`
- `static/schemas/source/property/list-property-lists-request.json`
- `static/schemas/source/collection/collection-list.json`
- `static/schemas/source/collection/list-collection-lists-request.json`

**New optional `account` field added (9 request schemas):** gives callers a way to disambiguate across accounts when the authenticated agent has access to more than one, matching the `get-media-buys-request.json` pattern.
- `static/schemas/source/property/create-property-list-request.json`
- `static/schemas/source/property/get-property-list-request.json`
- `static/schemas/source/property/update-property-list-request.json`
- `static/schemas/source/property/delete-property-list-request.json`
- `static/schemas/source/property/validate-property-delivery-request.json`
- `static/schemas/source/collection/create-collection-list-request.json`
- `static/schemas/source/collection/get-collection-list-request.json`
- `static/schemas/source/collection/update-collection-list-request.json`
- `static/schemas/source/collection/delete-collection-list-request.json`

`brand` stays on `create_*_list` and `update_*_list` as campaign-identity metadata (same role as in `create-media-buy`). It is no longer overloaded as an identity primitive on read/list/update/delete.

## Reference implementation (training agent)

- `server/src/training-agent/account-handlers.ts` — `ACCOUNT_REF_SCHEMA` is now exported for reuse.
- `server/src/training-agent/property-handlers.ts` and `inventory-governance-handlers.ts` — all 10 CRUD + validate tools now declare `account: ACCOUNT_REF_SCHEMA` in their inputSchema. The stray `brand`-on-list/get/delete workaround introduced in #2333 is removed.
- `PropertyListState.principal` is renamed to `PropertyListState.account: AccountRef`. `CollectionListState` gains `account: AccountRef`. Both handlers persist and echo the account on list/get responses.

## Storyboards

- `static/compliance/source/specialisms/property-lists/index.yaml` — every `brand:` block on list/get/update/delete/validate_property_delivery is now `account: { brand: { domain }, operator }`; `principal: "acmeoutdoor.example"` on the list call is gone.
- `static/compliance/source/specialisms/collection-lists/index.yaml` — same migration.

## Docs

Fixed references to `principal` that describe the protocol (not the deprecated-term glossary entry, which stays as a redirect, and not `docs/building/implementation/security.mdx` legacy vocabulary):
- `docs/governance/property/tasks/property_lists.mdx`
- `docs/governance/collection/tasks/collection_lists.mdx`
- `docs/governance/collection/index.mdx`
- `docs/governance/property/specification.mdx`

## Migration guide

For agents that were declaring `principal` on list or resource payloads:
- Replace `principal: "some-id"` with `account: { account_id: "some-id" }` if you had a seller-assigned ID.
- Replace `principal: "example.com"` with `account: { brand: { domain: "example.com" }, operator: "example.com" }` for the direct-operated brand case.
- For agency-operated flows, use `account: { brand: { domain: "brand.com" }, operator: "agency.com" }`.

Creators can continue to pass `brand` on `create_*_list` / `update_*_list` — that field is unchanged and carries campaign metadata (industry, audience) per the spec's existing description.

All request schemas for this family declare `additionalProperties: false`, so stray `principal` fields on the wire will now fail validation rather than being silently ignored. Sellers upgrading their clients should search their payloads for `"principal":` and replace per the guide above.

**Follow-up (not in this PR):** `server/src/training-agent/state.ts:310` still falls back to `args.brand?.domain` when `account` is absent. With `additionalProperties: false` now enforced at the gateway, this fallback is unreachable on spec-compliant paths and can be removed in a separate training-agent-only cleanup.
