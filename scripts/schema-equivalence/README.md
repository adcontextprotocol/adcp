# Schema equivalence check

This tool proves what a schema change does to the set of valid payloads. It
compares every published schema root at two refs and reports each difference
as `(root, pointer, keyword, old, new)`. A change is in one of three proof
classes:

- **Class 1, restructuring.** The canonical forms are identical.
- **Class 2, meaning-preserving rewrite.** The canonical forms are identical
  after guarded rewrite rules whose preconditions hold.
- **Class 3, deliberate constraint change.** The differences equal the PR's
  delta manifest exactly, no corpus instance changes verdict, and every
  manifest line has a witness payload.

## Run the check

```bash
# The branch against its merge base with origin/main
node scripts/schema-equivalence/cli.cjs

# Two refs, with the PR's delta manifest, the corpus, and witnesses
node scripts/schema-equivalence/cli.cjs --base origin/main --head HEAD \
  --manifest auto --corpus --witness --json report.json

# Write a manifest skeleton for the current differences, then edit it
node scripts/schema-equivalence/cli.cjs --write-manifest .schema-deltas/my-change.yaml

# Check that the build publishes the source unchanged (run the build first)
npm run build:schemas
node scripts/schema-equivalence/cli.cjs verify-build
```

The exit status is 0 when the check passes, 1 when it fails, and 2 for a usage
or tool error. Run `--help` for every option.

## The oneof check

`oneof` proves or refutes every `oneOf` that the published roots reach at one
ref, through any number of `$ref`s, and gives each one of three results:

- **P, proved.** The tool proves every branch pair disjoint (see the rules
  under "Guarded rewrite rules"), under the context where the `oneOf` is
  evaluated, and names the rules it used. A `oneOf` with one branch is P, and
  so is one under an Ajv `discriminator` that compiles: Ajv checks an object
  against the one branch its tag selects and lets non-objects pass, so an
  overlap cannot reject a payload.
- **W, witnessed.** A payload matches two or more branches. Ajv, with the
  repo options and every schema registered, rejects it at the `oneOf` with a
  single `oneOf` error, and each branch Ajv names accepts the payload on its
  own. The search builds candidates from the branch schemas: instances of each
  branch (guided through the `oneOf`, from the branch alone, with a few enum
  choices, and with one optional property at a time), each pair of them merged
  in both orders, and plain values of every JSON type. The witness is
  minimized by deleting keys while it stays a witness.
- **U, undecided.** Neither.

```bash
node scripts/schema-equivalence/cli.cjs oneof --ref origin/main
node scripts/schema-equivalence/cli.cjs oneof --ref HEAD --report-only --json oneof.json
```

The check exits 1 when any result is W or U, and `--report-only` prints the
same table and exits 0. It has no baseline and no allowlist. The table is
Markdown, so CI appends it to the job summary.

The context matters for P. A `oneOf` whose branches overlap only on values
that an enclosing schema rejects is P: in
`compliance/comply-test-controller-request.json`, the branches of
`allOf/11/then/properties/params/oneOf` both accept `0`, but the root's
`properties/params` has `type: object`, so no payload reaches the `oneOf`
with a non-object.

This check is a proof-based replacement for `scripts/audit-oneof.mjs`, which
classifies each `oneOf` from the required names of its branches and follows
one `$ref` hop. The audit's "narrowable" verdict (each branch has a required
key of its own) does not stop a payload from carrying both keys, and its
"dangerous" verdict is often a set of branches that `not`, closed objects, or
nested tags separate. `oneof` decides each case with a proof or a payload.

## How the tool reads each ref

The tool reads `static/schemas/source/**` at each ref straight from the git
object database (`git ls-tree` and one `git cat-file --batch` call), so it
needs no worktree. A `$ref` to a released schema
(`https://adcontextprotocol.org/schemas/<version>/...`) resolves to
`dist/schemas/<version>/...` at the same ref.

