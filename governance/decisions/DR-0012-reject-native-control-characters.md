---
id: DR-0012
title: Universal macro native mappings reject control characters
class: normative
status: ratified
date: 2026-08-19
decided: 2026-08-19
decided_by: maintainer approval
refs: ["#6674", "PR #6679"]
dissent: none
---

## Decision

`translateUniversalMacros` must reject any `{ native: ... }` mapping that
contains control characters (U+0000–U+001F, U+007F) and surface a typed error.
Verbatim insertion is not permitted.

## Rationale

The `native` arm bypasses all encoding; CRLF in a native value produces a
split-header-ready payload with no downstream safety net. No legitimate
ad-server token (`%%…%%`, `{{…}}`, `${…}`, `[UPPER_SNAKE]`) ever contains
control characters — rejection has zero false-positive cost.

## Implications

This is non-breaking because the behavior was unspecified and constrains only
invalid input. Implementations must include control-character rejection in the
golden fixture and expose a language-appropriate typed error.
