---
id: DR-0036
title: A closed schema stays closed within a major and changes only by a correction or a named exception
class: normative
status: proposed
date: 2026-10-27
decided_by: pending WG ratification
refs: ["#8501", "DR-0009", "DR-0019", "DR-0024", "DR-0034"]
supersedes: DR-0019  # in part: "adding an optional field to a closed schema is a minor change"
dissent: none recorded
---

## Decision

A schema is **closed** when it sets `additionalProperties: false` or
`unevaluatedProperties: false`. A validator rejects any property that a closed
schema doesn't list.

**A closed schema stays closed for the whole major.** When any stable release
of a major publishes a schema closed, no later minor or patch release of that
major adds a property to it. Opening the schema doesn't change this, because
validators of the release that closed it still reject the new property. This
holds when the property goes only to peers that negotiated the newer minor, and
when the property is experimental.

**A minor release changes a schema only by addition.** It adds optional
properties to open schemas and widens what a schema accepts. It doesn't remove
a property, require a new name, or tighten a bound.

**Corrections and named exceptions are the only departures from these two
rules.** Each one is an entry in `scripts/lint-additive-minor-corrections.json`.
The entry names the schema, the JSON pointer, the change, the release it lands
in, and the published text it rests on, quoted. The additive-minor check accepts
exactly the listed changes. A PR that adds an entry is reviewed against this
record. The record itself doesn't list entries.

### Corrections

A correction changes a schema to match what the published text of the major
already says. There are two kinds.

1. **Opening a schema that the published text keeps open.** DR-0019 allows a
   closed schema only in class A (a join-key or discriminator object) or
   class B (a row envelope with an escape hatch). It keeps request roots,
   response roots, capability blocks, and containers open, and it calls a
   class B schema without an escape hatch a defect. A schema closed against
   those rules is opened. From the release that opens it, it is an open schema,
   and a later minor may add to it. A property added after the opening goes
   only to peers served that release or a later one (DR-0024).
2. **Bounding a concept as the published text bounds it.** When the published
   text of the major gives a concept a bound or a required name, that bound or
   name holds wherever the concept appears. The text can be prose, a schema of
   the major that defines the concept, or an external standard the text names,
   such as RFC 1035 for a domain name. A correction applies the bound at a site
   that lacked it. No conforming peer sends a value outside it, so the
   correction rejects nothing a conforming peer sends.

A correction lands in a minor release. It may also ship in a patch of an
earlier minor of the same major.

### Named exceptions

A named exception lets a schema that DR-0019 keeps closed accept a named
property that no published text required. The schema stays closed for every
other name. It is allowed only when all three hold:

- The schema validates a request, so the request's receiver is the validator.
- Each name requires a capability that the receiver declares.
- A sender MUST NOT send the name to a receiver that doesn't declare the
  capability.

### Closing schemas

New schemas default to open (DR-0009). A schema is closed only when it fits
DR-0019 class A or class B, and the PR that closes it names the class. The rule
covers stable schemas. A schema that is experimental in the release that
closes it carries no stability promise.

**This replaces part of DR-0019.** Its consequence "adding an optional field to
a closed schema is a `minor` change" no longer holds. The rest of DR-0019
stands.

## Rationale

A strict validator rejects any property its closed schema doesn't list, so an
addition breaks it exactly as a removal does. That the property is optional
doesn't help: the validator rejects the payload before any reader sees it.

Negotiating a release doesn't contain the break. Objects are stored and read
back later, relayed to other agents, and covered by digests. So a property sent
to one peer can reach a validator that never negotiated the newer release.

A correction is safe because it restores what the text already said. Opening a
schema that the text keeps open fixes only a validator that diverged from the
text. Applying a bound the text already sets rejects only values that no
conforming peer sends.

A named exception is safe for a different reason. A request is validated by the
receiver it is sent to, and a conforming sender sends the name only to a
receiver that declared the capability. The declaration is that receiver's own
statement that it accepts the name. A negotiated release makes no such
statement about the validators an object reaches later.

## Implications

- Any other change to a closed schema waits for the next major: a new property,
  a removal, a newly required name, or a tighter bound that the published text
  doesn't set.
- A schema closed on purpose stays closed even when a feature needs it to grow.
  The feature moves to an open schema or waits for the next major.
  `commercial-terms` is one: a buyer must not be bound by terms it can't read,
  and `terms_digest` signs exactly those terms.
- Changes that shipped before this record stay as published until the next
  major. `scripts/lint-additive-minor-baseline.json` lists them.
- `core/postal-area-support.json` counts as closed since 3.0, because 3.0 closed
  the object it replaced. No 3.x release adds a country key to it.
- This record doesn't settle how closed schemas such as `commercial-terms` grow
  in the next major.