The source tree is what the build publishes. `scripts/build-schemas.cjs`
copies each source file to `dist/schemas/<version>/` and changes only the
spelling of `$id`, `$ref`, and `$schema` URIs, which resolve to the same
schemas. The `verify-build` command checks this claim: it compares the
source tree with `dist/schemas/latest/` and with the fully dereferenced
`dist/schemas/latest/bundled/` schemas, and reports any semantic difference.

Every `*.json` file except `index.json` registries is a published root. A
root that only the head has is listed under `addedRoots` and is not a
difference, because it changes no existing root's payloads. A removed root is
a difference.

## Canonical form

The canonical form models how the repo's Ajv configuration validates:
`new Ajv({ allErrors: true, strict: false, discriminator: true })` with
`addFormats(ajv)`, JSON Schema draft-07. At load time the tool fails if Ajv
registers a validation keyword that the canonical form does not classify.

Each schema location (document and JSON pointer) is one graph node, and a
`$ref` is an edge to its target. Two roots are equivalent when their graphs
are bisimilar. Partition refinement computes this with an exact signature
table, so there are no hash collisions. Recursive schemas are finite graphs,
the comparison never loops, and a recursion that a change enters at a
different place still compares equal.

The tool applies the following normalizations. Each one keeps the set of
valid payloads the same, and each has a fixture under `test/fixtures/`:

- Drops `title`, `description`, `examples`, `$comment`, `$id`, `$schema`,
  `definitions`, `$defs`, `deprecated`, `readOnly`, and `writeOnly`.
- Treats `$ref` with sibling keywords as the conjunction of the target and the
  siblings (Ajv 8 applies the siblings in draft-07).
- Flattens nested `allOf`, drops `true` members and duplicate members, and
  treats `allOf` members as a set. A one-member conjunction is its member.
- Merges conjunction members (`allOf` members, or a `$ref` target and its
  siblings) into one schema object where the merge keeps the meaning, so a
  schema split across members equals the same keywords in one object. The
  result does not depend on the order of the members or on how `allOf`
  groups them. Each member is taken apart into its value keywords, its
  `properties`, and its other subschema keywords. Value keywords combine:
  `required` is the union; the same bound takes the tighter value
  (`maxLength`, `maxItems`, `maxProperties`, `maximum`, `exclusiveMaximum`:
  the smaller; their `min` counterparts: the larger); `type` is the
  intersection. Values that do not combine (two patterns) stay separate
  conjuncts. Properties combine by name, and the same property in several
  members becomes the conjunction of their schemas. A subschema keyword joins
  the merged object only when the conjunction has one of it; otherwise each
  stays its own conjunct (two `not`s, two `oneOf`s, two `if`/`then`/`else`
  groups). Keywords that read each other move together: `if` with `then` and
  `else`, `additionalProperties` and `patternProperties` with the same
  object's `properties` (which join the merged object only when no other
  member declares properties), and `items` with `additionalItems`. A member
  with `discriminator` or `nullable` stays whole. A merged node reports each
  keyword at the source object that writes it.
- Treats a one-branch `anyOf` or `oneOf` as its branch, except a `oneOf`
  under `discriminator`.
- Sorts `anyOf` branches as a set and `oneOf` branches as a multiset (a
  duplicated `oneOf` branch changes the meaning, so the tool keeps it).
- Treats `type` as a sorted set (`"x"` equals `["x"]`) and `enum` and
  `required` as sorted sets. A one-value `enum` equals `const`.
- Treats `required: []`, `minLength: 0`, `minItems: 0`, `minProperties: 0`,
  and `uniqueItems: false` as absent.
- With `type: integer`, reads `exclusiveMinimum: n` as `minimum: ⌊n⌋ + 1`
  and `exclusiveMaximum: n` as `maximum: ⌈n⌉ − 1`. Ajv compares numbers as
  doubles, so the rule fires only when n and the result are safe integers
  (|x| ≤ 2^53 − 1).
- Keeps only the tighter of `maximum` and `exclusiveMaximum`, and of
  `minimum` and `exclusiveMinimum`, when a schema object has both.
- Treats `not: {not: X}` as X, also when either `not` operand is reached
  through a `$ref`.
- Drops `type` next to `const` or `enum` when every allowed value has one of
  the listed types.
