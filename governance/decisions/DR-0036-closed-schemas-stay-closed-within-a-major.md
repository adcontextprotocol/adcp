---
id: DR-0036
title: Schemas are open within a major; a schema is closed only for a structural reason
class: normative
status: ratified
date: 2026-11-09
decided: 2026-11-09
decided_by: WG session 2026-11-09
refs: ["#8501", "#7224", "PR #8704", "PR #8777", "PR #8519", "DR-0009", "DR-0019", "DR-0024"]
supersedes: DR-0019
dissent: none recorded
---

## Decision

A schema is **closed** when it sets `additionalProperties: false` or
`unevaluatedProperties: false`. A validator rejects any property that a closed
schema doesn't list. Every other schema is **open**.

**Schemas are open by default, in every major.** This holds for 3.x and 4.x.
Within a major, the rules on the versioning page (PR #8704) decide what a
release may change. A minor only adds, and new fields go on open schemas.

**A schema is closed only for a structural reason.** Three reasons qualify:

- **Disjoint branches.** The schema is a `oneOf` branch, and closing it keeps
  an instance from matching more than one branch.
- **A closed key set or vocabulary.** Consumers join, reconcile, or dispatch on
  the full set of keys, so an unknown key is a correctness hazard.
- **A signed or binding payload.** An extra key would change what is signed or
  what a party is bound by. `commercial-terms`, which `terms_digest` signs, is
  one.

The PR that closes a schema, or keeps one closed, names its reason. Catching
misnamed fields is not a reason to close a schema. The conformance runner's
`undefined_properties` check reports them instead.

**3.x schemas that were closed without a structural reason are opened, as a
correction.** Opening a schema rejects nothing that was valid before. 3.3 opens
them. A patch of each maintained earlier line opens them too: 3.2.x, and 3.1.x
where needed. From the release that opens it, the schema is open, and a later
minor adds to it like any open schema.

**A schema that stays closed changes only in a major.** No minor adds a
property to it. No release in a major closes a schema that the major published
open (DR-0009). A feature that needs a new property on a closed schema puts the
property on an open schema or waits for the next major.

**The rule covers stable schemas.** An experimental schema changes under the
experimental status contract (`docs/reference/experimental-status.mdx`).

### Corrections

A correction makes a schema match what the published text of the major already
says. It may ship in a minor, and in a patch of an earlier minor of the same
major. There are two kinds:

1. **Opening a schema that was closed without a structural reason,** as above.
2. **Bounding a concept as the published text bounds it.** When the published
   text of the major gives a concept a bound or a required name, that bound or
   name holds wherever the concept appears. The text can be prose, a schema of
   the major that defines the concept, or an external standard that the text
   names. No conforming peer sends a value outside the bound, so the correction
   rejects nothing a conforming peer sends.

Each correction that the additive-minor check would otherwise report is an
entry in `scripts/lint-additive-minor-corrections.json`. The entry names the
schema, the JSON pointer, the change, the release it lands in, and the
published text it rests on, quoted. The check accepts exactly the listed
changes. A PR that adds an entry is reviewed against this record. The record
itself doesn't list entries.

## Rationale

Closing a schema gives one thing: a strict validator rejects a key the schema
doesn't list. Across releases, that turns every addition into a break, exactly
like a removal. A closed object can't grow in a minor. That is why 3.3 had to
withdraw or move features whose parent object happened to be closed (#8501).

Opening a schema breaks no peer that follows the protocol. Senders send a
newer field only to peers served that release (DR-0024), and readers ignore
fields they don't know. A validator that hard-codes an earlier release's closed
schema does reject the newer field. The WG accepted that cost so that minors
can add to the objects that need to grow. The patch backports reduce the cost:
a validator on the latest patch of a maintained line accepts the opened
schemas.

A structural reason is different, because there the closure is the contract.
Opening a `oneOf` branch can let an instance match two branches. A new key on a
join-key object changes the join. A new term in a signed payload changes what a
party agreed to. Those schemas stay closed, and a change to them waits for a
major.

The rewrite in PR #8777, by Konstantin Mirin, set the shape of this record. It
states the decision and leaves the entries to the register, and it defines the
correction that bounds a concept. Those parts are reused here. His rules in
PR #8704 decide what a minor may change; this record decides only which schemas
are open.

Source: the WG session of 2026-11-09. An earlier draft of this record, proposed
on 2026-10-27 after WG Session C (#8501), held the opposite rule: a closed
schema stays closed for the whole major, and only recorded corrections may
change it. That draft was never ratified. This record replaces it.

## Implications

- **DR-0019 is superseded.** Its two classes no longer decide which schemas may
  be closed; the structural reasons above do. A class B row envelope is opened
  and keeps its escape hatch. A class A object stays closed only when its key
  set is one of the structural reasons. DR-0019 itself said that opening the
  row family or everything (#7224 options B and C) would supersede it. Its
  consequences that opening is non-breaking and closing is breaking (DR-0009)
  still hold.
- **The schemas that 3.3 opens, and those it keeps closed with their reasons,
  are listed in the PR that opens them.** The 3.2.x backport opens the same
  set.
- **Features withdrawn from the 3.3 betas only because their parent schema was
  closed can return in 3.3.** Features withdrawn for another reason stay
  withdrawn. The #8501 re-triage records which is which.
- **New fields go only to peers that negotiated them**, including fields on
  schemas opened in 3.3 (DR-0024). A request that names only the major is served
  the oldest supported release (DR-0034), so it never gets them.
- **The additive-minor check follows this record.** It accepts opening a
  schema, and a property added to a schema the candidate leaves open. It still
  fails closing a schema, a property added to a schema that stays closed, and a
  removal, rename, retype, removed enum value, tightened bound, or newly
  required name, apart from the listed corrections.
- **4.x starts from the same rule.** 4.0 may break, but it closes a schema only
  for a structural reason.
- **Not settled here:** how `commercial-terms` grows in 4.0. A declared
  extension point with must-understand semantics is the expected direction.
