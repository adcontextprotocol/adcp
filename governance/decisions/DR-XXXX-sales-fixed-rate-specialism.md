---
id: DR-XXXX
title: A fixed-price, non-guaranteed seller claims `sales-fixed-rate`, and seller review is a commitment axis, not a status
class: normative
status: proposed
date: 2026-10-06
refs: ["#6303", "#5697", "#6345"]
dissent: none reported; WG review pending
---

## Decision

AdCP adds the specialism `sales-fixed-rate`, defined by buying mechanics that a
storyboard can grade:

- The seller sells **non-guaranteed** inventory: no reserved inventory and no
  delivery commitment.
- Its price is a **published fixed price**. Products offer `fixed_price` pricing
  options; there is no auction, no `floor_price`, no `price_guidance`, and the
  buyer sends no `bid_price`.
- The seller **MAY hold a buy for review** before committing to it.

The specialism is an independent claim. A seller that commits to delivery under
an IO claims `sales-guaranteed`; a seller that runs an auction claims
`sales-non-guaranteed`; a mixed seller claims each model it runs.

The `sales_fixed_rate` storyboard (track `media_buy`) requires the four
scenarios that already use fixed-price, non-guaranteed fixtures
(`media_buy_seller/delivery_reporting`,
`media_buy_seller/pending_creatives_to_start`,
`media_buy_seller/invalid_transitions`, and
`governance_aware_seller/governance_multi_agent_rejected`) and adds its own
phases: capability discovery, product discovery with `is_fixed_price: true`,
and a bid-less `create_media_buy` that returns synchronous success with a
`media_buy_id`. The create response may report any of `pending_creatives`,
`pending_start`, or `active`, and `confirmed_at` either set or `null`; the
storyboard asserts that a status is valid, not which valid status.

**The review hold is optional.** The hold phases are gated by
`requires_capability: {path: compliance_testing.scenarios, contains:
force_media_buy_confirmation}` and grade `not_applicable` for sellers that do
not advertise that scenario. A held buy is not an async task. It is synchronous
success with `confirmed_at: null`; the `media_buy_id` exists immediately. This
differs deliberately from the `sales-guaranteed` hold, which uses the
`submitted` task arm and issues no `media_buy_id` until the IO is signed.
Confirmation, rejection, and cancellation of a held buy are observed by polling
`get_media_buys`; no status-change webhook is graded because the media-buy wire
defines none.

**Status and commitment are separate axes.** `status` is the buyer-actionable
readiness axis. `confirmed_at` is the independent seller-commitment axis, and
commitment is keyed off `confirmed_at`, never off `status`. A provisional buy
(`confirmed_at: null`) reports the status it will have on confirmation,
`pending_creatives` while creatives are missing or unapproved and
`pending_start` once it is otherwise ready, and is never `active`. The
`pending_creatives` enum description no longer says the seller "has already
accepted" the buy. `pending_creatives` is not redefined and `pending_start` is
not mandated for held buys. The normative text records that confirmation
increments `revision`; that an idempotency replay of the original create
returns the historical `confirmed_at: null` snapshot; that a held buy whose
flight start passes stays `pending_start` until confirmed or rejected, which
narrows the existing rule that a seller MUST move `pending_start` to `active`
at flight start so that it applies only to committed buys (`confirmed_at`
non-null); that
rejection and buyer cancellation leave `confirmed_at` null; and that a seller
that does not accept buyer `pause` on a buy it is reviewing SHOULD omit it from
`valid_actions`.

**Controller scenario.** `comply_test_controller` gains one additive scenario,
`force_media_buy_confirmation`, with `params.action` of `hold` or `confirm`.
`hold` registers a single-shot directive that makes the next create from the
caller's sandbox account a held buy. `confirm` commits a named held buy: it sets
`confirmed_at` once and increments `revision`, and is idempotent. Rejection of a
held buy reuses `force_media_buy_status` with `status: rejected`.

The specialism ships with status `preview`, like `sales-exchange`, until the WG
ratifies the name and the hold gating.

## Rationale

Specialisms in this taxonomy name mechanics a runner can observe, not who the
seller is. "Non-guaranteed, fixed-price, may hold for review" is observable;
"publisher-direct" is not, and an auction seller that also sells direct would
over-declare it and pollute the compliance signal. The mechanic-first name also
carries to SSPs and rep firms running fixed-rate packages.

Gating the auction phases of `sales-non-guaranteed` was considered and not
chosen. The capability gate is a no-op for the five auction scenarios, which
already carry `requires_capability` gates; what blocks a fixed-price seller is
the ungated `is_fixed_price: false` filter, `price_guidance`, and `bid_price`
steps, and gating those would mutate a surface existing adopters are certified
against. The hold needed no new response shape: `confirmed_at: null` with the
existing "never `active`" constraint was already valid (#5697, #6345). What was
wrong was the `pending_creatives` description, which implied acceptance and left
a held buy with no honest status.

## Implications

Sellers that sell at a fixed price and make no delivery commitment have a claim
that grades their actual model. Sellers that never hold buys are graded on the
core path alone. Future proposals should not use `status` to infer seller
commitment, and should not add a MediaBuy status for "awaiting seller review".

Not decided here: a seller-declared capability field for "this seller holds
buys" (the hold phase is gated on the controller scenario instead), a
`rejection_reason` field on the create response, an approval-latency SLA, a
confirmation webhook, whether 3.1.x and 3.2.x should backport the
description-only `pending_creatives` fix, and whether fixed-price CPM options
should be exercised by a storyboard once the SDK runner stops auto-filling
`bid_price` on `cpm` creates.
