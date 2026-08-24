# Legacy and compact media-buy lifecycle compatibility

## Status and scope

AdCP 3.2 introduces compact lifecycle tasks while retaining `get_products`,
`create_media_buy`, and `update_media_buy` throughout the AdCP 3.x
compatibility window. This document defines when an SDK or server projection
may translate between those surfaces, when it must expose an explicit loss, and
when it must fail before mutation.

The compatibility contract is temporary. The products-only bridge and every
legacy continuation defined here are deprecated in 3.2 and removed in AdCP 4.0
together with the superseded lifecycle facades.

The central rule is:

> A projection may reshape facts supplied by the seller. It MUST NOT invent a
> proposal, commercial term, terms digest, feed version, pricing version,
> inventory hold, atomic boundary, or idempotency guarantee.

`legacy_fallback.mode: "orchestrated"` means that a handwritten adapter may be
available. It does not assert that every valid request or response is
representable.

## Compatibility classifications

Every attempted projection has one of three outcomes:

- **Lossless**: all input intent, result completeness, lifecycle state,
  transaction boundaries, and retry semantics are preserved.
- **Explicitly lossy**: the caller has named the exact compatibility losses it
  accepts before any mutation. Losses MUST NOT be inferred from use of an SDK,
  a version pin, or receipt of a compatibility response.
- **Unsupported**: the coordinator returns a typed capability or pre-mutation
  error without sending a legacy mutation.

Read projections may return usable partial data only when the compact result
has an equally explicit completeness signal. A coordinator MUST NOT turn an
incomplete legacy result into an apparently complete compact success.

## Version matrix

| Operation or behavior | 2.5 | 3.0 | 3.1 | 3.2 native |
|---|---|---|---|---|
| Published product listing | No wholesale or pagination contract; not losslessly projectable | Wholesale and pagination exist, but no seller-issued feed or pricing fence | Lossless for the common representable field subset when a real wholesale feed version and cache scope are returned | `list_products` |
| Exact product-ID lookup | No exhaustive-feed guarantee | Coordinator may exhaust pages, but cannot claim a snapshot fence | Coordinator may exhaust pages under one feed version and MUST abort if the version changes | `criteria.product_ids` |
| Brief with proposals | Products only; proposals do not exist | Proposals are optional | Proposals are optional | `request_proposals` requires proposals on native success |
| Brief with products and no proposals | Valid | Valid | Valid | Compatibility `products_available`; never native seller output |
| Partial discovery | Errors only; no typed completeness contract | `incomplete[]` | `incomplete[]` | `list_products.incomplete[]`; proposal compatibility rules below |
| Proposal revision | Not available | Free-text and product/proposal verbs | Free-text and product/proposal verbs, plus stronger finalize rules | Typed immutable `refine_proposals` |
| Atomic multi-finalize | Not available | Not guaranteed | Defined, subject to seller support | Required for a finalize batch |
| Terminal proposal decline | Not available | Not available | Not available | `decline_proposals`; no legacy fallback |
| Required mutation idempotency | Not available | Not guaranteed on `get_products` | Not guaranteed on `get_products` | Required on compact mutations |

Even in a cell marked lossless, the adapter MUST preflight the individual
request. For example, released 3.1 `get_products` has no exact equivalents for
every 3.2 `product-discovery-criteria` field. Unsupported structured criteria
MUST be rejected by JSON Pointer before calling the legacy peer; they MUST NOT
be dropped into prose.

## Products-only brief compatibility

### Projection-only outcome

When a 2.5, 3.0, or 3.1 `get_products` brief completes with usable `products[]`
and no `proposals[]`, a compact compatibility coordinator returns the
projection-only `products_available` outcome. This outcome:

- preserves the returned products and compatible diagnostics;
- does not contain a proposal, `commercial_terms`, or `terms_digest`;
- is emitted only by a compatibility projection, never by a native 3.2 seller
  implementing `request_proposals`;
- contains one actionable, discriminated continuation; and
- is removed in AdCP 4.0.

Native `request_proposals` success continues to mean that at least one genuine
seller-authored proposal was returned.

### Continuations

The continuation is one of `listed_purchase` or `legacy_create`.
The compatibility coordinator exposes the following shape (transport bindings
may add their normal envelope fields but MUST preserve the discriminator and
seller-issued values):

```json
{
  "outcome": "products_available",
  "products": [
    { "product_id": "seller-product-1", "name": "Premium video" }
  ],
  "purchase_continuation": {
    "kind": "listed_purchase",
    "product_ids": ["seller-product-1"],
    "feed_version": "seller-issued-account-feed-token",
    "pricing_version": "seller-issued-account-price-token",
    "cache_scope": "account"
  }
}
```

or:

```json
{
  "outcome": "products_available",
  "products": [
    { "product_id": "seller-product-1", "name": "Premium video" }
  ],
  "purchase_continuation": {
    "kind": "legacy_create",
    "continuation_token": "8cfd5042-8bd7-4d40-90b4-26f21e13c821",
    "continuation_expires_at": "2027-01-01T00:05:00Z",
    "product_ids": ["seller-product-1"],
    "source_adcp_version": "3.0",
    "losses": [
      "feed_version_not_atomic",
      "pricing_version_not_atomic"
    ],
    "requires_explicit_acceptance": true
  }
}
```

The `legacy_create` continuation remains non-mutating until a subsequent
SDK-local `continueLegacyPurchase` coordinator call accepts every value in its
returned loss set. Its input is the generated
`CompatibilityPurchaseCoordinatorInput` type from
`media-buy/legacy-purchase-continuation-input.json`: a coordinator
`idempotency_key`, the `continuation_token`, the bound `account`, a non-empty
`selected_product_ids` subset, the exact `accepted_losses`, and the proposed
version-specific `legacy_create_request`. This is not an AdCP wire tool and the
input object MUST NOT be sent to the seller. Merely receiving the outcome is
not consent.

Before mutation, the coordinator resolves the token under the authenticated
principal; verifies its account, expiry, source version, and complete observed
product/pricing payload; requires the selected IDs to equal the distinct
explicit-package product IDs in `legacy_create_request`; validates that request
against the exact source-version `create_media_buy` schema; requires its
normalized account identity to equal both the input and token-bound account
when that source version carries an account field; and compares the accepted
loss set for exact equality. AdCP 2.5 has no wire account field, so its adapter
MUST retain the same token-bound client/account session and MUST NOT retarget
the seller connection. The coordinator then atomically claims the token and
sends only the validated `legacy_create_request`. Exact idempotency retries
resume the durable operation record. Expired, rebound, substituted,
under-consented, over-consented, or already-claimed continuations fail before
the seller call with a typed SDK compatibility error. A crash-ambiguous legacy
mutation is reconciled authoritatively or surfaced as unsupported; it is never
blindly repeated.

#### `listed_purchase`

The coordinator may offer `listed_purchase` only after it has:

1. re-read the selected products from a real seller-issued, account-scoped
   wholesale feed;
2. verified that every selected product and pricing option is present in that
   same selection;
3. obtained the seller-issued `feed_version` and, when the seller separates
   pricing state, `pricing_version`; and
4. preserved the cache scope and account identity through the purchase.

The coordinator passes those seller-issued values to ordinary `buy_products`.
It MUST NOT promote a brief-composed product into a feed unless the seller
actually supports that operation, and MUST NOT mint a replacement token when a
re-list fails.

Although a public feed may help discover a product, the compatibility
continuation requires an account-scoped fence before mutation. A coordinator
MUST NOT silently treat a public price as the caller's account price.

#### `legacy_create`

If a truthful re-list and fence are unavailable, the only actionable
compatibility continuation is `legacy_create`. It routes the selected products
through the established `create_media_buy` explicit-package path and always
declares these named losses:

- `feed_version_not_atomic`
- `pricing_version_not_atomic`

For an AdCP 2.5 source, it also declares
`mutation_idempotency_not_guaranteed`, because 2.5 has no mutation replay
contract. A 3.0 or 3.1 coordinator also declares that loss when the actual peer
does not provide the version's mutation replay guarantee. If the coordinator
cannot establish the source version or reconcile the response-level loss with
the follow-up mutation contract, it MUST NOT offer the continuation.

These loss names mean that the projection can bind the buyer's selection to the
exact compatibility response it observed, but the legacy seller cannot
atomically compare that observation with its current offer and pricing state at
mutation time. They do not authorize the coordinator to populate compact
`feed_version` or `pricing_version` fields.

The coordinator MUST fail closed unless the caller explicitly opts in to every
returned loss before the first mutation. Consent is scoped to that logical operation;
it is not durable permission for later buys or other sellers. A compatibility
token, when used, MUST be opaque, principal- and account-bound, short-lived,
and bound to the complete selected product and pricing payload. It is a replay
and substitution guard, not a seller-issued feed fence.

The legacy seller remains authoritative at create time. Product expiry, price
movement, or lost availability may therefore reject the create. The
coordinator MUST surface that rejection and MUST NOT retry with changed terms.

### Established buyers against a compact-backed seller

A 3.2 seller that advertises the deprecated `get_products` and
`create_media_buy` facades to established buyers MUST preserve their shared
products-only transaction context. When its `get_products` brief facade returns
products without proposals, those exact product and pricing identities remain
eligible inputs to its `create_media_buy` explicit-package facade for the
documented compatibility lifetime, subject to ordinary create-time
revalidation. The seller MUST NOT require that established buyer to call
`request_proposals`, redeem an SDK-local continuation token, or supply a compact
feed fence that the established request schema cannot express.

