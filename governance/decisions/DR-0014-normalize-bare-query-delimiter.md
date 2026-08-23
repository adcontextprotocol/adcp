---
id: DR-0014
title: Universal macro translation removes a bare trailing query delimiter
class: normative
status: ratified
date: 2026-08-19
decided: 2026-08-19
decided_by: maintainer approval
refs: ["#6674", "PR #6679"]
dissent: none
---

## Decision

`translateUniversalMacros` normalizes a URL ending in a bare trailing `?` by
removing that delimiter. For example, `https://pixel.example/i?` becomes
`https://pixel.example/i`.

## Rationale

The JavaScript helper already ships this behavior, and normalization produces
one deterministic result for an empty query. DR-0008 does not independently
settle this question because that record applies to wire shape, while macro
translation is a non-wire-observable helper semantic under DR-0005. The helper
behavior is therefore ratified explicitly here.

## Implications

The golden fixture must include bare-query normalization. This decision does
not authorize other URL canonicalization or changes to non-empty query strings.