- Treats `additionalProperties`, `additionalItems`, `items`, `propertyNames`,
  `then`, and `else` as absent when their subschema is `true`. Drops `then`
  and `else` without `if`, and `if` without `then` or `else`.
- Drops keywords for a JSON type the node does not allow (`minLength` on a
  `null`-only node), and splits a node that allows several types and has
  type-specific keywords into one `anyOf` branch per type.
- Merges an `anyOf` whose branches only list values (`const` or `enum`) into
  one `enum`. A `oneOf` merges only when its value sets do not overlap.
- Reads the subgraph under `propertyNames` in a string-instance context,
  because property names are strings. The context passes through `allOf`,
  `anyOf`, `oneOf`, `not`, `if`, `then`, `else`, and `$ref`. In it, a
  `type` that includes `"string"` is dropped, a `type`, `const`, or `enum`
  that admits no string makes the node `false`, keywords for other types are
  dropped, and `false` union branches are removed. A `discriminator` and the
  `oneOf` it governs are dropped too: Ajv checks a discriminator only on
  objects and then skips the `oneOf`. The tool builds context
  copies, so a shared target keeps its meaning in value positions.
- Compares regex `pattern` values in a canonical spelling: `\d` is `[0-9]`,
  and a bracket class is a sorted set of code-point intervals, read as Ajv's
  `u` flag reads it (a literal `-` can be a range endpoint, as in `[--/]`,
  and `\uD83D\uDE00` is one code point). A pattern that
  the tokenizer does not fully understand stays as written.

The canonical form keeps `format` and Ajv's `discriminator`, which changes how
Ajv evaluates `oneOf`: non-objects pass, and an object is checked only against
the branch its tag selects.

`default`, `x-*` annotations, and keywords that Ajv ignores under
`strict: false` (such as `enumDescriptions`) never affect the verdict. The
tool reports their differences in a separate informational channel. An
annotation written beside a `$ref` or `allOf` belongs to that location: the
tool compares a location's members' annotations together, with the ones
written beside the `$ref` overriding the target's.

## Guarded rewrite rules (class 2)

Each rule fires only when a mechanical precondition proves that the rewritten
node accepts the same payloads. When a precondition fails, the node stays as
written and the difference stays in the report.

The tool proves two branches disjoint (`lib/disjoint.cjs`) when one of the
following holds. Each rule reads facts that hold for every instance: the
branch's own keywords, its conjunction members' keywords, and the context of
the node that holds the union.

- **Types.** Their possible JSON types do not overlap. `integer` is inside
  `number`, `const` or `enum` narrows the type, and a `not` over a schema that
  accepts every value of a type removes that type: `not: {required: [k]}`
  accepts only objects, because `required` holds for every non-object.
- **Values.** Their `const` or `enum` value sets do not overlap.
- **Tag values.** Both branches only admit objects, a property is required in
  both (or by the context), and that property's `const` or `enum` value sets
  do not overlap. The object-only condition matters: `required` says nothing
  about a string, so a string satisfies two object branches that lack
  `type: object`.
- **Property schemas.** Both only admit objects, a property is required in
  both, and the tool proves the property's two schemas disjoint.
- **Closed object.** Both only admit objects, one branch requires a key, and
  the other forbids it: a schema object with `additionalProperties: false`
  whose own `properties` and `patternProperties` (compiled with Ajv's `u`
  flag) do not allow the key, or a `false` property schema. Only the same
  schema object's `properties` count, because `additionalProperties` sees no
  other; the canonical form never merges another member's `properties` into
  such an object.
- **Not over an implied schema.** Every instance of one branch satisfies a
  schema that the other branch negates with `not`: its required keys, a
  property value that the `not` operand pins (`not: {required: [k],
  properties: {k: {const: v}}}` against a branch that requires `k` with
  `const: v`), or the same referenced schema. Implication is structural: each
  keyword of the operand needs the same or a tighter keyword in the branch, or
  must be vacuous for the branch's types, and a `$ref` with siblings needs
  every part. A pinned value counts only for a key the branch requires.
