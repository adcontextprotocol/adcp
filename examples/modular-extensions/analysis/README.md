# Analysis: where each number in the proposal comes from

This directory holds the scripts behind the numbers in
`docs/reference/proposals/modular-adcp.mdx`, and the small outputs you need to check them. Two
kinds of numbers appear in the proposal:

- **History numbers** come from this repository's own git history: release counts, schema
  churn, the module cut, the experimental review, and the final layout. The Python scripts in
  six subdirectories produce them. They use the Python 3 standard library and git, nothing else.
- **Prototype numbers** come from the example one level up: test counts, storyboard counts,
  the size comparison with #8102, and the slide excerpts. `npm` scripts produce them.

## Reproduce the history numbers

Run the pipeline from the root of the adcp repository. It reads the history up to a pinned commit, so later
commits on `main` don't change the result.

```sh
git fetch origin --tags                       # needs 45591e97b3, ad1f380f8c, and the v2.x and v3.x tags
examples/modular-extensions/analysis/run_all.sh
git status --short examples/modular-extensions/analysis   # expect no changes
```

The defaults are `REF=45591e97b3` (the pinned commit, October 19, 2026),
`SINCE=2025-10-19` (the first day counted), and `FINAL_REF=ad1f380f8c` (the tree the final
layout places, October 19, 2026; its history still comes from `REF`). `REPO` defaults to the
repository that holds this directory. To override a default, set the variable in the
environment.

`run_all.sh` exports the trees at `REF` and `FINAL_REF` into temporary directories and runs six
steps in order.
Each step overwrites the outputs this directory ships. A clean `git status` afterward means the
numbers reproduce. Each step also writes intermediate files that `.gitignore` excludes.

The following table lists the steps and how long each took on an Apple-silicon laptop.

| Step | Directory | What it does | Time |
|---|---|---|---|
| 1 | `schema-graph/` | Builds the `$ref` graph of all 1,040 schema files and the first 11-module placement | Under 1 second |
| 2 | `kernel-cut/` | Places every file in the 29-module kernel cut, derives layers and the module directed acyclic graph (DAG), counts kernel-file commits, and runs the layering lint | 2 to 4 minutes |
| 3 | `churn/` | Classifies every schema file change since `SINCE`, diffs every general availability (GA) release against the one before, and aggregates under each placement | About 1 minute |
| 4 | `module-cut/` | Builds the co-change matrix and eight candidate cuts, and compares them | About 5 seconds |
| 5 | `experimental-review/` | Attributes every `x-status` marker to a feature ID, and traces per-ID churn and introducing changes | About 2.5 minutes |
| 6 | `final/` | Places all 1,047 schema files at `FINAL_REF` in the final layout (v1, then the byte-preserving v2). Checks the star and layer rules with a fix for every crossing `$ref`, re-aggregates the churn under each placement, and writes the table data | About 2 seconds |

The whole run takes 4 to 7 minutes; two clean runs with step 6 took about 4 and 6.5 minutes. To run
one step, call its script directly, for example `analysis/module-cut/run_all.sh`. A step reads the outputs of the steps before it.

## Reproduce the prototype numbers

```sh
cd examples/modular-extensions
npm install && npm run build && npm test     # about 1 minute: 91 tests, 18 storyboards, 132 steps
git fetch origin pull/8102/head:refs/remotes/pr/8102 --force
npm run analysis                             # about 45 seconds
```

`npm run analysis` rewrites `size-comparison.json` and `slide-excerpts.{md,json}`. The only
expected differences are the `generated_at` timestamps and `origin_main` in
`size-comparison.json`.

## Where each number comes from

The tables give each headline number, the file that holds it, and where to look in that file.
Paths are relative to this directory.

### Releases and what each implementer saw

| Number | Where | How to read it |
|---|---|---|
| 65 GA releases in 12 months, v2.5.1 to v3.2.5 | `module-cut/raw/agg-buying-delivery/release_modules.csv` | 65 data rows; the first is `v2.5.1`, the last `v3.2.5` |
| 25 of them changed a schema | `module-cut/raw/agg-buying-delivery/report.md`, "Releases: what an implementer saw" | Row "…with any non-annotation schema change", column "all" |
| Implementer table: signals 4/9/5, accounts 6/8/6, reporting 4/8/20, governance 6/10/21, creative 10/13/14, buying 14/16/20 | `module-cut/raw/comparison.md`, rows "releases changed / +kernel / +deps" | Last column, `buying-delivery` (the recommended cut) |

### The kernel

