---
id: DR-XXXX
title: One measurement-source vocabulary serves discovery-time counting and report-time provenance
class: normative
status: proposed
date: 2026-10-06
refs: ["#6878", "#2041", "DR-0009", "DR-0019", "#7177"]
dissent: none
---

## Decision

`enums/measurement-source-type.json` is the single closed vocabulary for "what a
count is built from." It is used in two places and nowhere else may fork it:

1. `measurement_terms.billing_measurement.counting_sources[]` — discovery-time,
   scoped to the billing count.
2. `vendor_metric_values[].measurement_provenance.source_types[]` — report-time,
   scoped to one reported vendor row.

The enum names collection **mechanisms** (`set_top_box`, `acr`, `panel`,
`server_logs`, `client_tracker`, `sdk`), never parties and never coverage claims.
Who counts is carried by a BrandRef (`billing_measurement.vendor`,
`vendor_metric_values[].vendor`, `vendor_relationship`). Ownership-flavored
labels (`ad_server`, `publisher_logs`, `measurement_vendor`) are not values.
Values cannot be renamed or removed once released; new values are additive
(minor).

`measurement_provenance` is an open object (DR-0009): a descriptor, not a join
key, so it does not meet DR-0019 Class A. It is deliberately not a `qualifier`
key and stays out of the `(vendor, metric_id, qualifier)` reconciliation join.
`source_types` is a set (unique, order-insignificant). `deduplicated` is
tri-state by presence — `true`, `false` (senders MUST serialize it), or absent
(unspecified).

`counting_sources[]` lists only sources whose events enter the billed count.
A seller (or its ad server) that is itself the named `billing_measurement.vendor`
SHOULD declare it. Absence of either field means *undeclared*, never a default
source.

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
reconciliation, whereas `counting_sources` is an input to term negotiation and
`billing_measurement` itself is optional. A MUST on the self-vendor branch
invites sellers to omit `billing_measurement` rather than disclose. Promotion to
`schema_required_when` is a 4.0 candidate once adoption shows the need.

## Implications

- Settles: one enum, two uses; no ownership-flavored or coverage-claim values;
  provenance is not a `qualifier` key; provenance is row-level.
- Known gap: standard scalar metrics (`impressions`) have no report-time
  provenance slot, so a declared `counting_sources` cannot yet be checked against
  a reported value for the billed metric. Forecast vendor metrics carry no
  provenance (non-goal).
- Does not settle: `impression_id` joinability (deferred until #2196 names a
  concrete impression-level surface; the follow-up must also update
  `canonical-reporting-capabilities.json`); seller-added tracker disclosure
  (`seller_tracker_events[]`, deferred until #6782 observes assembled payloads);
  a household/person/device deduplication level (additive follow-up if a vendor
  shows the need); sensor-based place measurement values; a `get_products`
  filter on `counting_sources`; a possible `ssai_logs` value.
