---
id: DR-0013
title: Surface consent macros supplied through value mappings
class: normative
status: ratified
date: 2026-08-19
decided: 2026-08-19
decided_by: maintainer approval
refs: ["#6674", "PR #6679"]
dissent: none
---

## Decision

When a `{ value: ... }` mapping is supplied for a consent macro
(`{GDPR_CONSENT}`, `{US_PRIVACY}`, `{GPP_STRING}`, etc.), the helper must encode
the value and add the macro name to a new `frozen_consent_macros` return field
(parallel to `dropped_consent_macros`). Silent encoding without surfacing is
not permitted.

## Rationale

Freezing consent strings at build time produces stale-consent pixels — a
privacy defect. The advisory-field pattern already used for
`dropped_consent_macros` / `suspect_native_values` keeps behavior fail-open for
test harnesses while making the defect impossible to miss in production.

## Implications

This is non-breaking because it adds an optional return field.
`frozen_consent_macros` vectors must be in the golden fixture.
