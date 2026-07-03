---
id: DR-0005
title: Serve-time macro substitution is not wire-observable; conformance tests the output manifest
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-06
decided_by: maintainer practice
refs: ["#5646"]
dissent: none
---

## Decision

Universal macro substitution (`{MEDIA_BUY_ID}`, `{PACKAGE_ID}`, …) happens at
serve time inside the sales agent; no AdCP task serializes resolved trackers,
so substitution itself is not observable on the wire. Wire conformance
therefore asserts what *is* on the wire: `macro_values` handling and the output
creative manifest (structured, required fields). Verifying actual substitution
belongs to Live Integration verification, not wire conformance.

## Rationale

The first macro storyboard tested the wrong actor (build_creative preview) and
could not fail meaningfully. Testing an actor for work another actor performs
at another time produces conformance theater.

## Implications

- Storyboards must name which actor performs the behavior under test and
  confirm the behavior is observable in that actor's wire surface.
- SDK macro-substitution helpers are verifiable only by golden fixtures;
  cross-language drift between helpers is invisible to wire conformance and
  needs its own test surface.
