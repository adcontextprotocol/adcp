---
id: DR-0036
title: A minor release adds only to open schemas; a closed schema changes within a major only by a recorded correction
class: normative
status: proposed
date: 2026-10-27
decided_by: pending WG ratification
refs: ["#8501", "PR #8502", "#8518", "PR #8523", "PR #8524", "DR-0009", "DR-0019", "DR-0024", "DR-0034"]
supersedes: DR-0019  # in part: "adding an optional field to a closed schema is a minor change"
dissent: none recorded
---

## Decision

A schema is **closed** when it sets `additionalProperties: false` or
`unevaluatedProperties: false`. A validator rejects any property that a closed
schema doesn't list.

**A minor release adds only to open schemas.** A schema that any stable release
of a major published closed stays as that release published it until the next
major. No property is added to it or removed from it. Only a recorded
correction, described below, may change it.

**Closedness counts for the whole major.** Opening a closed schema in a minor
breaks no validator, but it permits no additions within that major. Validators
of the release that closed it still reject a new property.

**No exceptions for negotiation or experimental status.** A field sent only to
peers that negotiated the newer minor is still an addition to the closed
schema. So is an experimental field on a stable closed schema.

**Scope.** The rule covers stable schemas. A schema that was experimental in the
release that closed it carries no stability promise. The versioning page says so
for experimental surfaces, so the rule doesn't freeze it.

**DR-0019's two classes stay the only reasons to close a schema.** A schema may
be closed only when it is a class A join-key object or a class B row envelope
with an escape hatch. Request roots, response roots, capability blocks, and
container objects stay open.

**New schemas default to open** (DR-0009). A PR that closes a new schema names
its DR-0019 class.

**This replaces part of DR-0019.** DR-0019's consequence "adding an optional
field to a closed schema is a `minor` change" no longer holds. Its consequence
that loosening a closed schema is non-breaking still holds. But loosening
permits no additions within the major unless this record lists it as a
correction. The rest of DR-0019 stands.

### Corrections

**A minor or patch release may change a closed schema only to make it accept
what the published spec text already required before that release.** That
change is a correction. Each correction names the text that required it.

A correction doesn't weaken the rule. The schema contradicted the spec's own
text, and the correction brings it back in line. A correction that
reopens a schema makes it open from the correction's release. From then on, a
minor may add to it as to any open schema.

Each correction is recorded in this section, with its source text and every
location it changes. The additive-minor check reads the same locations from
`scripts/lint-additive-minor-corrections.json`. It accepts exactly the listed
additions, and it fails on an entry that this section doesn't list. So a new
correction needs a change to this record.

Two corrections are recorded:

| Correction | Source text | Ships in | Check entries |
|---|---|---|---|
| (a) Reopen the 3.2 proposal flow | DR-0019 | 3.3.0, and a 3.2.x patch | The table under (a) |
| (b) Declare the `adcp_version` echo on closed task responses | `docs/reference/versioning.mdx` | 3.3.0 (#8523), and a 3.2.x patch (#8524) | Added by #8523/#8524 |

#### (a) Reopen the 3.2 proposal flow

The 3.2 proposal-flow tasks were published closed from the request and response
roots down. That contradicts DR-0019, which says roots and containers stay open.
No record explains the closure. Several of these schemas also lack the `ext`
slot that DR-0019 requires of a closed envelope. So 3.3.0 reopens the following
schemas, and a 3.2.x patch reopens them too. The patch adds no fields.

Each row's source text is one of three sentences of DR-0019:

- **Roots and containers:** "Response roots, capability blocks, and container
  objects stay open"
- **Neither class:** "Schemas that do not fit either class must be opened."
- **No escape hatch:** "A Class B schema without an escape hatch is a defect."

| Schema | Pointer | Property | Kind | Required by | Reason |
|---|---|---|---|---|---|
| `media-buy/list-products-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/request-proposals-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/refine-proposals-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/buy-products-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/accept-proposal-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/decline-proposals-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/control-media-buy-request.json` | root | `*` | request root | Neither class | A task root is not a row, so neither DR-0019 class applies. |
| `media-buy/list-products-response.json` | root | `*` | response root | Roots and containers | DR-0019 keeps response roots open. It also rejects the `adcp_version` echo (#8518). |
| `media-buy/request-proposals-response.json` | root | `*` | response root | Roots and containers | DR-0019 keeps response roots open. |
| `media-buy/refine-proposals-response.json` | root | `*` | response root | Roots and containers | DR-0019 keeps response roots open. |
| `media-buy/refine-proposals-response.json` | `/properties/results/items` | `*` | result row | No escape hatch | One outcome per source proposal, carrying the returned proposals. It is not a join-key object, and it has no `ext`. |
| `media-buy/decline-proposals-response.json` | root | `*` | response root | Roots and containers | DR-0019 keeps response roots open. It also rejects the `adcp_version` echo (#8518). |
| `media-buy/media-buy-commitment-response.json` | `/oneOf/0`, `/oneOf/1`, `/oneOf/2` | `*` | response root branches | Roots and containers | The `buy_products` and `accept_proposal` responses. `status` tells the branches apart, so closure does no work. `create_media_buy` keeps its branches open. |
| `media-buy/control-media-buy-response.json` | `/oneOf/0`, `/oneOf/1`, `/oneOf/2` | `*` | response root branches | Roots and containers | Same as above. It also rejects the `adcp_version` echo (#8518). |
| `core/canonical-proposal.json` | root | `*` | container | Roots and containers | Holds a proposal's commercial terms, lineage, status, and narrative. It has no `ext`. |
| `core/canonical-product.json` | root | `*` | resource | Neither class | The product resource, not a row. The `product` schema it parallels is open. |
| `media-buy/product-discovery-criteria.json` | root | `*` | container | Roots and containers | A container for the discovery filters of three requests. |
| `media-buy/proposal-refinement.json` | root | `*` | request row | No escape hatch | One refinement instruction. It is not a join-key object, and it has no `ext`. |
| `media-buy/package-control.json` | root | `*` | request row | No escape hatch | One package's controls. It is not a join-key object, and it has no `ext`. |
| `core/opportunity-context.json` | root | `*` | container | Roots and containers | Buyer context for a planning cycle. Its `opportunity_id` is opaque, not a join key. It has no `ext`. |

The response branches are discriminated `oneOf` arms, which DR-0019 lists under
class A. Each branch is a whole task response, so DR-0019's rule that response
roots stay open wins over the arm class.

**Not reopened.** These schemas on the same flow stay closed:

- `media-buy/commercial-terms.json` and the schemas inside it, including
  `media-buy/product-purchase.json` and `core/canonical-performance-standard.json`.
  They are closed on purpose. A buyer must not be bound by terms it can't read,
  and `terms_digest` signs exactly these terms.
- `media-buy/product-purchase-input.json`, the `buy_products` purchase row. It
  shares the field shapes of `product-purchase`, and no 3.3 field needs it.
- `core/canonical-media-buy-action-fields.json`. Its description declares a
  closed field set for task-discriminated actions, which is DR-0019 class A.
- Schemas whose 3.3 additions move to open homes under the #8501 triage:
  `core/targeting-overlay-requirements.json`, `core/daypart-target.json`,
  `core/sla-window.json`, and `core/spot-reporting-capability.json`.
- Closed value objects and keyed rows inside the reopened schemas, such as
  `total_budget`, `incomplete[]`, and `purchase_bindings[]`. No 3.3 field needs
  them, and they fit class A.

**3.3 fields on reopened schemas go only to 3.3 peers.** A response carries them
only when its served release is 3.3 or later (DR-0024). A request carries them
only when the negotiated release is 3.3 or later. A request that names only the
major is served the oldest supported release (DR-0034), so it never gets them.

#### (b) Declare the `adcp_version` echo on closed task responses

`docs/reference/versioning.mdx` requires the echo on every response:
"`adcp_version` on every response tells the buyer which release the seller
actually served." The same page requires each response to validate against the
served release's schema. Several closed task responses rejected the key, so a
conforming seller could not meet both rules (#8518).

This correction declares `adcp_version` on those responses. #8523 implements it
for 3.3, and #8524 for a 3.2.x patch. This record doesn't implement it. Its
check entries, with property `adcp_version`, and their rows in this section are
added by #8523/#8524.

## Rationale

A strict validator on an earlier release rejects any key its closed schema
doesn't list. So an addition breaks it exactly as a removal does. The fields
are optional, but that doesn't help: the validator rejects the payload before
any reader sees the field.

Negotiation doesn't contain the break in general. Objects are stored and read
back later, relayed to third agents such as a governance agent, and covered by
digests. So a field added for one peer can reach a peer that never negotiated
it.

A correction is safe in a minor or a patch. It accepts only what the spec text
already required, so no conforming peer sends anything the corrected schema
rejects. Only a validator that diverged from the text sees a change. The
versioning page lists "validation that was diverging from the documented stable
spec" among the changes a patch may make.

The corrections are narrow on purpose. Each one restores what the spec text
already said, so neither weakens the rule. The decision accepts that
sellers must shape the reopened objects to the served release, as DR-0024
already requires. `commercial-terms`, the object that is digested and binds the
buyer, stays closed.

Source: WG Session C on 2026-10-26 accepted the rule on #8501. The correction
rule and both corrections were agreed on #8501 after that session.

## Implications

- **The additive-minor check enforces this record.** It treats a schema as
  closed when any stable release of the major published it closed. It reports
  opening a closed schema as a notice. It reads the corrections from
  `scripts/lint-additive-minor-corrections.json`. Each entry names the schema,
  the JSON pointer, and the property, where `*` reopens the whole schema. It
  also names the release it lands in and the source text, as a path and a
  quote. The check verifies that the quote is in that file.
- **Two earlier cases are recorded, not fixed.** 3.1.0 added `brand_json_url` to
  the capabilities `identity` block, closed in 3.0.0 to 3.0.4. It also replaced
  the closed 3.0 `geo_postal_areas` object with `core/postal-area-support.json`,
  which adds country keys. Both shipped, so they stay until 4.0.
- **No new postal-area country in 3.x.** `core/postal-area-support.json` counts
  as closed since 3.0, because 3.0 closed the object it replaced. So no 3.x
  release can add a country key to it. A new country waits for 4.0.
- **3.3 additions to schemas that stay closed** move to open homes or wait for
  4.0, as the #8501 triage lists. Three features wait for 4.0:
  - **Definition pins:** `definition_pins` on `commercial-terms`,
    `drifted_pins` on the `refine_proposals` result row, and the
    `definition_changed` refinement reason.
  - **Purchase rights:** `rights` on `product-purchase`.
  - **Installment selection:** `installments` on `product-purchase`,
    `installment_changes` on `proposal-refinement`, and
    `unsatisfied_installment_changes` on the `refine_proposals` result row.
    The two refinement fields are validated against
    `commercial_terms.purchases[].installments`, so they wait with it. The
    installment fields on products stay in 3.3.
- **This corrects the #8501 comment that settled the approach**
  (issuecomment-6436451238). That comment said the installment parts on
  refinement stay in 3.3. They wait for 4.0 with installment selection.
- **The removal must name what the check can't see.** `drifted_pins`,
  `installment_changes`, and `unsatisfied_installment_changes` sit on reopened
  schemas, and `definition_changed` is an enum value. The check flags none of
  them, so the PR that removes the 4.0 features lists them by name.
- **Not settled here:** how `commercial-terms` grows in 4.0. A declared
  extension point with must-understand semantics is the expected direction.
