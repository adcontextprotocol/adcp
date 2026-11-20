# Seller adjustable terms

This document is the normative specification of the extension
`https://extensions.adcontextprotocol.org/seller-adjustable-terms`, version 1.6.0. The
extension digest covers this file: the manifest lists its sha256 under `docs.spec`.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

Each requirement is a rule with an ID, such as `SAT-R3`. Every rule names what enforces it:

- `kernel`: the buyer validator, from the extension point's must-understand policy.
- `schema`: the JSON Schema definition in this bundle.
- `x-adcp-validation`: a declarative verifier constraint in this bundle.
- `check()`: the reference code in `index.mjs`, which is not normative.
- `conformance only`: no code in the buyer SDK enforces the rule; only the conformance
  storyboards test it.

The storyboards in `conformance/` cite the rule IDs they test.

## Overview

The buyer pre-authorizes the seller to change named fields of a purchase without an offer,
within bounds: for example, "video 1 may go live up to 7 days later, with 48 hours notice".
A change inside an allowance creates a media buy revision. Any other change needs a seller
offer, which the buyer approves in the core offer lane. This extension ports
`seller-adjustable-term.json` and `applied-seller-adjustment.json` from adcp#8102, and makes
the constraint a tagged union on `kind`.

The extension attaches at two extension points:

| Extension point | Definition | Must understand | Role |
|---|---|---|---|
| `commercial_terms` | `SellerAdjustableTerms` | Required (policy `always`) | Binding allowances under `terms_digest` |
| `media_buy_state` | `AppliedAdjustments` | Optional (policy `never`) | Readback of the changes the seller applied |

## Rules

### Negotiation

#### SAT-R1: A buyer without the extension rejects the allowances

A buyer that does not understand the exact uri@digest MUST NOT accept commercial terms that
carry this extension.

Enforced by: kernel (extension point `commercial_terms`, policy `always`).

#### SAT-R2: The seller sends the digest the buyer listed

A seller MUST NOT put allowances in a proposal for a buyer that did not list this uri@digest
in `understood_extensions`. When the buyer lists several digests of this uri, the seller
SHOULD use the highest version among them.

Enforced by: conformance only.

### Allowances in signed terms

#### SAT-R3: Allowance IDs are unique and in order

Within one `SellerAdjustableTerms` value, each `allowance_id` MUST be unique, and the
allowances MUST be in ascending `allowance_id` order, so equal terms serialize to equal
`terms_digest` values.

Enforced by: check(); x-adcp-validation `adjustable_term_bounds.unique_by`; x-adcp-validation `adjustable_term_bounds.canonical_order`.

#### SAT-R4: An allowance resolves in its purchase

An allowance's `purchase_index` MUST name an entry of `commercial_terms.purchases`, and its
`path` MUST resolve in that purchase when the buyer accepts the terms.

Enforced by: check(); x-adcp-validation `adjustable_term_bounds.purchase_index`; x-adcp-validation `adjustable_term_bounds.path`.

#### SAT-R5: One allowance per field

The terms MUST NOT carry two allowances for the same purchase and path.

Enforced by: check(); x-adcp-validation `adjustable_term_bounds.one_entry_per_purchase_index_and_path`.

#### SAT-R6: The constraint fits the field

An allowance on `/budget` or `/impressions` MUST use the `decrease` kind. An allowance on
`/start_time` or `/end_time` MUST use the `time_shift` kind and give `min_notice`. An
allowance on `/targeting_overlay` MUST use the `alternates` kind. No allowance targets a
price, so an allowance never raises what the buyer pays.

Enforced by: schema (`Allowance` path pattern and its `if`/`then` blocks).

#### SAT-R7: An unknown constraint kind fails closed

A buyer MUST reject an allowance whose `kind` this digest does not define. A later kind comes
in a later version with its own digest, which a buyer pinned to this digest never receives.

Enforced by: schema (`Constraint` is a closed `oneOf` on `kind`).

#### SAT-R8: An earlier start stays inside the flight

When an allowance lets `/start_time` move earlier, the seller SHOULD keep the flight inside
the `start_time` and `end_time` of the commercial terms. The buyer SDK reports a warning for
such an allowance.

Enforced by: check() (warning).

### Applied changes

#### SAT-R9: Readback uses the accepted uri@digest

A seller MUST write the `media_buy_state` entry with the same uri and digest as the accepted
`commercial_terms` entry. A buyer that finds two digests of this uri in one media buy MUST
fail closed.

Enforced by: kernel (one uri, one digest per message).

#### SAT-R10: A change names an accepted allowance

Each applied change MUST name an allowance in the accepted terms, and MUST change exactly
that allowance's purchase and path.

Enforced by: check(); x-adcp-validation `applied_within_allowance.allowance`.

#### SAT-R11: Bounds count from the accepted value

The seller MUST measure every bound from the value in the accepted terms, not from the
value of the previous revision. Two shifts of 5 and 4 days under a 7-day allowance move the
field 9 days, which is outside the allowance. A `time_shift` change MUST also respect the
allowance's `direction`.

Enforced by: check(); x-adcp-validation `applied_within_allowance.bounds_origin`.

#### SAT-R12: A decrease only decreases

A change under a `decrease` allowance MUST lower the value, MUST NOT go below `min`, and MUST
NOT lower the value by more than `max_change_fraction` of the accepted value in total.

Enforced by: check(); x-adcp-validation `applied_within_allowance.decrease`.

#### SAT-R13: An alternate is one of the agreed values

A change under an `alternates` allowance MUST set the field to one of the agreed alternate
values.

Enforced by: check(); x-adcp-validation `applied_within_allowance.alternates`.

#### SAT-R14: The seller gives the agreed notice

The seller MUST apply a change to `/start_time` or `/end_time` at least `min_notice` before
the value it replaces.

Enforced by: check(); x-adcp-validation `applied_within_allowance.notice`.

#### SAT-R15: Start and end move in one revision

When a purchase has allowances on both `/start_time` and `/end_time`, a seller that moves
one of them MUST move the other in the same media buy revision.

Enforced by: check(); x-adcp-validation `applied_within_allowance.time_shift_pair`.

#### SAT-R16: The seller announces each change on the core change feed

For each revision that applies changes, the seller MUST emit an `account.change_recorded`
record. Each change's `change_id` MUST name that record, the change's `revision` MUST equal
the record's `resource_revision`, and the record's `changed_paths` MUST list the changed
package field.

Enforced by: conformance only.

#### SAT-R17: A budget release never covers the seller's own shortfall

A seller MUST NOT use a `decrease` allowance on `/budget` or `/impressions` (a budget
release) to cover a shortfall it caused, such as a missed deliverable or under-delivery. It
remedies that shortfall with a make-good unit or an offer. The buyer SDK can't tell who
caused a shortfall, so it does not check this rule.

Enforced by: conformance only.

#### SAT-R18: A buyer without the extension keeps the media buy

A buyer that does not understand this extension MUST NOT reject a media buy because of its
`media_buy_state` entry. It ignores the entry; the core packages carry the live state.

Enforced by: kernel (extension point `media_buy_state`, policy `never`).