If the seller implements the legacy facade over compact internals, it uses a
private atomic coordinator or rejects before exposing the products-only result;
it MUST NOT commit `buy_products` and then attempt creative or execution work as
a compensating saga. The `products_available` outcome is only for the opposite
direction—a compact SDK coordinating an established peer—and MUST NOT leak onto
the native or established seller wire surfaces.

### Partial products-only results

When the legacy response includes `incomplete[]`, `products_available`
preserves every compatible entry. In particular:

- `scope: "proposals"` explains why no proposal was produced; it is not a
  business rejection and must not cause products to be discarded;
- `products`, `pricing`, and `forecast` scopes continue to qualify the returned
  products; and
- `estimated_wait` is advisory. Retrying is a new logical request unless it is
  an exact transport retry of the original operation.

A result with incomplete or unconfirmed pricing MUST NOT offer
`listed_purchase`. It may offer `legacy_create` only with the two required
atomic-fence losses, the 2.5 mutation-idempotency loss when applicable, and any
additional implementation-specific preflight required by the legacy seller.

## Product listing projection

`list_products` may project to 3.1 `get_products` wholesale when every requested
criterion has an exact legacy representation. The mapping is:

- `wholesale_feed_version` to `feed_version`;
- legacy `pricing_version` to compact `pricing_version`;
- the same `cache_scope` without widening account scope; and
- legacy pagination cursor to compact `next_cursor`.

For exact product IDs, the coordinator walks pages until every requested ID is
found or the feed is exhausted. All pages MUST belong to the same selection and
feed version. A changed or missing version invalidates the walk; combining rows
from different versions would fabricate a snapshot.

3.0 has pagination but no seller-issued feed/pricing fence. 2.5 has neither a
wholesale nor exhaustive pagination contract. A coordinator MUST NOT represent
either as an ordinary fenced `list_products` result. It may expose a separately
named read-only compatibility view, but that view is not actionable through
`buy_products` without the products-only continuation rules above.

## Proposal projection

### Initial proposals

A legacy proposal may be projected as a compact proposal only if the
coordinator can source every required canonical commercial term from seller
output and request state. A valid 3.0 or 3.1 proposal can omit its pricing
option and flight and can express only allocation percentages. Such a proposal
is useful on the legacy surface but is not enough to construct canonical
`commercial_terms`.

The coordinator MUST NOT:

- choose a pricing option the seller did not choose;
- turn budget guidance into a fixed total budget;
- infer resolved dates from prose;
- label a legacy ready-to-buy proposal as a held compact proposal;
- compute a `terms_digest` over synthesized terms; or
- claim immutable identity when the legacy source ID can change in place.

If products remain useful but proposals cannot be projected honestly, the
result is `products_available`. Otherwise the coordinator returns a typed
unsupported result.

### Identity and finalization

Every compact revision or finalization result has a new immutable
`proposal_id`, while its source remains unchanged. An adapter for a legacy
seller therefore maintains a durable mapping from every compact successor ID
to the legacy source ID and the exact canonical snapshot bytes. The rule
applies to revisions as well as finalization.

Single-proposal finalization may project only when the legacy seller actually
creates a committed hold without changing complete terms. A compact committed
successor needs a truthful hold deadline. Missing hold semantics or incomplete
terms make the operation unsupported.

A multi-finalize request is allowed only when the legacy peer guarantees the
same all-or-none observation boundary. Sequential single finalizes are not an
atomic substitute. On a peer that cannot guarantee the batch, the coordinator
fails before the first finalize call.

### Refinement mapping

Simple free-text asks and product `include`/`omit` changes may be projected when
the result can be reconstructed as a complete immutable successor. The
following require an exact field-specific adapter or a pre-mutation unsupported
result:

- total-budget, CPM, impression, and flight constraints;
- requested alternative counts and distinct-term guarantees;
- whole-field structured criteria replacement;
- amendment and cancellation proposals; and
- any typed product change without a legacy equivalent.

Legacy `more_like_this` has no typed compact equivalent. Mapping it into `ask`
is explicitly lossy. Conversely, legacy proposal `omit` only removes a proposal
from a refinement response. It MUST NOT be translated to terminal
`decline_proposals`. There is no legacy fallback for decline.

### Incomplete proposal work

Legacy `incomplete[]` is a completeness statement, not a rejection or retry
classification. A coordinator may return complete canonical proposals that
were actually produced while preserving the incomplete scopes. It MUST NOT
label them as an unqualified complete proposal set. If no complete proposal is
available but products are usable, it returns `products_available`.

