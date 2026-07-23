# RFC: SDK surface for contributing facts to the registry

**Status**: Draft (RFC)

## Summary

The server already exposes the full "send us facts" surface — `POST /api/registry/resolve` (identifiers + provenance → `property_rid`s), `POST /api/registry/catalog/disputes`, and the bind-on-verify `claim` / `verify-origin` endpoints (#5752). But `@adcp/sdk`'s `RegistryClient` surfaces only `saveProperty`; the primary fact-contribution path is unreachable from the SDK. This RFC defines the client surface — the same shape in `@adcp/client` (TS) and `adcp` (Python) — so participants can contribute facts as a natural part of their own workflow.

It is the client-side counterpart to [`property-catalog-graduation.md`](./property-catalog-graduation.md): that RFC graduates the fact model; this one is how callers feed it.

## The insight: resolving *is* contributing

`POST /api/registry/resolve` takes identifiers + a `provenance` block and returns stable `property_rid`s, auto-creating missing entries (`mode: 'resolve'`). A buyer agent resolving its 500-domain campaign list to get `property_rid`s for targeting — which it must do anyway — is *simultaneously* asserting "these identifiers exist and are demanded, sourced from `agency_allowlist`." **Contribution is a byproduct of the caller's own resolve, not a separate chore**, and `provenance` is the trust/audit envelope that makes the claim weightable. The demand signal (who resolved what, how) is itself a fact.

The footgun this creates: the write path *looks* like a lookup. The SDK closes it by (a) naming the method for what it does — `reportIdentifiers()`, not `resolve()` — and (b) making `mode` a **required** argument, so the write is never implicit.

## Proposed client surface

Six methods, kept **flat** on `RegistryClient` (the class is already ~60 flat methods; a nested `registry.facts.*` accessor doesn't mirror idiomatically into Python). The trust boundary — *community claims* vs *origin-rooted authority* — is named in the method names and docs, not the object graph. Only `saveProperty` exists today.

### Community claims (weighted, non-authoritative)

**`reportIdentifiers()`** — the primary fact funnel. Wraps `POST /api/registry/resolve`. (`resolve()` may exist as a documented alias for endpoint symmetry.)

```ts
const { resolved, summary, server_timestamp } = await registry.reportIdentifiers({
  identifiers: [
    { type: 'domain', value: 'nytimes.com' },
    { type: 'ios_bundle', value: 'com.nytimes.nytimes' },
  ],
  mode: 'resolve',                                    // REQUIRED — 'resolve' writes+creates | 'lookup' is a pure read
  provenance: { type: 'agency_allowlist', context: 'unilever_q3' },  // REQUIRED when mode:'resolve'
});
// resolved[i]: { identifier, property_rid | null, classification, status, source }
//   status ∈ existing | created | excluded ; property_rid is null for excluded (ad_infra / publisher_mask)
// summary: { total, resolved, created, excluded, not_found }   // not_found populated on lookup
```

- **`mode` is required** in the SDK (the server defaults it to `resolve`, but the SDK must not let a lookup-looking call write silently). `lookup` = pure read (no auth, no write, no activity log). `resolve` = contribute + create + return rids (auth required).
- **`provenance` is required only when `mode: 'resolve'`** (a discriminated union on `mode`) — `lookup` writes nothing and logs no provenance, so requiring it there is dead weight. User-facing `provenance.type`: `agency_allowlist`, `publisher_declaration`, `impression_log`, `ssp_inventory`, `deal_history`, `data_partner`, `member_assertion`. (`crawl` is server-internal, not offered to callers.)
- **Batch cap: a flat 10,000 identifiers for all callers** (there is no per-tier limit today). The SDK MUST reject an oversized batch locally.
- **`property_rid` is a stable catalog handle for joining / dedup / TMP-match — NOT an authorization credential.** State this in the return type; it mirrors the identity-not-authorization lesson from #5750.
- **Re-resolve is idempotent on the graph, additive on the activity log.** The same identifier always maps to the same `property_rid` (`status: 'existing'`); each `resolve` call logs a fresh demand-activity row. Callers polling on a schedule are (intentionally) inflating demand signal — document it.

**`disputeFact()`** — challenge or correct a claim (auth required). Wraps `POST /api/registry/catalog/disputes`; the community side of the alignment model's disavow/challenge verb.

```ts
const { dispute_id, action_taken, reason } = await registry.disputeFact({
  dispute_type: 'identifier_link' | 'classification' | 'property_data' | 'false_merge',
  subject_type: 'identifier' | 'property_rid',
  subject_value: 'com.example.app',
  claim: 'This bundle belongs to a different publisher',   // 10–2000 chars
  evidence: 'https://…',                                    // optional, ≤5000 chars
});
// action_taken ∈ 'link_suspended' | 'queued_for_review' | 'escalated'  — the actual outcome
// poll status via getDispute(dispute_id) → GET /api/registry/catalog/disputes/:id
```

### Consume (read side of the same loop)

**`browseCatalog(filters)`** (`GET /api/registry/catalog`) → `{ entries, total, next_cursor }` — opaque **cursor** pagination.
**`syncCatalog(since)`** (`GET /api/registry/catalog/sync`) → delta since a `server_timestamp`, capped at 10,000/page; returns only `classification: 'property'`, `status: 'active'` rows (not a firehose). These are **two distinct pagination mechanisms** (opaque cursor vs timestamp watermark) — document them separately so callers don't conflate them.

### Origin-rooted authority

**`claimDomain()` + `verifyOrigin()`** — bind-on-verify ownership (#5752). How community claims about a domain become origin-attested authoritative facts.

```ts
const { authoritative_location, instructions } = await registry.claimDomain('examplepub.com');
// caller places `authoritative_location` at their origin /.well-known/adagents.json, then:
const { verified, reason, bound_org_id } = await registry.verifyOrigin('examplepub.com');
// reason (union): success → 'authoritative_location_pointer';
//   failure → not_found | invalid_json | no_authoritative_location |
//             authoritative_location_mismatch | unresolvable | transient
//   'transient' is retryable; all other failures are permanent (fix the origin file).
// bound_org_id?: string — present ONLY to the org whose claim matched; a third-party
//   trigger gets verified:true with bound_org_id undefined.
```

**`saveProperty()`** — identity contribute-back (exists; identity-only, authorization stripped per #5750).

## Design principles

- **Provenance-first, structurally enforced** on the write path — the SDK is where "facts carry their source" is guaranteed, so no bare assertion reaches the catalog.
- **The write is never implicit** — `mode` required, and the method is named `reportIdentifiers`, not `resolve`. A lookup-looking call cannot silently create catalog rows and demand signal.
- **Name the trust boundary, keep the surface flat.** Community-claim methods (`reportIdentifiers`, `disputeFact`) vs origin-authority (`claimDomain` / `verifyOrigin`, and `saveProperty` after origin-verify) are distinguished by name + doc sections, not a sub-client — so TS and Python stay trivially parity-able.
- **Consume + contribute read as one loop:** report your identifiers → get `property_rid`s → `syncCatalog` locally → build lists.
- **Spec once, ship identically in TS and Python**, bound by a shared conformance vector. Given the resolver divergence in adcontextprotocol/adcp-client#2301, the vector MUST assert the full wire shape (`summary.not_found`, dispute `action_taken`, the `verifyOrigin` `reason` union) — author it only after this RFC's shapes are final, or it will freeze the same drift into both SDKs.
- **Caller-first docs** — a quickstart framed as the buyer's own job, with contribution as the natural side effect.

## Error contract (normative for both SDKs)

- **401** — `reportIdentifiers(mode:'resolve')`, `disputeFact`, `claimDomain`, `verifyOrigin`, `saveProperty` all require authentication. `mode:'lookup'` does not.
- **403** — `claimDomain` additionally requires organization membership (`resolveCallerOrgId`); surface as a distinct "join an org" error, not a generic auth failure.
- **400 (pre-empt locally)** — batch > 10,000; missing/unknown `provenance.type`; `claim` outside 10–2000 chars. The SDK should validate these before the request.
- **429** — the `claim` / `verify-origin` / `save` family sits behind a creation rate-limiter and can return 429 → typed rate-limit error with retry guidance. **`/resolve` has no rate-limiter today** and does not emit 429; do not implement a 429/tiering contract against it.
- **`verifyOrigin` `reason: 'transient'`** is the retryable case; all other failure reasons are permanent (the caller must fix their origin file).

## What's built vs. what this RFC adds

- **Server: done.** `/resolve`, `/catalog`, `/catalog/sync`, `/catalog/disputes` (+ `/:id`), `/properties/hosted/:domain/claim`, `/verify-origin`, `/properties/save` are all live.
- **SDKs: the work.** Add `reportIdentifiers` (+`resolve` alias), `disputeFact` (+`getDispute`), `browseCatalog`, `syncCatalog`, `claimDomain`, `verifyOrigin` to `RegistryClient` in `@adcp/client` (TS) and `adcp` (Python). Additive — no change to existing methods.

## Resolved / open questions

1. **Naming — resolved:** primary method is `reportIdentifiers()` ("report identifiers you have"; honest for both modes; carries the audit connotation). `resolve()` may remain a documented alias.
2. **Auto-contribution — resolved:** never implicit. `mode` is required and `provenance` is required in `resolve` mode; higher-level flows must pass them explicitly (provenance is never guessed).
3. **`property_rid` typing:** coordinate with the catalog-graduation RFC so it is a first-class, non-authoritative type in the SDK, never usable as an authorization key. Stated in the `reportIdentifiers` return type.

Related: [`property-catalog-graduation.md`](./property-catalog-graduation.md), [`property-definition-alignment.md`](./property-definition-alignment.md), `specs/registry-authorization-model.md`, #5750 / #5752 (authority spine), adcontextprotocol/adcp-client#2301 (resolver parity).