- **Not over each alternative.** One branch needs one of several alternatives
  (`anyOf`, or `oneOf` without `discriminator`), and every alternative implies
  the other branch's `not` operand.
- **Finite values.** One branch allows finitely many values, and an evaluator
  shows that the other branch rejects each of them. The evaluator follows
  Ajv: a keyword for another JSON type passes, `pattern` uses the `u` flag,
  lengths count code points, and `format` uses ajv-formats' full definitions.
  Anything it cannot decide counts as a pass.
- **Array items.** Both only admit arrays, one needs at least one item, and
  the tool proves the two `items` schemas disjoint.

The context of a node is what every instance that reaches it satisfies
(`lib/context.cjs`). It flows from a conjunction to its members, from a schema
object to its union branches, `not`, `if`, `then`, and `else`, and to
`properties/<name>` as the facts every schema of the parent instance gives
that property (a sibling `allOf` member's `properties/p: {type: object}`
reaches `then/properties/p` of another member). A node reached along several
paths gets the join of their contexts, so a rewrite made under it holds at
every use.

The rules are the following:

- `oneOf-to-anyOf`: a `oneOf` over pairwise-disjoint branches is an `anyOf`.
- `discriminator-to-anyOf`: `discriminator` with `oneOf` is an `anyOf` when the
  enclosing node only admits objects and Ajv accepts the discriminator. The
  tool checks Ajv's conditions on the raw source, as Ajv does: every branch has
  `properties/<tag>` with `const` or `enum` of unique strings, and the tag is
  required.
- `not-branch-subtraction`: `allOf: [U, {not: B}]`, where the union `U` has a
  branch equal to `B` and every other branch is disjoint from `B`, is `U`
  without that branch.

The report lists every rule application with its proof.

## Report

A difference entry has the following fields:

- `root` and `root_id`: the root file and its `$id`.
- `pointer`: the path from the root to the schema node that holds the
  keyword, through inlined `$ref`s. The `$ref` segments stay in the path so a
  reader can follow it. Branch indexes are source indexes on the head side,
  or on the base side for something the head removed.
- `keyword`, `old`, and `new`. `old` or `new` is omitted when the keyword is
  absent on that side. Subschemas render two levels deep.
- `base_location` and `head_location`: the source location of the node on
  each side.

A `oneOf` that a rule rewrites to `anyOf` on one side only is still compared
as the source's `oneOf`, so a change inside its branches (a `not` guard that
made them disjoint) is reported where it was written. When the branches match,
the union keyword itself is the difference. A union that a rule rewrote is
always reported and rendered under the keyword its source wrote, so a
manifest line does not change when a rule starts to fire inside it.

The text report groups entries by site: one source location, keyword, and
change, with the roots it reaches. The JSON report (`--json`) has every entry.

## Delta manifest

A PR that changes constraints on purpose adds a YAML file under
`.schema-deltas/`. `--manifest auto` reads every file there that the head adds
or changes, from the head ref's git objects, so the head does not have to be
checked out. No file means that no difference is intended.

```yaml
title: Bound the domain name length (#8905)
changes:
  # One site, every root that reaches it
  - location: core/domain-name.json#
    keyword: maxLength
    new: 253
    direction: tighten
    side: both
  # One root and pointer
  - root: /schemas/media-buy/create-media-buy-request.json
    pointer: /properties/po_number
    keyword: maxLength
    old: 200
    new: 100
    direction: tighten
    side: request
```

Each entry has the following fields:

- `location` (a source location, as the report prints it) or `root` with
  `pointer`.
- `keyword`, `old`, and `new`, exactly as the report prints them. Omit `old`
  or `new` when the keyword is absent on that side.
- `direction`: `tighten` (because of this line, some payload the base
  accepts and the head rejects), `loosen` (the reverse), `both`, or `none`.
  Use `none` for a line whose effect another line at the same node masks: a
  removed `maxLength: 2` next to an added `pattern: ^[A-Z]{2}$` changes no
  payload's verdict on its own.
- `side`: `request`, `response`, `both`, or `none`, from the names of the
  affected task roots (`*-request.json`, `*-response*.json`).
