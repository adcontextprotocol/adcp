---
id: DR-0036
title: A minor release adds only to open schemas; a closed schema stays closed until the next major
class: normative
status: proposed
date: 2026-10-27
decided_by: pending WG ratification
refs: ["#8501", "PR #8502", "#8518", "DR-0009", "DR-0019", "DR-0024", "DR-0034"]
supersedes: DR-0019  # in part: "adding an optional field to a closed schema is a minor change"
dissent: none recorded
---

## Decision

A schema is **closed** when it sets `additionalProperties: false` or
`unevaluatedProperties: false`. A validator rejects any property that a closed
schema doesn't list.

**A minor release adds only to open schemas.** A schema that any stable release
of a major published closed stays as that release published it until the next
major. No property is added to it or removed from it.

**Closedness counts for the whole major.** Opening a closed schema in a minor
breaks no validator, but it permits no additions within that major. Validators
of the release that closed it still reject a new property.

**No exceptions.** A field sent only to peers that negotiated the newer minor is
still an addition to the closed schema. So is an experimental field on a stable
closed schema. The rule doesn't cover a schema that was itself experimental in
the release that closed it, because that schema carries no stability promise.

**DR-0019's two classes stay the only reasons to close a schema.** A schema may
be closed only when it is a class A join-key object or a class B row envelope
with an escape hatch. Request roots, response roots, capability blocks, and
container objects stay open.

**New schemas default to open** (DR-0009). A PR that closes a new schema names
its DR-0019 class.

**This replaces part of DR-0019.** DR-0019's consequence "adding an optional
field to a closed schema is a `minor` change" no longer holds. Its consequence
that loosening a closed schema is non-breaking still holds, but loosening
permits no additions within the major. The rest of DR-0019 stands.

### One-time correction: the 3.2 proposal flow

The 3.2 proposal-flow tasks were published closed from the request and response
roots down. That contradicts DR-0019, which says roots and containers stay open.
No record explains the closure, and several of these schemas also lack the
`ext` slot that DR-0019 requires of a closed envelope. So 3.3.0 reopens the
following schemas as a correction of that defect. Additions to them are
allowed from 3.3.0.

| Schema | Pointer | Kind | Reason |
|---|---|---|---|
| `media-buy/list-products-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/request-proposals-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/refine-proposals-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/buy-products-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/accept-proposal-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/decline-proposals-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/control-media-buy-request.json` | root | request root | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/list-products-response.json` | root | response root | DR-0019 keeps response roots open. It also rejects the `adcp_version` echo (#8518). |
| `media-buy/request-proposals-response.json` | root | response root | DR-0019 keeps response roots open. |
| `media-buy/refine-proposals-response.json` | root | response root | DR-0019 keeps response roots open. |
| `media-buy/refine-proposals-response.json` | `/properties/results/items` | result row | One outcome per source proposal. It is neither a join key nor an envelope with `ext`. |
| `media-buy/decline-proposals-response.json` | root | response root | DR-0019 keeps response roots open. It also rejects the `adcp_version` echo (#8518). |
| `media-buy/media-buy-commitment-response.json` | `/oneOf/0`, `/oneOf/1`, `/oneOf/2` | response root branches | The `buy_products` and `accept_proposal` responses. `status` tells the branches apart, so closure does no work. `create_media_buy` keeps its branches open. |
| `media-buy/control-media-buy-response.json` | `/oneOf/0`, `/oneOf/1`, `/oneOf/2` | response root branches | Same as above. It also rejects the `adcp_version` echo (#8518). |
| `core/canonical-proposal.json` | root | container | Holds the terms, allocations, and narrative of a proposal. It has no `ext`. |
| `core/canonical-product.json` | root | container | The product resource. The `product` schema it parallels is open. |
| `media-buy/product-discovery-criteria.json` | root | container | Groups the discovery filters of three requests. |
| `media-buy/proposal-refinement.json` | root | request row | One refinement instruction. It has no `ext`. |
| `media-buy/package-control.json` | root | request row | One package's controls. It has no `ext`. |
| `core/opportunity-context.json` | root | container | Buyer context for a planning cycle. Its `opportunity_id` is opaque, not a join key. |

**Not reopened.** These schemas on the same flow stay closed:

- `media-buy/commercial-terms.json` and the schemas inside it, including
  `media-buy/product-purchase.json` and `core/canonical-performance-standard.json`.
  They are closed on purpose. A buyer must not be bound by terms it can't read,
  and `terms_digest` signs exactly these terms.
- `media-buy/product-purchase-input.json`, the `buy_products` purchase row. It
  shares the field shapes of `product-purchase`, and no 3.3 field needs it.
- `core/canonical-media-buy-action-fields.json`. Its description declares a
  closed field set for task-discriminated actions, which is DR-0019 class A.
- Schemas whose 3.3 additions moved to open homes under the #8501 triage:
  `core/targeting-overlay-requirements.json`, `core/daypart-target.json`,
  `core/sla-window.json`, and `core/spot-reporting-capability.json`.
- Closed value objects and keyed rows inside the reopened schemas, such as
  `total_budget`, `incomplete[]`, and `purchase_bindings[]`. No 3.3 field needs
  them, and they fit class A.

**3.3 fields on reopened schemas go only to 3.3 peers.** A response carries them
only when its served release is 3.3 or later (DR-0024). A request carries them
only when the negotiated release is 3.3 or later. A request that names only the
major is served the oldest supported release (DR-0034), so it never gets them.

## Rationale

A strict validator on an earlier release rejects any key its closed schema
doesn't list. So an addition breaks it exactly as a removal does. The fields
are optional, but that doesn't help: the validator rejects the payload before
any reader sees the field.

Negotiation doesn't contain the break in general. Objects are stored and read
back later, relayed to third agents such as a governance agent, and covered by
digests. So a field added for one peer can reach a peer that never negotiated
it.

The correction is narrow on purpose. The reopened schemas contradicted DR-0019's
own text, so reopening them restores the documented design rather than making an
exception. The decision accepts that sellers must shape these objects to the
served release, as DR-0024 already requires. `commercial-terms`, the object
that is digested and binds the buyer, stays closed.

Source: WG Session C on 2026-10-26 accepted the rule on #8501. The one-time
correction was agreed on #8501 after that session.

## Implications

- **The additive-minor check enforces this record.** It treats a schema as
  closed when any stable release of the major published it closed. It reports
  opening a closed schema as a notice. It reads the reopened schemas from
  `scripts/lint-additive-minor-reopened.json`, which holds exactly the table
  above. Only a decision record adds to that file.
- **Two earlier cases are recorded, not fixed.** 3.1.0 added `brand_json_url` to
  the capabilities `identity` block, closed in 3.0.0 to 3.0.4. It also replaced
  the closed 3.0 `geo_postal_areas` object with `core/postal-area-support.json`,
  which adds country keys. Both shipped, so they stay until 4.0.
- **3.3 additions to schemas that stay closed** move to open homes or wait for
  4.0, as the #8501 triage lists. Definition pins, purchase rights, and
  installment selection inside `purchases[]` wait for 4.0.
- **Not settled here:** whether a 3.2.x patch also reopens these schemas, and
  how `commercial-terms` grows in 4.0. A declared extension point with
  must-understand semantics is the expected direction.
