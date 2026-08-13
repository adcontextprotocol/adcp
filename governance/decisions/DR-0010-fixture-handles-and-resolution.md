---
id: DR-0010
title: Storyboard fixture IDs are handles resolved against the seller's sandbox surface
class: normative
status: ratified
date: 2026-08-06
decided: 2026-08-06
decided_by: maintainer approval
refs: ["#5891"]
dissent: none
---

## Decision

Beginning with AdCP 3.2, an identity field authored in a storyboard `fixtures:`
entry is a run-scoped handle. It is not, by itself, a requirement that the
seller persist that literal identifier. A runner resolves each fixture through
the ordered strategies explicitly enabled for that handle: `seed`, `discover`,
then `construct`. When no `fixture_resolution` entry exists, the compatibility
default is `seed` only and retains the 3.1 contract.

Resolution is all-or-nothing per authored fixture graph. The runner records the
strategy, matched requirements, seller-issued identifiers, and setup calls. It
then substitutes bound identifiers only at schema fields with the matching
`x-entity` annotation. Product pricing-option identities are scoped to their
parent product. A binding is pinned for the run.

An unavailable strategy advances to the next declared strategy. A supported
operation that returns a protocol, schema, transport, or setup failure is a
conformance failure and MUST NOT be hidden by fallback. Exhausting all declared
strategies without a qualifying entity produces `fixture_unsatisfied` and an
explicit coverage gap; it does not produce a pass. Literal injection remains
the compatibility strategy for existing sellers and storyboards.

## Rationale

Platform sellers often expose publisher-owned catalogs whose identifiers are
derived keys. Requiring them to persist runner-selected literals tests an alias
layer rather than their production discovery and booking paths. Resolving
requirements through normal AdCP tools exercises the real system and removes
the magic-ID teach-to-test incentive.

Discovery cannot be inferred safely from every existing fixture object. Some
fixtures encode adversarial relationships or values material to a specific
assertion. Explicit `fixture_resolution` match rules therefore opt a handle
into discovery while leaving unreviewed storyboards on the stable seed-only
contract.

## Implications

- Storyboard `fixtures:` blocks remain valid and continue to supply seed
  exemplars. Discovery metadata lives separately in `fixture_resolution`, so
  older runners do not forward runner-only metadata to sellers.
- Runners and reports gain a fixture-resolution phase, evidence records, and
  the `fixture_unsatisfied` skip reason.
- `seed_*` remains supported but is no longer universally required when every
  fixture required by a claimed specialism can be satisfied by another
  declared strategy. Required `force_*` and `simulate_*` coverage is unchanged.
- Storyboards must opt into discovery one fixture at a time with precise match
  rules. A corpus-wide implicit subset matcher is not conformant.
- Construct strategies are defined per entity lifecycle. Failure of an
  attempted, supported create or transition call is a conformance failure.