- `note`: optional free text.

The check passes only when the manifest and the differences match exactly. A
difference that no entry covers fails, and an entry that covers no difference
fails. For a site where only one keyword changed and its effect is monotone
(a bound, an enum subset, `required`), the tool also checks the declared
direction.

## Corpus differential

`--corpus` validates real payloads against both refs and reports every
instance whose verdict changes, for the roots that differ. `--corpus-all`
validates every bound instance, which cross-checks the canonical form: an
equal root must give equal verdicts.

The tool validates the following bound instances against the schema they name:

- `examples` in schemas at both refs, against the enclosing subschema. A
  `{ description, data }` wrapper contributes its `data`.
- Fenced `json` blocks in `docs/` that carry a `$schema`, with macros
  replaced and `$schema` removed, as `tests/json-schema-validation.test.cjs`
  does.
- Storyboard `sample_request` values against `schema_ref`, with runner
  substitutions replaced as `scripts/lint-storyboard-sample-request-schema.cjs`
  does, and `sample_response` values against `response_schema_ref`.
- `static/examples/` fixtures with a known schema: `products/canonical`,
  `get_products_responses/canonical`, `adagents`, and `brand-json`.

Unbound probe values have no declared schema: every distinct JSON value in
`static/compliance/source/` (test vectors, storyboard fixtures, and test
kits), `static/test-vectors/`, and `static/examples/`, outside the bound
samples. Values inside a bound sample are left out, because the bound
differential validates them in their real context. The tool probes a changed
site with a value only when the value appears under the same parent property
and property that the roots reach the site under (`selector.system`, not
`geo.system`). An unbound probe hit is a heuristic, not evidence: the report
lists it, and it never fails the check.

In directory mode, `--corpus` reads the non-schema corpus from this
repository's `HEAD`, and `--corpus-dir` reads `{ "schema": "rel#ptr", "instance": ... }`
files as bound instances and `{ "probe": ... }` files as documents of unbound
values.

The tool excludes the following sources:

- Steps whose `schema_ref` is `$test_kit.*`, because the runner chooses the
  schema.
- Docs blocks with `...` placeholders or invalid JSON, as the docs test skips
  them.
- `*.schema.json` files, which are schemas for vectors, not payloads.
- Storyboard substitution strings such as `$context.x` in probe values.
- `dist/`, which holds release records, not authored payloads.

## Witnesses

`--witness` gives each manifest line its own witness: a payload whose verdict
differs between base and head in the declared direction because of that line.
The tool builds a hybrid head where only that line's keyword is reverted at
its site, and accepts a payload only when the hybrid gives it the base verdict
again. The search runs over the line's own roots and pointers, so a line
cannot pass on a neighbouring line's payload, and a line that changes nothing
finds no witness. A line declared `none` passes only when no witness is
attributed to it. A line whose keyword comes from a normalization rather than
the source cannot be reverted, and fails with that reason.

A line's constraint can reach its site through a `$ref`: a site that wrote a
schema inline now names a definition that carries the constraint, so the
line's location is the definition and the base location is the inline
schema. The revert then holds for that referencing site only. The hybrid head
gets a private copy of the definition's document with the keyword reverted,
and only the site's `$ref` names the copy; for a chain of `$ref`s that leads
to the definition, each document of the chain is copied. The definition's
other users keep the head's schema. A keyword whose value holds subschemas
(`properties`, `anyOf`, `oneOf`, `not`, and the others) comes back as the base
wrote it, and its `$ref`s keep naming what they named in the base: each
becomes an absolute `/schemas/...` reference, to a copy of the base document
when the head no longer has the target (a local definition the change moved
out). A `properties` entry whose pointer ends at the node, not at one
property, adds or removes the whole map.

The search starts from corpus instances of the root and from an instance
synthesized from the raw schema along the entry's pointer. A property that one
`allOf` member declares, also behind the member's `$ref`, gives its schema to
the other members, so a member that only requires the property gets a valid
value. An object with `minProperties` gets optional properties, then names
its `patternProperties` or `additionalProperties` admit.

