# Linear TV indexed cost per point

This document is the normative specification of the extension
`https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp`, version 1.5.0. The
extension digest covers this file: the manifest lists its sha256 under `docs.spec`.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

Each requirement is a rule with an ID, such as `LTV-R3`. Every rule names what enforces it:

- `kernel`: the buyer validator, from the must-understand policy where the entry attaches.
- `schema`: the JSON Schema definition in this bundle.
- `x-adcp-validation`: a declarative verifier constraint in this bundle.
- `check()`: the reference code in `index.mjs`, which is not normative.
- `conformance only`: no code in the buyer SDK enforces the rule; only the conformance
  storyboards test it.

The storyboards in `conformance/` cite the rule IDs they test.

## Overview

This extension is a pricing model that core does not have. It follows the Dutch linear-TV
and radio convention (published rate cards): the rate per rating point is the base price, times indices
fixed at booking, times a market index that the seller fixes after booking. Early requests
get a cap on the market index. The buyer signs the formula, the cap, and the fixing date,
not a number. The seller fixes the index later and invoices delivered points at the fixed
rate. Core `cpp` can't express this, because its `fixed_price` binds at acceptance.

The extension registers the branch `indexed_cpp` in the buying module's `pricing_model`
open union, with `reports_as: cpp`. A hook is a place where a module lets extensions attach:
an extension point, an open union, or the kernel's `task` union. This extension attaches at
three hooks:

| Hook | Definition | Must understand | Role |
|---|---|---|---|
| `pricing_model` (branch `indexed_cpp`) | `IndexedCpp` | Required (every branch) | The model on a pricing option and on an accepted purchase |
| `media_buy_state` | `IndexFixings` | Optional (policy `never`) | Readback of the fixed market index and rate |
| `capabilities` | `IndexedCppCapabilities` | Optional (policy `never`) | Where the seller offers the model |

## Rate

The rate per point at a market index `m` is `base_price`, times each index factor in order,
times `m`, rounded after each step as `rounding` declares. The ceiling is the rate at
`market_index.cap`.

## Rules

### Offer and projection

#### LTV-R1: A buyer without the extension drops the option

A buyer that does not understand the exact uri@digest MUST NOT buy an option priced
with this branch. In a product's list of pricing options, it drops that option with a warning
and keeps the product's other options, as the buying module's `unknown_in_list:
drop_option` sets.

Enforced by: kernel (open union `pricing_model`, `unknown_in_list: drop_option`).

#### LTV-R2: Signed terms with the branch fail closed

A buyer that does not understand the exact uri@digest MUST NOT accept commercial terms
whose purchase is priced with this branch. The pricing of a purchase is not a list item, so the
drop policy never applies there.

Enforced by: kernel (open-union branches are always must-understand).

#### LTV-R3: The seller quotes a core model to other buyers

A seller MUST NOT send an option or a purchase priced with this branch to a buyer that did not
list this uri@digest in `understood_extensions`. It quotes that buyer in a core model, such
as `cpp` at the published market index.

Enforced by: conformance only.

### The model

#### LTV-R4: The ceiling follows from the formula

`ceiling_price` MUST equal the rate at `market_index.cap`.

Enforced by: check(); x-adcp-validation `indexed_cpp_quote.ceiling_price`.

#### LTV-R5: The floor is not above the cap

When `market_index.floor` is present, it MUST NOT be greater than `market_index.cap`.

Enforced by: check(); x-adcp-validation `indexed_cpp_quote.bounds`.

#### LTV-R6: The model applies to its channels

A seller MUST offer this branch only on a product sold in a channel the registration's
`applies_to.channels` lists: `linear_tv` or `radio`.

Enforced by: check(); x-adcp-validation `indexed_cpp_quote.scope`.

#### LTV-R7: The capability fragment stays in scope

A seller SHOULD declare the model in `capabilities` only for channels the registration lists.
The buyer SDK reports a warning otherwise.

Enforced by: check() (warning `INDEXED_CPP_CAPABILITY_SCOPE`).

### Fixing and settlement

#### LTV-R8: Readback uses the accepted uri@digest

A seller MUST write the `media_buy_state` entry with the same uri and digest as the accepted
branch. A buyer that finds two digests of this uri in one media buy MUST fail closed.

Enforced by: kernel (one uri, one digest per message).

#### LTV-R9: A fixing names a purchase priced with the branch

Each fixing's `purchase_index` MUST name an accepted purchase priced with this branch.

Enforced by: check(); x-adcp-validation `index_fixing.purchase`.

#### LTV-R10: The index is capped

The fixed market index MUST NOT exceed the signed `cap`, and MUST NOT be below the signed
`floor` when one is present.

Enforced by: check(); x-adcp-validation `index_fixing.index_bounds`.

#### LTV-R11: The seller fixes the index after booking

A seller MUST NOT fix the market index before the signed `market_index.fixed_at`.

Enforced by: check(); x-adcp-validation `index_fixing.timing`.

#### LTV-R12: The rate follows from the index

A fixing's `rate` MUST equal the rate at its `market_index`.

Enforced by: check(); x-adcp-validation `index_fixing.rate`.

#### LTV-R13: The seller announces each fixing on the core change feed

For each fixing, the seller MUST emit an `account.change_recorded` record. The fixing's
`change_id` MUST name that record, and its `revision` MUST equal the record's
`resource_revision`.

Enforced by: conformance only.

#### LTV-R14: The invoice is delivered points times the fixed rate

The seller MUST invoice delivered rating points times the fixed rate, rounded half away from
zero to two decimals, in the option currency. The invoiced amount MUST NOT exceed the
purchase budget.

Enforced by: conformance only.