| Number | Where | How to read it |
|---|---|---|
| Kernel is 64 of 1,040 files: 38 kernel and 26 kernel types | `module-cut/raw/buying-delivery/placement.json` | Count entries by `label`; see the command after this table |
| 6.5% of post-GA file changes, 3.1% of non-additive ones | `module-cut/raw/comparison.md` | Rows "post-GA file changes in the kernel" and "post-GA non-additive file changes in the kernel" |
| Released kernel breaks after GA | `churn/raw/agg-cut-29/kernel_nonadditive.csv` | Rows outside `pre-3.0` with a non-empty `in_ga`: 8 records in 6 commits. #7442 reverts #7363, which leaves four changes. Reading them by hand gives two envelope codifications and two pattern or bound hardenings, each with an additive alternative |
| `enums/error-code.json` had 93 commits in 12 months | `kernel-cut/raw/kernel_churn.json` | Key `enums/error-code.json`, field `commits` (`git log --follow`) |
| It has 122 codes; modules own 93 | `git show 45591e97b3:static/schemas/source/enums/error-code.json` | 122 `enum` values. The split into 29 bootstrap codes and 93 module codes is a manual reading, not a script |
| A module-owned error-code registry cuts post-GA kernel file changes by 37% | `churn/raw/agg-cut-29/report.md` and `churn/raw/agg-cut-29-error-codes-registry/report.md`, "By layer and release window" | Sum column "file changes" over the three post-GA kernel rows: 96 + 86 + 16 = 198 against 59 + 56 + 9 = 124 |

To count module sizes, run the following command:

```sh
python3 -c "import json,collections; p=json.load(open('module-cut/raw/buying-delivery/placement.json')); print(sorted(collections.Counter(v['label'] for v in p.values()).items()))"
```

The output gives accounts 52, identity 32, media-vocabulary 76, signals 51, creative 221,
buying 343, reporting 57, governance 79, sponsored-intelligence 20, trusted-match 15, and
compliance-testing 4.

### The module cut

| Number | Where | How to read it |
|---|---|---|
| 24.4% of substantive post-GA commits touch two or more modules, excluding protocol-wide sweeps (96 of 393) | `module-cut/raw/comparison.md` | Row "…post-GA without sweeps", column `buying-delivery` |
| 29.0% for the first 11-module placement, 35.6% for the 29-module kernel cut | Same row | Columns `cut-11` and `cut-29` |
| An 8-module cut also scores 24.4% | Same row | Column `coarse` |
| Splitting proposals out of buying costs 2.6 points | `module-cut/raw/metrics-proposals-split.json` | `post_no_sweeps.cross_pct` is 27.0, against 24.4 in `metrics-buying-delivery.json` |
| The sweep threshold doesn't change the result | `module-cut/raw/comparison.md` | Table "Sweep threshold sensitivity": N from 6 to 12 moves the share by 0.2 points or less |

