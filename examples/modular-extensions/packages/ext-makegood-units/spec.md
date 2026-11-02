# Make-good units

This document is the normative specification of the extension
`https://extensions.adcontextprotocol.org/makegood-units`, version 1.5.0. The extension
digest covers this file: the manifest lists its sha256 under `docs.spec`.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

Each requirement is a rule with an ID, such as `MG-R3`. Every rule names what enforces it:

- `kernel`: the buyer validator, from the must-understand policy where the entry attaches.
- `schema`: the JSON Schema definition in this bundle.
- `x-adcp-validation`: a declarative verifier constraint in this bundle.
- `check()`: the reference code in `index.mjs`, which is not normative.
- `conformance only`: no code in the buyer SDK enforces the rule; only the conformance
  storyboards test it.

The storyboards in `conformance/` cite the rule IDs they test.

## Overview

A buyer pre-authorizes the seller to add zero-cost replacement units when the seller misses
a deliverable or under-delivers. Each rule sets a cap, a time window, and the attributes the
unit keeps. A unit that the seller adds under a rule is an ordinary core package with budget 0.
The extension records why the unit exists, and lets the buyer verify that the unit stayed
inside the rule. Anything outside a rule is a seller offer in the core offer lane. A hook is
a place where a module lets extensions attach: an extension point, an open union, or the
kernel's `task` union. This extension attaches at two hooks and contributes one task:

