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
`decided_by`, `manual_reason` for hand verdicts, `witnesses`: payloads
with their validity on each side, and `subsumes`: the subsumes verdict per
direction (see [Regenerate the catalog](#regenerate-the-catalog)). Each file names the prototype
commit (`oracle_commit`), the date its record was frozen (`oracle_frozen`), and
the subsumes commit (`subsumes_commit`).

## How the verdicts were decided

`../catalog-generator/generate.cjs` builds the pairs from
`../catalog-generator/pairs.cjs`, checks each one in both directions with
subsumes, and labels it from one of three sources. The tool under test plays
no part.

- **Frozen prototype verdicts (`decided_by: oracle`).** The
  refutational-normalization prototype (Baazizi, Ben Ali, Colazzo, Ghelli,
  Klessinger, Sartiani, Scherzinger, arXiv 2603.25306;
  https://gitlab.lip6.fr/benali1/refutationalnormalizationforjsonschema),
  commit `8064ad83a0dbdb4b02c0ce1632d273f7cbf736cf`, decided 891 pairs in
  both directions; 889 of those verdicts stand. `../catalog-generator/oracle-bundle.cjs` wrote its input,
  with one definition per `$ref` target and side, and with `discriminator`
  turned into the formula Ajv evaluates. The prototype is GPLv3; only its
  verdicts and witnesses are in this repository. They are a frozen record as
  of 2026-11-20. Nothing runs the prototype. The generator keeps a frozen
  verdict while the pair's files stay the same.
- **Hand verdicts (`decided_by: manual`).** 39 pairs use constructs the
  prototype didn't model like Ajv: `format`, astral characters, `.`,
  lookahead, `uniqueItems`, and `multipleOf` on doubles. Each carries a hand
  verdict with its reason. Two of them replace prototype verdicts that
  assumed exact numbers where Ajv computes `x / m !== parseInt(x / m)`.
  "The oracle" in those reasons is the prototype. Every non-inclusion a hand
  verdict claims has an Ajv-confirmed witness, and no witness contradicts an
  inclusion it claims.
- **subsumes verdicts (`decided_by: subsumes`).** A pair with neither a hand
  verdict nor a frozen verdict, such as a pair you add, takes the subsumes
  verdict. subsumes must settle both directions. A pair it can't settle
  stops the generator until the pair gets a hand verdict in `pairs.cjs`.
- **Ajv confirmation.** The generator checks every witness, from any source,
  with the repo's Ajv configuration (`allErrors: true, strict: false,
  discriminator: true` plus `ajv-formats`) against the pair's files.

## Regenerate the catalog

subsumes (https://github.com/georg-wolflein/subsumes, MIT), commit
`9a9d00afa3e1c46015949a74faa91b4ce71f4ab0` (v0.4.0), is the only oracle the
generator runs. It implements the prototype's algorithm in Rust, with
`format` asserted and patterns read as ECMA-262 with the `u` flag. It has no
command line tool, so the generator uses its `harness run` binary. CI doesn't
run it.

```bash
cargo install --locked --git https://github.com/georg-wolflein/subsumes \
  --rev 9a9d00afa3e1c46015949a74faa91b4ce71f4ab0 harness
node scripts/schema-equivalence/test/catalog-generator/generate.cjs
```

With `cargo install --root DIR`, set `SUBSUMES_ROOT=DIR`. The generator
bundles each side as `oracle-bundle.cjs` does, translates it to draft
2020-12, the only dialect subsumes reads, and writes the `subsumes` record of
each pair by these rules:

- `no` comes with a counterexample that the repo's Ajv configuration confirms
  against the pair's files. Without that confirmation, the verdict is
  `unknown`.
- `yes` is `unproven` when the pair uses `format` `date-time`, `uuid`, or
  `uri`, which subsumes reads by the RFC grammars and not as `ajv-formats`
  does. It is also `unproven` when a pattern names a surrogate code point,
  because subsumes models strings as Unicode scalar values and can't see a
  lone surrogate. Last, it is `unproven` when the pair uses `multipleOf`,
  `type: integer` beside a numeric bound, or a number above 2^53 in
  magnitude, because subsumes reasons over exact numbers and Ajv over
  doubles, with `parseInt` for `multipleOf`.
- `unknown` stays `unknown`, with the reason subsumes gives.

A `yes` or `no` must agree with the frozen or hand verdict. On a
disagreement, or a decided direction that a hand verdict leaves open, the
generator names the pair and writes nothing. Give such a pair a hand verdict
whose reason notes the disagreement. With no change to `pairs.cjs`, the
generator rewrites the catalog byte for byte.