## Time budgets, pagination, and asynchronous work

3.0 and 3.1 `get_products` allow a `time_budget` on brief and refine requests.
The budget tells a seller not to begin work that cannot finish in time; an
outer client timeout is not equivalent. Compact split tasks do not all carry
that input. A 3.2 server deriving the legacy facade from compact handlers MUST
propagate the deadline into its implementation or retain a dedicated legacy
handler. It MUST NOT accept the field, start unbounded work, and call that a
lossless projection.

Legacy brief/refine pagination limits `products[]`; proposals are plan metadata
and are not independently paginated. `request_proposals` itself is not a
proposal-page enumeration API. A server compatibility facade may page a stored
product set while repeating stable plan metadata, but it MUST NOT split one
proposal set into independently meaningful pages or combine proposal snapshots
from multiple attempts.

Async task IDs, webhook identities, and authorization remain scoped to the
actual tool invoked. A retry under a compact tool name is not a replay of an
earlier `get_products` task, or vice versa.

Every fallback also follows the normative [async identity and convergence
contract](../docs/building/by-layer/L3/async-identity-and-convergence.mdx).
Direct responses, polling, continuations, and webhooks are competing
observations of one operation; they do not create independent winners.

## Idempotency and recovery

Compact proposal creation, refinement, decline, direct purchase, and proposal
acceptance require idempotency keys. Released legacy `get_products` versions do
not provide the same required mutation replay contract, even though refinement
or finalization can have side effects.

An adapter uses a durable operation record and a deterministic replay identity
for each underlying call. Exact retries resume the recorded sequence. The
adapter MUST NOT repeat a completed step or mint a second successor. However,
local recording alone cannot resolve a crash after a legacy seller applied a
mutation but before the adapter persisted its response. Unless the adapter can
reconcile that state authoritatively, it MUST reject the fallback rather than
claim compact exactly-once behavior.

Idempotency keys, authorization grants, task IDs, and webhooks never transfer
across tool names. Every underlying legacy call must be separately authorized.

## Transaction-boundary matrix

The split lifecycle changes where validation commits. Compatibility is not
established merely because the same fields exist somewhere in the new model.

| Legacy transaction | Compact sequence | Boundary difference and required behavior |
|---|---|---|
| Brief discovery returns products and optional proposals together | `list_products` or `request_proposals` | Products-only must use the explicit compatibility outcome; partial and pagination semantics must survive |
| Proposal refine and finalize in `get_products` | `refine_proposals` revise, then finalize | Each compact step has a distinct immutable successor and replay identity; never collapse or fabricate a hold |
| `create_media_buy` with packages and inline creatives/assignments | `buy_products` or `accept_proposal`, then creative sync/assignment | Purchase can commit before creative validation fails. A compact-backed legacy facade MUST validate and commit this through a private atomic transaction or reject before purchase; a buy-then-sync saga is not a compatible implementation |
| `create_media_buy` with a proposal plus execution fields | finalize, `accept_proposal`, then operational/creative tasks | Legacy buyer-supplied budget, dates, or targeting must exactly match bound compact terms or be rejected; they cannot amend the proposal during acceptance |
| `update_media_buy` changes targeting and creative assignments atomically | proposal/control path plus creative assignment task | No shared transaction spans both tasks. When narrowing targeting would orphan an assignment, fail before the first mutation unless the seller has a private atomic coordinator |
| `update_media_buy` combines commercial and operational changes | refine, finalize, accept, then `control_media_buy` | Multiple commit and retry boundaries replace one legacy update. A compact-backed legacy facade MUST use a private atomic transaction or reject before refinement; it cannot expose this sequence as equivalent to one legacy update |
| `update_media_buy.invoice_recipient` reauthorizes a structured billing entity | no typed compact refinement field | Free-text `ask` cannot losslessly carry or authorize a `BusinessEntity`. A compact-backed legacy facade MUST use a private typed amendment or reject before mutation; it cannot advertise a lossless `refine_proposals` mapping |
| Legacy update shares one MediaBuy revision fence with package/creative changes | control and creative tasks use separate concurrency behavior | A creative assignment change must not be represented as protected by the MediaBuy revision unless the creative task actually advances and checks that revision |

For every orchestrated fallback, implementation and compliance review record:

1. request validation completed before the first side effect;
2. the mutation performed at each step;
3. possible partial-success state after each step;
4. revision and idempotency fence for each step;
5. async task and webhook identity;
6. retry and reconciliation behavior; and
7. whether the outcome is lossless, explicitly lossy, or unsupported.

If any required invariant has no truthful representation, the coordinator fails
before mutation. A later compensating action is operational recovery, not
atomic rollback, and MUST be reported as such.
