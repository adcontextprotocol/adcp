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
- Drops a `type` that includes `"string"` inside `propertyNames`, because
  property names are strings.
- Compares regex `pattern` values in a canonical spelling: `\d` is `[0-9]`,
  and a bracket class is a sorted set of code-point intervals. A pattern that
  the tokenizer does not fully understand stays as written.

The canonical form keeps `format` and Ajv's `discriminator`, which changes how
Ajv evaluates `oneOf`: non-objects pass, and an object is checked only against
the branch its tag selects.

`default`, `x-*` annotations, and keywords that Ajv ignores under
`strict: false` (such as `enumDescriptions`) never affect the verdict. The
tool reports their differences in a separate informational channel.

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
or changes. No file means that no difference is intended.

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
- `direction`: `tighten` (some payload the base accepts, the head rejects),
  `loosen` (the reverse), or `both`. The direction describes the combined
  change at the node: a removed `maxLength` next to an added `pattern` can
  loosen nothing.
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

Probe values have no declared schema: every distinct JSON value in
`static/compliance/source/` (test vectors, storyboards, and test kits),
`static/test-vectors/`, and `static/examples/`. The tool probes a changed site
with a value only when the value appears under a property name that the roots
reach that site under. A probe hit is a real value that the changed
constraint treats differently; it is reported but does not fail the check.

The tool excludes the following sources:

- Steps whose `schema_ref` is `$test_kit.*`, because the runner chooses the
  schema.
- Docs blocks with `...` placeholders or invalid JSON, as the docs test skips
  them.
- `*.schema.json` files, which are schemas for vectors, not payloads.
- Storyboard substitution strings such as `$context.x` in probe values.
- `dist/`, which holds release records, not authored payloads.

## Witnesses

`--witness` searches, for each manifest site, one payload that the base
accepts and the head rejects, and one for the reverse. The search starts from
corpus instances of the root and from an instance synthesized from the raw
schema along the entry's pointer. At the location the pointer names, it tries
values derived from the change (values around a bound, the values an enum
gained or lost, strings that one pattern accepts and the other rejects, a
property that became required removed, the added or removed branch), then
values of every JSON type. Ajv with the repo configuration confirms every
witness on both roots.

A site passes when the directions found equal the directions declared. A
`tighten` site needs a tightening witness and fails if the search finds a
loosening one. The search is not exhaustive: a missing witness is not a
proof that no such payload exists.

## Limits

- A difference the normalizations do not cover shows as a difference, never
  as equivalence. Regex equivalence beyond class spelling, `not` simplification,
  and integer and number type merging are some examples.
- A relative `$ref` under a nested `$id` stops the tool with an error. The
  source tree has none.
- Probe hits match on property names, so a generic name such as `description`
  can pair a value with an unrelated schema.

## Tests

`tests/schema-equivalence.test.cjs` runs the CLI on each fixture pair in
`test/fixtures/`. Each pair differs for exactly one reason, which its
`expect.json` states in `why`. Run the tests with
`npm run test:schema-equivalence`.
