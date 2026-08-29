---
id: DR-0015
title: Sellers may publish registry-backed acceptance-policy discovery
class: normative
status: ratified
date: 2026-08-24
decided: 2026-08-24
decided_by: WG approval confirmed by Brian O'Kelley
refs: ["#6749", "PR #6794"]
dissent: No dissent was reported in the ratification confirmation
---

## Decision

Sellers may publish structured acceptance-policy catalogs that compose exact,
version-pinned policy-registry entries into reusable profiles. Catalogs are
content-addressed, may declare partial or complete coverage, and may be
projected by products. Political-advertising acceptance is represented through
registry category facets and contextual rules rather than a single boolean.

Discovery is advisory. A seller's authoritative response to a transaction may
still reject it using the protocol's structured error vocabulary, including an
opaque seller policy reference when disclosure would expose enforcement
controls.

## Rationale

Buyers need machine-readable preflight guidance without requiring sellers to
publish every internal rule. Registry-backed profiles provide shared meaning,
version and digest pins provide reproducibility, and contextual facets can
represent regional and conditional platform policies without hard-coding one
special category into the protocol.

## Implications

Catalog and policy publications are immutable at a pinned version. Buyers must
respect coverage and omission semantics and must not treat discovery as a
promise that a buy will be accepted. Sellers retain progressive-disclosure
control over authoritative rejection details.
