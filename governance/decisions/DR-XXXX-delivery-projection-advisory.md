---
id: DR-XXXX
title: Delivery projections are advisory forecasts, not delivery records
class: normative
status: proposed
date: 2026-10-09
refs: ["#5850"]
dissent: none
---

The `DR-XXXX` number and this filename are placeholders. The number is assigned at merge.

## Decision

A seller MAY report a forward-looking `projection` on top-level `by_package[]` rows of `get_media_buy_delivery`. A projection is an advisory forecast, not a delivery record. It carries no contractual meaning on its own, and any commercial use of it is governed by the parties' terms. Reported actuals remain the delivery record. The surface is experimental under `media_buy.delivery_projection`.

- `projected_end_state` is `on_pace`, `complete`, `underdelivery`, or `early_exhaustion`, judged against the package's binding constraint (whichever of goal or budget it would reach first) using the seller's own tolerance and materiality thresholds.
- `basis` names the method class (`trailing_daily_avg`, `trailing_hourly_avg`, `platform_model`, `seller_defined`), not the window length or model. It is distinct from the commitment tier in `forecast_method`.
- `is_final` on the enclosing row describes the actuals, not the projection.

## Rationale

Without a stated status, sellers would not publish projections, because a number in a delivery report invites being read as a promise. Stating the status in the protocol, and leaving remedies to the parties' terms, keeps the protocol out of commercial disputes while letting sellers with better models share them. The earlier draft wording that barred projections from makegood and billing claims was withdrawn for the opposite reason: it put the protocol in those disputes.

## Implications

This settles the status of the projection, not how parties use it commercially. Buy-level roll-up, confidence ranges, and projection on the `get_media_buys` snapshot are deferred. A future per-period or contractual projection surface would be a new record, not an amendment to this one.
