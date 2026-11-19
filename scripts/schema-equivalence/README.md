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
- Treats a one-branch `anyOf` or `oneOf` as its branch, except a `oneOf`
  under `discriminator`.
- Sorts `anyOf` branches as a set and `oneOf` branches as a multiset (a
  duplicated `oneOf` branch changes the meaning, so the tool keeps it).
- Treats `type` as a sorted set (`"x"` equals `["x"]`) and `enum` and
  `required` as sorted sets. A one-value `enum` equals `const`.
- Treats `required: []`, `minLength: 0`, `minItems: 0`, `minProperties: 0`,
  and `uniqueItems: false` as absent.
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
  dropped, and `false` union branches are removed. The tool builds context
  copies, so a shared target keeps its meaning in value positions.
- Compares regex `pattern` values in a canonical spelling: `\d` is `[0-9]`,
  and a bracket class is a sorted set of code-point intervals. A pattern that
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

The tool proves two branches disjoint when one of the following holds, using
the branch's top-level keywords and the keywords of the node that holds the
union:

- Their possible JSON types do not overlap. `integer` is inside `number`, and
  `const` or `enum` narrows the type.
- Their `const` or `enum` value sets do not overlap.
- Both branches only admit objects, a property is required in both (or by the
  enclosing node), and that property's `const` or `enum` value sets do not
  overlap. The object-only condition matters: `required` says nothing about a
  string, so a string satisfies two object branches that lack `type: object`.

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

In directory mode, `--corpus-dir` reads `{ "schema": "rel#ptr", "instance": ... }`
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

The search starts from corpus instances of the root and from an instance
synthesized from the raw schema along the entry's pointer. Pattern candidates
come from both patterns: minimal and extended samples, one optional part at a
time (a duration pattern gives `PT` and `P0D`), and long repetitions.
Lookaheads and lookbehinds generate nothing; the real `RegExp` filters the
samples. One reverted head, compiled lazily, serves all of a line's roots. At the location the pointer names, it tries
values derived from the change (values around a bound, the values an enum
gained or lost, strings that one pattern accepts and the other rejects, a
property that became required removed, the added or removed branch), then
values of every JSON type. Ajv with the repo configuration confirms every
witness on both roots.

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
`expect.json` states in `why`. Run the tests with
`npm run test:schema-equivalence`.