Each synthesized instance is also conformed to the whole root, and both
versions are tried. Conforming evaluates the raw schema (draft-07, as the
repo's Ajv configuration applies it) and edits the instance where a local edit
can satisfy it: the values `const` and `enum` pin, the properties `required`
asks for, a valid value for a property of the wrong type, no property a
closed object forbids, and the union branch the instance fits. Branches are
tried with the one the pointer names first, then by how few of their pinned
values the instance contradicts, so a value an `allOf` member pins keeps the
branch it selects in the other member's `oneOf`. An `if` elsewhere in the
root gets the `then` or `else` it selects; when that branch cannot hold (a
`then` that forbids the property on the path), the condition is flipped by
dropping a property the `if` requires, or by satisfying the `if`. The
instance path the pointer names is never dropped. Pattern candidates
come from both patterns: minimal and extended samples, one optional part at a
time (a duration pattern gives `PT` and `P0D`), and long repetitions.
Lookaheads and lookbehinds generate nothing; the real `RegExp` filters the
samples. One reverted head per referencing site, compiled lazily, serves the
line's roots that reach the site from there.

The search also builds candidates from the changed constraint itself and
merges them into the valid instance at the location:

- For an added `not`, an instance of the negated schema. For a guard on an
  either/or pair (`not: {required: [k]}`), the key `k` with a value of each
  JSON type, so the base matches exactly one branch and the head none.
- For an added `if`/`then`, an instance that satisfies `if` and violates
  `then`: wrong-typed values, and values that another branch of the
  property's own schema accepts (video requirements on an image).
- For a `properties` map added or removed as a whole, objects whose
  properties take a value of each JSON type.
- For a schema that gains constraints where it had none, a value of each JSON
  type. At the location the pointer names, it tries
values derived from the change (values around a bound, the values an enum
gained or lost, strings that one pattern accepts and the other rejects, a
property that became required removed, the added or removed branch), then
values of every JSON type. More candidates come from the changed keyword:

- For `maxLength` or `minLength` at a location with a `format` or `pattern`,
  strings of the lengths around the bound that keep the format: one character
  of the valid string repeated or removed at each position (an email address
  made long in its local part).
- For a union added or removed as a whole, the instance without each
  property a branch requires, and without all of them.
- For an added or changed `oneOf`, objects that two of its branches accept,
  which the `oneOf` rejects.
- For `uniqueItems`, the array with its first item repeated.
- For `additionalProperties`, the object with one more property, of each
  JSON type.
- For `minProperties` or `maxProperties`, objects with property counts
  around the bound, made from the instance's properties and copies of its
  first value.

Ajv with the repo configuration confirms every witness on both roots.

Each site is also searched in both directions without attribution. A
direction found there that no line at the site declares fails every line at
the site. The search is not exhaustive: a missing witness is not a proof that
no such payload exists.

## Limits

- A difference the normalizations do not cover shows as a difference, never
  as equivalence. Regex equivalence beyond class spelling, `not` simplification,
  and integer and number type merging are some examples.
- A relative `$ref` under a nested `$id` stops the tool with an error. The
  source tree has none.
- Unbound probe hits match on parent and property names, so two unrelated
  schemas that share both names can still collide.

## Tests

`tests/schema-equivalence.test.cjs` runs the CLI on each fixture pair in
`test/fixtures/`. Each pair differs for exactly one reason, which its
`expect.json` states in `why`.

`tests/schema-equivalence-catalog.test.cjs` runs the CLI on every pair of the
construct catalog in `test/catalog/`, whose verdicts were decided without the
tool. A pair that is not equivalent must get a difference; an equivalent pair
must get none unless `test/catalog/false-alarms.json` lists it. See
`test/catalog/README.md`.

The same file runs the `oneof` command on the fixtures in
`test/oneof-fixtures/`, one directory per result (P, W, and U) and one with
names that need escaping in a Markdown table, with and without
`--report-only`. Each row of the Markdown table must read back as its site's
location and witness.

Run both with `npm run test:schema-equivalence`.
