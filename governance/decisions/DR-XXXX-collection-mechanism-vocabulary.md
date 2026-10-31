---
id: DR-XXXX
title: One collection-mechanism vocabulary serves discovery-time counting and report-time provenance
class: normative
status: proposed
date: 2026-10-09
refs: ["#6878", "#2041", "DR-0009", "DR-0019", "DR-0036", "#7177"]
dissent: none
---

## Decision

`enums/collection-mechanism.json` is the single closed vocabulary for "what a
count is built from." It is used in two places and nowhere else may fork it:

1. `measurement_terms.billing_measurement.counting_mechanisms[]` — discovery-time,
   scoped to the billing count.
2. `delivery-metrics.vendor_metric_provenance[].mechanisms[]` — report-time,
   scoped to one reported vendor row and joined to it on
   `(vendor, metric_id, qualifier)`.

The enum names collection **mechanisms** (`set_top_box`, `acr`, `panel`,
`server_logs`, `client_tracker`, `sdk`), never parties and never coverage claims.
Who counts is carried by a BrandRef (`billing_measurement.vendor`,
`vendor_metric_values[].vendor`, `vendor_relationship`). Ownership-flavored
labels (`ad_server`, `publisher_logs`, `measurement_vendor`) and the coverage claim `census` are not values.
The surface is experimental in 3.3 (`media_buy.measurement_provenance`). After
graduation, values cannot be renamed or removed; new values are additive (minor).

"Measurement source" keeps its existing meaning of provider identity
(`measurement_source` on delivery metrics and forecasts, the provider slugs
`nielsen`, `videoamp`, `ivw`). The mechanism fields and enum are therefore named
`collection-mechanism`, `counting_mechanisms[]`, and `mechanisms[]`, and the
enum and field descriptions say they are not `measurement_source`. Broadcast
as-run logs and station affidavits are airing evidence carried in `by_spot[]`,
not a mechanism.

`vendor_metric_provenance[]` entries are open objects (DR-0009): descriptors,
not join-key objects, so they do not meet DR-0019 Class A. The entry carries the
row's key only to join to it. It is deliberately not a `qualifier`
key and stays out of the `(vendor, metric_id, qualifier)` reconciliation join.

Both homes are open. `vendor-metric-value.json` is a closed row envelope
(DR-0019 class B) and `canonical-measurement-terms.json` holds terms the buyer
is bound by, so under DR-0036 neither takes a new field in a minor. Provenance
therefore lives in a sibling array on the open `delivery-metrics.json`, and
`counting_mechanisms` stays on the open `measurement-terms.json`; the canonical
terms gain `counting_mechanisms` in 4.0 (registry check
`canonical_counting_mechanisms_required_in_4_0`).
`mechanisms` is a set (unique, order-insignificant). `deduplicated` is
tri-state by presence — `true`, `false` (senders MUST serialize it), or absent
(unspecified).

`counting_mechanisms[]` lists only mechanisms whose events enter the billed count.
A seller (or its ad server) that is itself the named `billing_measurement.vendor`
SHOULD declare it. Absence of either field means *undeclared*, never a default
mechanism.

## Rationale

Discovery-time and report-time nomenclature that diverge cannot be reconciled
later; one vocabulary prevents the fork. Mechanism-only values keep the enum
stable and leave party and trust semantics where they already live.

Both fields are claims by the declaring party that receiving parties should
verify (the `provenance.json` model). Their presence is wire-observable; their
truthfulness is enforced through the contract (`billing_measurement.vendor`,
`max_variance_percent`, `makegood_policy`), not a conformance probe, so DR-0005
is not engaged.

SHOULD rather than a conditional MUST for self-counting sellers: #7177 shows a
self-vendor MUST is expressible and acceptable in a minor
(`x-adcp-validation`), but `vendor_relationship` is a disclosure that gates
reconciliation, whereas `counting_mechanisms` is an input to term negotiation and
`billing_measurement` itself is optional. A MUST on the self-vendor branch
invites sellers to omit `billing_measurement` rather than disclose. Promotion to
`schema_required_when` is a 4.0 candidate once adoption shows the need.

## Implications

- Settles: one enum, two uses, experimental in 3.3; no ownership-flavored or coverage-claim values;
  provenance is not a `qualifier` key; provenance is row-level.
- Known gap: standard scalar metrics (`impressions`) have no report-time
  provenance slot, so a declared `counting_mechanisms` cannot yet be checked against
  a reported value for the billed metric. Forecast vendor metrics carry no
  provenance (non-goal).
- Does not settle: `impression_id` joinability (deferred until #2196 names a
  concrete impression-level surface; the follow-up must also update
  `canonical-reporting-capabilities.json`); seller-added tracker disclosure
  (`seller_tracker_events[]`, deferred until #6782 observes assembled payloads);
  a household/person/device deduplication level (additive follow-up if a vendor
  shows the need); sensor-based place measurement values; a `get_products`
  filter on `counting_mechanisms`; a possible `ssai_logs` value.