A sweep is a commit that touches more than eight modules of the 29-module cut, such as the
envelope fold (#4896). `module-cut/raw/sweeps.json` lists them.

### The experimental review

| Number | Where | How to read it |
|---|---|---|
| 27 feature IDs, 225 `x-status` markers | `run_all.sh` output, step 5 | `markers.py` prints the ID count, then the marker count |
| The changes that introduced 26 of the 27 IDs edited 83 distinct stable schemas | `experimental-review/intro.log`, line 1 | `sponsored_intelligence.core` predates the window, so 26 IDs have an introducing change |
| The 12 IDs registered in October 2026 edited 41 | `experimental-review/intro.log`, line 2 | Registration dates come from `experimental-review/regdates.txt` |
| 82 inline markers in 35 stable schemas | `experimental-review/hosts.log`, line 2 | A marker under another marker in the same file is nested and doesn't count |
| 21 markers from 14 IDs in `get_adcp_capabilities` | `experimental-review/hosts.log`, line 3 | The raw count is 22; one nested marker drops out |
| Five large areas carry 83% of per-ID change commits (106 of 128); the other 22 IDs carry 22; 12 have none | `experimental-review/summary.txt`, last line | A commit that only creates a surface doesn't count |

`intro.py` names the commits that introduced each ID. `regdates.txt` gives the commit that added
each ID to `docs/reference/experimental-status.mdx` and its date. Both are hand-collected inputs
that you can check against `git log`.

### The final layout

The final layout is a kernel layer, nine standard modules, and the compliance-testing leaf.
Buying is one module with eight layers, and 14 bridge extensions connect pairs of modules. Every
payload keeps its bytes. Step 6 places the tree at `FINAL_REF` in two passes. The first pass, v1
(`place_final.py`), merges the star and buying-layers analyses. The second pass, v2
(`place_final_v2.py`), moves 16 files so that every fix keeps the wire bytes. v2 is the final layout; its outputs carry a
`-v2` suffix. The history numbers read the churn from step 3, so they cover the same commits as
the module cut.

| Number | Where | How to read it |
|---|---|---|
| The kernel layer is 135 of 1,047 files: 39 kernel and 96 kernel types | `final/raw/placement-summary-v2.json` | `by_label.kernel`, `by_label.kernel-types`, and `kernel_layer`; `files` is the total |
| 71 kernel-layer files move in from modules; 13 of them changed after GA | `final/raw/tables-final-v2.json` | `kernel_moves_n` and `kernel_moves_modified_post_ga`; `kernel_moves` lists each file with its post-GA PRs |
| Nine standard modules and the leaf: buying 382, creative 202, governance 91, reporting 55, accounts 48, signals 38, identity 23, sponsored-intelligence 20, trusted-match 15, compliance-testing 4 | `final/raw/tables-final-v2.json` | `counts` |
| Buying has 8 layers: targeting 71, pricing 20, catalogs 26, commitment 39, supply 122, offer 37, execution 43, delivery 24 | `final/raw/placement-summary-v2.json` | `buying_layers`; `buying_total` is 382 |
| 16 files move between v1 and v2 | `final/raw/moves-v2.csv` | One row per file: v1 label, v2 label, and reason |
| 59 buying files without a layer, each given one by the layer rules | `final/raw/buying-new-layers.csv` | 59 data rows, with the referring layers of each file (v1 labels) |
| 136 `$ref` occurrences cross a forbidden boundary at `FINAL_REF`: 114 module to module, 2 kernel layer to module, 19 module to extension, 1 buying layer the wrong way | `final/raw/verify-final-v2.json` | `crossing_occurrences` |
| 3.4 resolves 131 of them with the same bytes; the other 5 leave with the slated 4.0 removals | `final/raw/crossing-edges-v2.csv` | One row per occurrence; 5 rows have `fix_class` `slated`. `release_34` and `release_40` give each step |
| 0 violations and no cycle after the fixes | `final/raw/verify-final-v2.json` | `star_violations_after`, `cycles_after`, and `unresolved` are empty |
| 8.7% of post-GA file changes touch the kernel layer (262 of 3,026); 3.7% of non-additive ones (18 of 481) | `final/raw/metrics-final-v2.json` | `kernel_share_post_ga_fc` and `kernel_share_post_ga_nonadd_fc`: count, total, percent |
| 20.4% of substantive post-GA commits touch two or more modules or extensions, sweeps excluded (80 of 393) | `final/raw/metrics-final-v2.json` | `cross_post_no_sweeps`; `cross_post_no_sweeps_no_ct` (17.3%) drops the leaf, and `cross_post_no_sweeps_modules_only` (18.6%) counts modules only |
| 64.1% of post-GA buying commits stay in one layer (127 of 198); 83.3% with the byte-preserving layer fixes (165) | `final/raw/metrics-final-v2.json` | `buying_layers.single_layer_pct`, and `buying_layers.single_layer_after_wire_identical_fixes` over `buying_layers.buying_commits_post_no_sweeps` |
| 9 of 65 GA releases touch the kernel layer | `final/raw/metrics-final-v2.json` | `kernel_releases` and `ga_releases` |
| GA releases each implementer tracks, own module and with the kernel layer | `final/raw/metrics-final-v2.json` | `implementers` per module, and `layer_releases` per buying layer |

Step 6 reads frozen inputs from two analyses this directory doesn't ship, in `final/inputs/`:

- `buying-layers-placement.json`, `buying-layers-caps.json`, `buying-layers-dir-heuristic.json`,
  and `buying-layers-classification.csv` come from the buying-layers analysis. They give a layer
  for each buying file of the module cut, the capability owners, and a verdict for each post-GA
  commit that crosses buying layers.
- `star-placement.json` and `star_decisions.py` come from the star analysis. They give one fix
  class for each cross-module `$ref` and the placement that follows from it.

A wire analysis supplies the byte-preserving fixes of v2 (`V2_RULES` in `final/verify_final.py`)
and the v2 file moves (`V2_MOVES` in `final/place_final_v2.py`). For each payload that a v1 fix
changes, that analysis lists the alternative that keeps its bytes.

### The prototype

| Number | Where | How to read it |
|---|---|---|
| 91 tests, 18 storyboards, 132 steps | `npm test` output | `# tests 91`, then the `conformance:` line |
| Rules covered per extension | `npm run conformance` output | One `rules:` line per extension |
| 446 schemas copied byte for byte into 22 layers of the final layout | `../core/UPSTREAM.json`, `../core/placement.json`, `../core/release.json` | 446 keys under `files` in the first; each file's layer comes from `final/raw/placement-final-v2.json`, except the 2 files in `compat_assembly` (the 3.x compatibility assembly); 22 keys under `layers` in the release. `../core/patches.json` creates 8 more files, 454 in all |
| 0 layout violations in the vendored subset, after the 3.4 fixes for the 45 upstream `$ref` pointers that break a rule | `npm run build:core` output, `../test/layering.test.mjs` | The `layout check` line. The test matches each of the 45 to its patch and checks the fix ID against `final/raw/crossing-edges-v2.csv`: 23 bridge points, 15 registry compositions, 7 in the 3.x compatibility assembly |
| `seller-adjustable-terms` schema and manifest: 443 lines; #8102 allowance-lane schema: +640 | `size-comparison.json` | `extension_packages.seller-adjustable-terms.parts.schema_and_manifest.lines`, and `pr_8102.static_schemas_source.by_lane.allowance.insertions` |
| With spec and storyboards, the package is 1,306 lines | `size-comparison.json` | `extension_packages.seller-adjustable-terms.authored_total` |
| #8102: 16 schema files, +872/−19; tests +642; docs +155/−3 | `size-comparison.json` | `pr_8102.static_schemas_source` and `pr_8102.by_area` |
| The two developer journeys, and for each of the four worked examples, the chain from the host schema to the payload | `slide-excerpts.md` | 79 of its 102 excerpts (the first six sections), each cut from a built file or the run's payloads |

## Known limits

Read the numbers with these limits in mind:

- **The non-additive classifier is a heuristic.** `churn/schemadiff.py` compares schemas keyword
  by keyword and resolves `$ref` one level deep. It doesn't evaluate draft-07 conditionals, so an
  added `if`/`then`, `not`, or `allOf` subschema counts as non-additive unless it mentions only
  added properties. Many such rules codify what prose already required, so the classifier overstates
  breaking change for cross-field rules. The counts aren't additive across categories either:
  one file change can carry several records.
- **The counts ignore direction.** Making a response field required breaks servers that don't
  send it, not clients, and tightening a request does the reverse. The counts don't weight this.
- **Co-change isn't forced change.** A feature that extends two modules in one PR counts as
  cross-module. The numbers measure how often a module split calls for coordinated releases, not
  whether each change required coordination.
- **Only schema files count.** Documentation, storyboards, training agents, and software
  development kits (SDKs) aren't in the churn, the module cut, the experimental review, or the final layout.
- **Placement is static.** Historical files take the module that their path has in the placement, or
  a referrer or directory fallback for deleted paths. `churn/raw/agg-cut-29/report.md` lists the
  fallbacks in "Placement fallbacks".
- **Some experimental-review counts are manual.** These counts come from reading diffs and
  release notes, not from a script: the introducing commits, the registration dates, the 21 enum
  values that ten IDs added to closed stable enums, the four IDs that rewrote the meaning of
  stable values, and the 19 IDs too young to graduate.
- **The final layout reads frozen inputs.** This directory doesn't ship the buying-layers and
  star analyses, so step 6 reproduces the final layout from their outputs in `final/inputs/`, not from
  the history. The commit verdicts behind the 83.3% projection are a manual reading of each
  cross-layer commit.
- **The prototype simulates core releases.** Its core 3.4 and 4.0 releases
  (`../compat/core-releases/`) are simulated manifests. The Ad Context Protocol (AdCP) publishes no
  per-type majors.

## Names in this directory

File and column names use these labels for the placements:

- `cut-11` is the first 11-module placement (`schema-graph/raw/placement.json`).
- `cut-29` is the 29-module kernel cut (`kernel-cut/raw/placement2.json`).
- `buying-delivery` is the recommended ten-module cut (`module-cut/raw/buying-delivery/`).
  A file it moves away from its kernel-cut module carries the reason code `cut-10-move`, and
  its `cut_29` field keeps the kernel-cut label it came from.
- `final` is the final layout (`final/raw/placement-final-v2.json`). Its `origin` field names
  the step that placed each file: `cut-10` (the module cut), `star` (the star analysis),
  `buying-layers` (the buying-layers analysis), `final` (a v1 decision), or `final-v2` (a v2
  move). Reason codes start with `star-`, `layers-`, `F-`, or `F-v2-` the same way; `cut_10`
  keeps the module-cut label of a file the star analysis moved. `buying_layers` keeps the layer
  that the buying-layers analysis gave it. `v1` keeps the v1 label of a file that v2 moved. Labels
  are `kernel`, `kernel-types`, `module:<module>`, `module:buying/<layer>`, `extension:<name>`,
  `assembly`, and `retire`.
- `churn2.py` is the per-ID churn tracer; `churn/` is the history-wide classifier.

Generated placement files carry short reason codes that name the analysis step that moved a
file. The prototype reads only the `label` field.
