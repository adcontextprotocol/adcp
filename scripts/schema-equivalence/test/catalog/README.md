# Construct catalog

This catalog tests the schema equivalence check, not the AdCP schemas. Each
pair is a base and a head schema tree with a verdict that was decided without
the tool. `tests/schema-equivalence-catalog.test.cjs` runs the CLI in
directory mode on every pair and compares its result with the verdict:

- A pair that is not equivalent must get at least one difference entry for
  its root. A pair without one is a miss: a false "equivalent".
- An equivalent pair must get no difference, unless `false-alarms.json` lists
  it with its cause. A listed pair must still get a difference, so the list
  stays exact when the tool improves.
- Every stored witness must still be valid on one side and invalid on the
  other under the repo's Ajv configuration.

The catalog is fixed data. The test never regenerates it.

## What the pairs cover

The pairs enumerate the JSON Schema constructs the AdCP bundle uses, and their
combinations, instead of sampling them:

- `rules/`: every normalization the tool applies (see the tool README). Each
  has pairs where the rule must fire, placed in every context the bundle uses
  (top level, inside `allOf`, under `not`, behind a `$ref` to another file,
  inside a recursive definition, inside a `discriminator` branch), and near
  misses where it must not fire, at the top level and under `not`.
- `branches/`: the class 2 rewrite rules and branch separation by `const`, by
  `discriminator`, by `type`, by `required` plus `not` `required`, and by
  nothing, with near misses. `disjointness-rules.json` has, for each rule of
  the disjointness prover, a `oneOf` that the rule makes equivalent to `anyOf`
  and a near miss that must stay different (a pattern that allows the key, a
  pinned value that may be absent, a `$ref` with siblings under `not`, a
  keyword for another type, an empty array).
- `references/`: `$ref` with sibling keywords, to another file, recursive,
  extracted, inlined, through an alias file, and spelled the same on both
  sides for different files.
- `nestings/`: the combinator nestings by bundle frequency (`$ref` with
  annotation siblings, `if` with siblings, `anyOf`, `allOf` with siblings,
  `not`, `oneOf` with `discriminator`, `allOf` with `oneOf`, `anyOf`, `not` or
  `if`, and `oneOf` inside `allOf` with a sibling `not`), each with an
  equivalent restructuring and a minimal tighten and loosen.
- `keywords/`: a minimal tighten and a minimal loosen for every assertion
  keyword in the bundle, at the top level and behind a `$ref`.
- `opaque/`: the constructs the tool compares exactly (`format`, pattern
  languages, numeric bounds, the `discriminator` object, `patternProperties`
  keys, `contains`, `not`, `if`/`then`/`else`, `uniqueItems`,
  `dependencies`). Real changes must be reported; equivalent rewrites are
  allowed false alarms and are listed in `false-alarms.json`.

A pair record has `id`, `rule`, `context`, `root`, the `base` and `head`
files (each with its `$id`), `verdict` (`equivalent`, `base_in_head`,
`head_in_base`; `null` where a hand verdict leaves a direction open),
`decided_by`, `manual_reason` for hand verdicts, and `witnesses`: payloads
with their validity on each side.

## How the verdicts were decided

`../catalog-generator/generate.cjs` builds the pairs from
`../catalog-generator/pairs.cjs` and decides each one. The tool under test
plays no part.

- **Oracle verdicts (`decided_by: oracle`).** Inclusion in both directions
  was decided by the refutational-normalization prototype (Baazizi, Ben Ali,
  Colazzo, Ghelli, Klessinger, Sartiani, Scherzinger, arXiv 2603.25306;
  https://gitlab.lip6.fr/benali1/refutationalnormalizationforjsonschema),
  commit `8064ad83a0dbdb4b02c0ce1632d273f7cbf736cf`, run offline as an
  external process. Its input is `{"allOf": [S1, {"not": S2}]}`: `unsat` means
  S1 is included in S2, and `sat` comes with a witness in S1 and not in S2.
  `../catalog-generator/oracle-bundle.cjs` writes each problem with one
  top-level definition per `$ref` target and side, because the prototype's own
  file resolution merges refs that are spelled the same. It also translates
  Ajv's `discriminator` into the formula Ajv evaluates, since the prototype
  ignores the keyword.
- **Hand verdicts (`decided_by: manual`).** The prototype differs from Ajv on
  `format` (ignored), astral characters (counted as two units), `.` (matches a
  newline), and lookahead (refused), and it is incomplete for `uniqueItems`.
  Pairs with any of these carry a hand verdict with its reason. Every
  non-inclusion a hand verdict claims has an Ajv-confirmed witness, and no
  witness contradicts an inclusion it claims.
- **Ajv confirmation.** Every witness, from either source, was checked with
  the repo's Ajv configuration (`allErrors: true, strict: false,
  discriminator: true` plus `ajv-formats`) against the pair's files. The
  generator stops on any disagreement.

The prototype is GPLv3. Its code, its datasets, and the runner that links
against it are not in this repository; only the verdicts and witnesses are.
To regenerate, build the prototype, write a runner that prints one JSON line
per problem file (`{"file", "verdict", "witness"}`), and run:

```bash
node scripts/schema-equivalence/test/catalog-generator/generate.cjs \
  --oracle /path/to/runner --work /tmp/catalog-work
```
