---
id: DR-0039
title: "4.x evolution contract: additive minors on open schemas, machine-readable deprecation, removal only in a major, and a clock on experiments"
class: normative
status: proposed
date: 2026-11-10
refs: ["#8756", "PR #8704", "PR #8858", "PR #8866", "#8501", "DR-0007", "DR-0009", "DR-0024", "DR-0034", "DR-0035", "DR-0036"]
dissent: "none recorded; comments on RFC #8756 are open until 2026-12-04"
---

## Decision

This record is the evolution contract for AdCP 4.x, from 4.0.0 until 5.0. It
is theme T3 of RFC #8756. Sections 1 to 4 cover stable surfaces, section 5
covers experimental surfaces, and section 6 covers every response.

### 1. The four rules

The rules that PR #8704 put on the versioning page govern every 4.x release,
as they govern 3.x:

1. **A minor only adds.** New fields go on open schemas. Nothing is removed,
   renamed, retyped or made required, and no validation rule is tightened.
2. **To replace a field, add the new one and deprecate the old one.** Senders
   emit both until the next major.
3. **Removals and breaking changes happen in a major.**
4. **A minor never adds a field to a mutating request if an older seller that
   ignores it would commit to something different.** Spend, targeting, caps,
   bidding, creative activation, measurement and account identity are
   examples, not the full list. Such a field waits for the next major, with
   one exception: it may ship in a minor behind a capability that the seller
   declares on `get_adcp_capabilities`. A buyer MUST NOT send the field to a
   seller that does not declare the capability. A seller that declares it MUST
   honor the field, because a declared capability is a commitment ("Features
   over versions" on the versioning page).

**The additive-minor check runs from 4.0.0 with an empty baseline.** From
4.0.0 GA, `scripts/lint-additive-minor.cjs` checks every 4.x branch against
the latest 4.x release. Its baseline starts at `4.0.0` with no entries, and so
does the corrections register (DR-0036). Nothing in the 3.x baseline carries
over. In 4.x a baseline entry needs a ratified decision record that names the
change; "pending WG decision" is not a reason. Without one, the change waits
for 5.0. The 4.0 prereleases are not checked against 3.x, because they are the
major.

### 2. Schemas are open by default

DR-0036 (rewritten in #8858, merged) holds in 4.x. A schema is open unless it is
closed for a structural reason, and a schema that stays closed changes only in
a major. In 4.x the structural reasons are a fixed list: the reasons PR #8866
approved for the schemas 3.3 keeps closed, grouped as eight.

| Reason | What closure enforces |
|---|---|
| Key-presence disjointness | The `oneOf` or `anyOf` branches are told apart only by which keys are present, so an open branch would also match a sibling's payload. |
| Signed or digest-bound terms | An extra key would change what a party agreed to. `commercial-terms`, which `terms_digest` binds, is the main case. A must-understand constraint such as `proposal-budget-constraint` is one too. |
| Join key | Consumers join or reconcile on the key set, so a reader that ignored a new key would merge rows that measure different things. |
| Canonical identity | Only the identity members are allowed, so a reference always serializes to the same bytes. |
| JWS envelope | An extra member would be unsigned data that a reader could take as signed. |
| Privacy boundary | The schema enforces a MUST NOT on what a message carries, such as data minimization, or an error shape that must not become an oracle. |
| No key material or markup | An open-ended class of content stays out of a sensitive document: key material, credentials, markup, or free text put in front of an agent. No list of forbidden names could be complete. |
| ID-keyed map | `patternProperties` validates a map's keys. |

PR #8866 states eleven reasons for the 115 locations 3.3 keeps closed. They
map onto the eight as follows. Grouping changes no location's status, so the
WG can split the eight back into the eleven.

| #8866 reason | Locations | Reason here |
|---|---|---|
| oneOf disjointness | 9 | Key-presence disjointness |
| Signed commercial terms | 25 | Signed or digest-bound terms |
| Hard constraint (must-understand) | 1 | Signed or digest-bound terms |
| Closed key set (join key) | 21 | Join key |
| Closed key set (canonical identity) | 2 | Canonical identity |
| Signature envelope | 1 | JWS envelope |
| Closed key set (privacy boundary) | 22 | Privacy boundary |
| Closed key set (no key material or markup) | 18 | No key material or markup |
| Closed key set (credential-free configuration) | 10 | No key material or markup |
| Closed key set (no free text to agents) | 1 | No key material or markup |
| Map keyed by identifier | 5 | ID-keyed map |

- Each closed node names its reason in `x-closed-reason`, and CI fails a closed
  node without one. A new reason needs a new decision record.
- Catching a misnamed field is not a reason to close a schema (DR-0036). When
  a field must stay forbidden on an open schema, the schema names it in a
  **named rejection**: `not: { anyOf: [{ required: ["field"] }] }`.
- A minor may add a named rejection only for a name the schema already
  rejected, as when it opens a closed schema. Forbidding a name that was
  accepted is a tightening, so it waits for a major.

### 3. Deprecation is machine-readable

Every schema node marked `deprecated: true` carries:

- `x-deprecated-in`, the release that deprecated it, such as `"4.2.0"`; and
- exactly one of these:
  - `x-removed-in`, the major that removes it, such as `"5.0.0"`;
  - `x-retained`, a string that says why the node survives the next major.

A deprecated enum value or error code has no node of its own, so it carries
the same facts for each value beside `x-deprecated-enum-values`.

The deprecation lint reads these fields, not the description. It fails a
deprecated node that lacks them, an `x-removed-in` or `x-retained` on a node
that isn't deprecated, and a release that still contains a node whose
`x-removed-in` it has reached. Changing a node's disposition is a recorded
decision and can land in any release.

The rule applies from 4.0.0. The 4.0 removal list gives each node deprecated
in 3.x a disposition: removed in 4.0, or `x-retained`.

### 4. Removal and support

**A major may remove anything deprecated in an earlier release, with no
minimum notice period.** Removals happen only in a major, and the point of a
major is to carry out deprecations. A node deprecated in the last minor before
a major may be removed in that major. Rule 3 also lets a major make a breaking
change that no deprecation preceded, such as a tightening. Each one ships with
the breaking-change notice the versioning page requires.

**Implementers are protected by the previous major's support window.** After a
major's GA, the last minor of the previous major stays supported for at least
**12 months** after the successor's GA. For 4.0 that minor is 3.3. The 12
months match the minimum the versioning page already publishes. Supported
means security fixes and corrections in patches of that line, and no new
features. This widens the versioning page, which today promises the previous
major security patches only. The end-of-support date is published on a sunset
page at the successor's GA.

**This replaces the stable deprecation-notice rule.** The minimum 6 months'
notice before a removal no longer applies. The rule and the 12-month window
are already in `versioning.mdx` (#8858, merged). When a deprecated node is
modified, its `x-removed-in` major holds.

### 5. Experimental surfaces have a clock

**An experimental surface graduates to stable or is removed within four
minors of the release that introduced it.** A surface introduced in 4.1
graduates or leaves no later than 4.5.

- The graduation criteria of `docs/reference/experimental-status.mdx` are
  unchanged. The clock only adds a deadline.
- Within a major, the existing 6-week notice applies to any breaking change,
  including removal at the deadline. In practice, the decision is due at least
  6 weeks before the deadline release.
- A major counts as one release toward the clock. Like any major, it may
  change or remove an experimental surface without notice.
- A surface that is experimental in 4.0.0, including one carried over from
  3.x, starts its clock at 4.0.0. Its deadline is 4.4.
- The WG may extend one surface's clock once, by up to two minors. The
  decision is recorded and cites production evidence that is already
  accruing.
- Each experimental node records its clock in a field that the lint reads,
  as deprecation does.

**Why four.** Graduation needs 45 days in production, a second implementation
or a production buyer, and 30 days with no open breaking issue. SDK support
and the first production deployment tend to land about a minor after a
surface ships. At 6 to 8 weeks a minor, two minors leave less than the 75 days
one round of evidence needs. Three fit one round but leave no room for a
reshape and its 6-week notice. Four leave room for one reshape.
At the published cadence, with minors every 6 to 8 weeks early in a major and
quarterly later, four minors run from about six months to a year. That is
inside the 18-month minimum between majors, so a surface introduced early in
4.x is decided within 4.x.

### 6. Served-release conformance carries into 4.x unchanged

DR-0024 applies to every 4.x release, with no change:

- A response validates against the published schema of the release it echoes
  in `adcp_version`, `get_adcp_capabilities` and webhook payloads included.
- Newer shapes are projected or omitted.
- A seller that cannot serve a release that way does not list it.
- Negotiation fields keep their shape across the major.

A 4.x seller that still lists 3.3 serves a 3.3 pin the 3.3 shape. In 4.x, the
negotiation fields are `adcp_version` and `adcp.supported_versions` (DR-0035),
and DR-0034's major-only serving rule does not apply.

## Rationale

Several 3.x minors broke buyers built for the previous release (#8501). The
four rules and an additive-minor check with an empty baseline make the minor
promise mechanical from the first 4.x release. The alternative is a list of
grandfathered exceptions.

Closing a schema turns every later addition into a break (DR-0036). A fixed
list of reasons keeps closure to the places where it is the contract. The
`x-closed-reason` annotation lets reviewers and CI check the same thing.

Prose doesn't scale for deprecation. RFC #8756 counts 169 of 216 deprecated
nodes with no removal decision. "Removed in the next major" (`bid_price`,
`max_bid`) slips past the test that matches "removed in 4.0". With the
dispositions in fields, the removal list is a query.

A minimum notice period ties a major's date to its newest deprecation: the
major either waits, or the deprecation is carried to the next one. What
protects an implementer is time on a supported line. A removal reaches it only
when it moves to the new major, and the support window lets it choose when.
The window covers every removal in the major at once.

3.x shows that experiments without a deadline stay experimental. RFC #8756
counts 183 schemas that are experimental at the root with no graduation clock,
and 3.3 graduates no experimental surface.

DR-0024 is what makes open schemas safe. A newer field reaches only a peer
served the release that defines it. Nothing in 4.x weakens it.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Keep 6 months' notice before a removal | It ties the major's date to its newest deprecation, and it protects no one the support window doesn't already protect. |
| Allow removals in a minor after notice | It breaks rule 3 and the minor promise that the check enforces. |
| Close schemas by default, so validators catch misnamed fields | Every addition becomes a break, which is the 3.x failure. The `undefined_properties` conformance check catches misnamed fields without that cost. |
| Judge each closure's structural reason per PR | Reviewers can't apply "structural" consistently. A fixed list with an annotation is something CI can check. |
| Carry the 3.x additive-minor baseline into 4.x | It grandfathers the exceptions the major exists to clean up. |
| Keep removal targets in prose | They can't be enforced, and they already slip past the test. |
| No experimental clock | That is the 3.x state. |
| Two or three minors | Too short for 45 days in production and 30 days of stability after SDK lag. It would remove surfaces that are about to qualify. |
| Six or more minors | Close to a full major, which is the 3.x state again. |
| A clock in months | Minors are where the architecture committee already reviews experimental status. A count of minors ties the deadline to that review. |

## Implications

- **On ratification**, before `4.0.0-beta.1`:
  - `docs/reference/versioning.mdx`: the support window adds corrections to
    its security-only promise.
  - `docs/reference/experimental-status.mdx`: add the clock.
  - Already done: the 6-month deprecation notice is gone from
    `versioning.mdx`, `specification-lifecycle.mdx` and
    `experimental-status.mdx` (#8858, merged).
- **Tooling for 4.0:**
  - `tests/schema-deprecation-metadata.test.cjs` reads the fields, not prose.
  - New checks for `x-closed-reason` and the experimental clock.
  - The additive-minor baseline and corrections register are reset at 4.0.0
    GA.
- **3.x minors and patches don't change.** They never remove. This record
  governs the removals that 4.0 makes of 3.x deprecations.
- **Not settled here:**
  - Support terms for 3.1.x and 3.2.x at 4.0 GA.
  - How `commercial-terms` grows in 4.0. A declared must-understand extension
    point is the expected direction (DR-0036).
  - The removal list, the GA date, signing, and the JSON Schema dialect, which
    RFC #8756 decides by the 2026-12-18 scope freeze.
