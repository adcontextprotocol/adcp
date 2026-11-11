# Rate card index

This document is the normative specification of the extension
`https://extensions.adcontextprotocol.org/rate-card-index`, version 1.5.0. The extension
digest covers this file: the manifest lists its sha256 under `docs.spec`.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

Each requirement is a rule with an ID, such as `RC-R3`. Every rule names what enforces it:

- `kernel`: the buyer validator, from the extension point's must-understand policy.
- `schema`: the JSON Schema definition in this bundle.
- `x-adcp-validation`: a declarative verifier constraint in this bundle.
- `check()`: the reference code in `index.mjs`, which is not normative.
- `conformance only`: no code in the buyer SDK enforces the rule; only the conformance
  storyboards test it.

The storyboards in `conformance/` cite the rule IDs they test.

## Overview

A seller publishes its rate card so a buyer can evaluate prices locally while it plans. The
card is a base price, a chain of index rows, index-point rows, and premiums. This extension
ports `price_adjustments` from adcp#7955, with an object container, an open dimension
vocabulary, an explicit premium basis, seller-declared rounding, index-point rows, and
provisional rows (PR #7955 review).

The extension attaches at two extension points:

| Extension point | Definition | Must understand | Role |
|---|---|---|---|
| `pricing_option` | `RateCard` | Optional (policy `flag`) | A planning aid; the option's `fixed_price` binds |
| `commercial_terms` | `RateCardBinding` | Required (policy `always`) | The card signed for one purchase |

## Evaluation

A buyer computes the price per pricing unit for a selection in this order:

1. Start from `base_price`.
2. For each dimension, fire the first applicable `index` row in row order. Rows on the
   dimension `always` each fire. Multiply the running price by each fired row's factor.
3. Add `points / 100` from each fired `index_points` row to the factor of the fired index
   row on its `target_dimension`.
4. Add or subtract each fired premium, as a rate of `premium_basis` or as a fixed amount.
5. Round as `rounding` declares: after each row, or once at the end.

## Rules

### Planning aid on a pricing option

#### RC-R1: A buyer without the extension keeps the option

A buyer that does not understand this extension MUST ignore the card at `pricing_option` and MUST
keep the option buyable at its `fixed_price`.

Enforced by: kernel (extension point `pricing_option`, policy `flag`, entry not flagged).

#### RC-R2: The quote binds, not the card

A seller MUST quote `fixed_price` on every pricing option that carries a card, and MUST NOT
flag the card `must_understand`. A buyer that ignores the card loses nothing it needs to buy.

Enforced by: conformance only.

#### RC-R3: The card reproduces the quote

A buyer that understands this extension MUST evaluate the card at `quoted_selection` as the
Evaluation section describes. A seller SHOULD publish a card that reproduces the option's
`fixed_price` and `price_breakdown`.

Enforced by: check(); x-adcp-validation `rate_card_quote.evaluation`.

#### RC-R4: A differing quote is a warning

At `pricing_option`, a buyer MUST NOT reject an option because the card evaluates to a price
other than `fixed_price`. It reports a warning, and the seller's quote binds.

Enforced by: check() (warning `RATE_CARD_QUOTE_DIFFERS`); x-adcp-validation `rate_card_quote.quote_differs`.

#### RC-R5: Index points target a fired index

An `index_points` row MUST target a dimension on which an `index` row fires for the same
selection. Otherwise no buyer can evaluate the card.

Enforced by: check(); x-adcp-validation `rate_card_quote.index_points_target`.

#### RC-R6: A provisional row is a ceiling

A row whose factor the seller fixes after booking MUST set `status` to `provisional` and
MUST give `cap` and `fixed_at`. A buyer MUST evaluate the row at `cap`, so the result is a
ceiling until `fixed_at`.

Enforced by: schema (`IndexRow` requires `cap` and `fixed_at` when provisional); check() (warning `RATE_CARD_PROVISIONAL`); x-adcp-validation `rate_card_quote.provisional_rows`.

### Card in signed terms

#### RC-R7: A buyer without the extension rejects a signed card

A buyer that does not understand the exact uri@digest MUST NOT accept commercial terms
that carry this extension.

Enforced by: kernel (extension point `commercial_terms`, policy `always`).

#### RC-R8: The signed card agrees with the signed price

The card in `commercial_terms`, evaluated at its `selection`, MUST equal the `fixed_price` of
the purchase it names. A buyer MUST reject terms where the two differ, because it can't tell
which number it signs.

Enforced by: check(); x-adcp-validation `rate_card_binding.price`.

#### RC-R9: The signed card names a purchase

The binding's `purchase_index` MUST name an entry of `commercial_terms.purchases`.

Enforced by: check(); x-adcp-validation `rate_card_binding.purchase_index`.