| Hook | Definition | Must understand | Role |
|---|---|---|---|
| `commercial_terms` | `MakegoodTerms` | Required (policy `always`) | Binding rules under `terms_digest` |
| `media_buy_state` | `MakegoodLedger` | Optional (policy `never`) | Readback of the units the seller issued |
| `task`, branch `request_makegood` | `MakegoodRequest` -> `MakegoodResponse` | Not applicable (an offer in the seller's declaration) | The buyer asks for a unit under an accepted rule |

The task ID is `https://extensions.adcontextprotocol.org/makegood-units#request_makegood`. A
seller serves it under a transport name of its choice (an MCP tool name or A2A skill ID that
starts with `x_`), which its capabilities declaration maps to the task ID.

## Rules

### Negotiation

#### MG-R1: A buyer without the extension rejects the rules

A buyer that does not understand the exact uri@digest MUST NOT accept commercial terms that
carry this extension. It rejects them with `EXTENSION_NOT_UNDERSTOOD`, or with
`EXTENSION_VERSION_NOT_UNDERSTOOD` when it understands another digest of the same uri.

Enforced by: kernel (hook `commercial_terms`, policy `always`).

#### MG-R2: The seller sends the rules only to a buyer that understands them

A seller MUST NOT put make-good rules in a proposal for a buyer that did not list this
uri@digest in `understood_extensions`. The seller sends that buyer the same buy without the
rules, or declines.

Enforced by: conformance only.

### Binding rules

#### MG-R3: Rule IDs are unique and in order

Within one `MakegoodTerms` value, each `rule_id` MUST be unique, and the rules MUST be in
ascending `rule_id` order, so equal terms serialize to equal `terms_digest` values.

Enforced by: check(); x-adcp-validation `makegood_rule_bounds.unique_by`; x-adcp-validation `makegood_rule_bounds.canonical_order`.

#### MG-R4: A rule names a purchase in the same terms

Each rule's `purchase_index` MUST name an entry of `commercial_terms.purchases`.

Enforced by: check(); x-adcp-validation `makegood_rule_bounds.purchase_index`.

#### MG-R5: The window is a fixed duration

A rule's `window` MUST be a fixed duration. A window can't use the unit `campaign`, because
the window counts from the accepted end of one purchase.

Enforced by: check(); x-adcp-validation `makegood_rule_bounds.window`.

#### MG-R6: Units are zero-cost

A rule MUST set `at_no_cost` to `true`. A paid replacement is a seller offer, not a
make-good unit.

Enforced by: schema (`MakegoodRule.at_no_cost` is the constant `true`).

### Readback

#### MG-R7: Readback uses the accepted uri@digest

A seller MUST write the `media_buy_state` entry with the same uri and digest as the accepted
`commercial_terms` entry. A buyer that finds two digests of this uri in one media buy MUST
fail closed.

Enforced by: kernel (one uri, one digest per message).

#### MG-R8: A unit names an accepted rule

Each issued unit's `rule_id` MUST name a rule in the accepted commercial terms.

Enforced by: check(); x-adcp-validation `makegood_within_rule.rule`.

#### MG-R9: At most max_units per rule

A seller MUST NOT issue more than `max_units` units under one rule over the life of the media
buy.

Enforced by: check(); x-adcp-validation `makegood_within_rule.max_units`.

#### MG-R10: A unit starts inside the window

A unit's package MUST start no later than the replaced purchase's accepted `end_time` plus
the rule's `window`. The bound counts from the accepted value, not from a later revision.

Enforced by: check(); x-adcp-validation `makegood_within_rule.window`.

#### MG-R11: A unit is a zero-cost core package of the same buy

Each unit's `package_id` MUST name a package of the same media buy, and that package MUST
have budget 0.

Enforced by: check(); x-adcp-validation `makegood_within_rule.package`.

#### MG-R12: A unit keeps what the rule keeps

For each attribute in the rule's `keep_same`, the unit's `evidence` MUST carry the original
value and the make-good value, and the two MUST be equal.

Enforced by: check(); x-adcp-validation `makegood_within_rule.keep_same`.

#### MG-R13: The reason matches the trigger

A unit's `reason` MUST equal the rule's `trigger`.

Enforced by: check(); x-adcp-validation `makegood_within_rule.trigger`.

#### MG-R14: The seller cancels a missed deliverable in the same revision

When a seller issues a unit for a `deliverable_missed` trigger, it MUST cancel the package of
the missed deliverable in the same media buy revision that adds the unit. The buyer then never
pays for both.

Enforced by: conformance only.

#### MG-R15: The seller announces each unit on the core change feed

For each issued unit, the seller MUST emit an `account.change_recorded` record. The unit's
`change_id` MUST name that record, and the unit's `revision` MUST equal the record's
`resource_revision`.

Enforced by: conformance only.

#### MG-R16: A buyer without the extension keeps the media buy

A buyer that does not understand this extension MUST NOT reject a media buy because of its
`media_buy_state` entry. It ignores the entry; the core packages carry the live state.

Enforced by: kernel (hook `media_buy_state`, policy `never`).

#### MG-R17: Readback from an unknown extension does not hide this one

A buyer that understands this extension SHOULD verify this extension's readback even when the media
buy carries readback from extensions it does not understand.

Enforced by: kernel (grades each entry on its own).

### Task request_makegood

#### MG-R18: The seller declares the task, and the buyer calls the declared name

A seller that serves the task MUST list it in the `tasks` of its `declared_extensions` entry for
this uri@digest, mapping a transport name to the task ID. A buyer MUST call the task only under
the transport name the seller declared for the exact uri@digest the buyer understands, and a
buyer without the extension MUST NOT treat the declaration as an error.

Enforced by: kernel (hook `task`, policy `never`).

#### MG-R19: A request invokes an accepted rule for its own purchase

The seller MUST reject a request whose `rule_id` is not a rule in the accepted commercial terms
of the media buy, or whose `package_id` is not the package of that rule's purchase, with the
rejection code `RULE_NOT_ACCEPTED`.

Enforced by: conformance only.

#### MG-R20: A request cannot exceed the cap

When a request asks for a unit beyond the rule's `max_units` units over the life of the media
buy, the seller MUST reject it with the rejection code `CAP_EXCEEDED`.

Enforced by: conformance only.

#### MG-R21: An accepted request is a unit in the media buy

When the seller accepts a request, the response MUST name the unit's `makegood_id`, its
zero-cost `package_id`, the media buy `revision` that adds it, and the `change_id` of the
change record for that revision. The media buy at that revision MUST carry the unit in its
`media_buy_state` ledger, under rules MG-R7 to MG-R15.

Enforced by: conformance only.

#### MG-R22: The buyer validates the response

A buyer MUST validate the response against `MakegoodResponse`, and MUST reject a response that
fails it, or whose `rule_id` differs from the request's.

Enforced by: schema; check().
