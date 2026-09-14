# Release Process

This is the operational overview for AdCP releases. For patch eligibility and
conflict policy, see `.agents/playbook.md` (§ Release lines). For the complete
maintenance-line checklist, see `.agents/shortcuts/cut-patch.md`.

## Current topology

- `3.1.x` is the stable maintenance line. Patch fixes are reviewed on `main`
  first, then cherry-picked to a PR targeting `3.1.x`.
- `main` is the next-minor line. It must be in Changesets beta pre mode
  (`.changeset/pre.json` with `"tag": "beta"`) while developing 3.2, so its
  Version Packages PRs produce `3.2.0-beta.N` rather than stable `3.2.0`.
- Forward merges are one-way: `3.1.x → main`. Never merge `main` into the
  maintenance branch.

The root `adcontextprotocol` package is private. Its version is release
metadata for Changesets and the protocol artifacts; it is **not published to
npm**. Protocol releases are distributed as signed tarballs through GitHub
Releases and `https://adcontextprotocol.org/protocol/`. SDK npm releases happen
in the separate `adcp-client` repository.

## Changes and changesets

Protocol changes need a changeset:

```bash
npm run changeset
```

Use `patch` for compatible fixes and clarifications, `minor` for additive
stable protocol surface, and `major` for breaking stable changes. Addie,
website, infrastructure, internal tooling, and non-normative docs do not get a
protocol changeset.

For a fix that must ship in 3.1.x:

1. Land the normal PR on `main`.
2. Confirm every protocol changeset in the merged commit is `patch`.
3. Create a clean branch from `origin/3.1.x`, cherry-pick the merged commit,
   resolve only maintenance-compatible conflicts, and open a PR to `3.1.x`.
4. Merge only after CI and human review. The push to `3.1.x` refreshes the
   `changeset-release/3.1.x` Version Packages PR.

Do not downgrade a `minor` or `major` changeset during a backport. Reclassify
the change on `main` first or leave it for 3.2.

## Cutting a 3.1.x patch

1. Audit `changeset-release/3.1.x`. The PR must show only
   `adcontextprotocol@3.1.X` under `Patch Changes`; unexpected non-protocol or
   higher-level entries are a stop.
2. Review the generated version, changelog, versioned schemas/compliance, and
   `dist/protocol/3.1.X.tgz{,.sha256,.sig,.crt}`.
3. Merge the Version Packages PR. `release.yml` tags `v3.1.X`, creates the
   GitHub Release, uploads the four assets, publishes the immutable artifacts
   to R2, and verifies the CDN copy. It does not run `npm publish`.
4. Let `release-docs.yml` open and merge the versioned docs snapshot PR.
5. Review and merge the automated forward-merge PR from `3.1.x` to `main`.
   Metadata may resolve by policy; content conflicts require human review.

## Patch verification (3.1.5 example)

Use the exact release version; do not verify through a moving alias:

```bash
VERSION=3.1.5

git fetch origin --tags
git rev-parse "v$VERSION^{}"
git rev-parse origin/3.1.x
gh release view "v$VERSION" --json tagName,targetCommitish,assets,url

tmpdir="$(mktemp -d)"
gh release download "v$VERSION" --dir "$tmpdir"
cd "$tmpdir"
shasum -a 256 -c "$VERSION.tgz.sha256"
cosign verify-blob \
  --signature "$VERSION.tgz.sig" \
  --certificate "$VERSION.tgz.crt" \
  --certificate-identity-regexp '^https://github\.com/adcontextprotocol/adcp/\.github/workflows/release\.yml@refs/heads/.*$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$VERSION.tgz"

curl -fsSI "https://adcontextprotocol.org/protocol/$VERSION.tgz"
curl -fsS "https://adcontextprotocol.org/schemas/$VERSION/index.json" >/dev/null
curl -fsS "https://adcontextprotocol.org/compliance/$VERSION/index.json" >/dev/null
```

Then confirm:

- the tag and `origin/3.1.x` identify the Version Packages merge;
- the GitHub Release has exactly the tarball, checksum, signature, and
  certificate assets;
- `dist/docs/3.1.5/` lands on `main` and the `3.1` docs selector reflects it;
- the `3.1.x → main` forward-merge PR lands; and
- `git log v3.1.5..origin/3.1.x` contains no stranded release work.

## 3.2 beta pre mode

Enter beta pre mode on `main` before accepting 3.2 release changes:

```bash
git switch main
git pull --ff-only origin main
npx changeset pre enter beta
git add .changeset/pre.json
git commit -m "chore(release): enter pre mode for 3.2 beta"
```

Land that through a normal PR. While `.changeset/pre.json` exists, merge only
Version Packages PRs that resolve to `3.2.0-beta.N`. Keep pre mode and its
changeset pool on `main`; neither belongs on `3.1.x`. Exiting pre mode for 3.2
GA is a separate, explicitly reviewed release operation.

## Cutting a 3.2 release candidate

The first candidate is `3.2.0-rc.0`. Treat that promotion as a reviewed release
operation, not as an ordinary Changesets tag switch.
Changesets increments the existing beta ordinal when its prerelease tag changes,
which would turn `beta.10` into `rc.11`. The repository's guarded promotion
script uses semver's phase-change behavior instead. It can fold a reviewed
pending changeset pool directly into RC.0 without publishing another beta.

After verifying the latest beta's immutable assets, close any superseded beta
Version Packages PR. Then, from a clean branch based on the resulting `main`:

```bash
git switch main
git pull --ff-only origin main
npm run promote:rc -- --check
npm run promote:rc -- --prepare
git diff --check
git add .changeset/rc-promotion.json
git commit -m "chore(release): prepare 3.2.0-rc.0"
```

Open and merge that state-only commit as its own PR. The release workflow sees
the marker, creates the Version Packages PR at `3.2.0-rc.0`, and generates and
signs the normal schema, compliance, and protocol artifacts in GitHub Actions.
That generated PR must receive human approval on its final head SHA. Do not run
`changeset version` for this one phase-transition, and do not hand-edit the
package version, lockfile, prerelease state, marker, or generated artifacts.

The script is intentionally one-way and 3.2-specific: it requires `beta.N` and
beta pre mode, computes `3.2.0-rc.0`, and records the exact pending changeset
filenames and SHA-256 digests in the reviewed marker. The Version Packages
workflow refuses any changed or additional changeset, consumes the reviewed
pool through Changesets, retitles that generated changelog section to RC.0,
updates the package and lockfile through `npm version`, and switches pre mode to
`rc` before building the release artifacts. With an empty pool it adds the
phase-only RC.0 changelog entry. Any fixes after RC.0 use ordinary changesets
and the normal Version Packages flow to produce `rc.1`, `rc.2`, and so on.

Before merging the RC Version Packages PR, confirm:

- the package and lockfile resolve to `3.2.0-rc.N`, and `.changeset/pre.json`
  still has `"mode": "pre"` and `"tag": "rc"`;
- the changelog contains only changes intended for the candidate;
- versioned schemas, compliance bundles, protocol tarball, checksum,
  signature, and certificate all use that exact RC version;
- the compact lifecycle storyboards and training-agent profile tests pass;
- the TypeScript, Python, Go, and Java SDK disposition is recorded, with any
  unsupported SDK called out rather than silently implied ready; and
- open 3.2 milestone items are either closed or explicitly moved out of the
  release by their decision owner.

After merge, verify the exact immutable release rather than a moving alias:

```bash
VERSION=3.2.0-rc.0

git fetch origin --tags
git rev-parse "v$VERSION^{}"
gh release view "v$VERSION" --json tagName,isPrerelease,targetCommitish,assets,url
curl -fsS "https://adcontextprotocol.org/schemas/$VERSION/index.json" >/dev/null
curl -fsS "https://adcontextprotocol.org/compliance/$VERSION/index.json" >/dev/null
curl -fsSI "https://adcontextprotocol.org/protocol/$VERSION.tgz"
```

Also confirm the release is marked prerelease, has exactly the tarball and
three sidecars, the `3.2-rc` docs snapshot lands, and the public training agent
advertises and executes the exact RC version. Subsequent fixes get ordinary
changesets and advance to the next `rc.N` through the Version Packages PR.

For 3.2 stable, use a separate reviewed state change:

```bash
npx changeset pre exit
```

The resulting Version Packages PR removes the prerelease suffix. Do not
re-enter another tag before that stable versioning step.

## Recovery

If the automated release fails after the Version Packages merge, use the
explicit current-head recovery procedure below. Manual tag/release recovery
is the last resort:
the tag must target the Version Packages merge, and the same four signed
assets must be uploaded without overwriting an existing artifact with a
different digest. See `.agents/shortcuts/cut-major.md` for the fallback
commands.

### Publication authority and ordering

For the 2026-09-14 incident, the publication fence in
[#7510](https://github.com/adcontextprotocol/adcp/pull/7510) is a hard
predecessor of both the JSONL filter fix in
[#7509](https://github.com/adcontextprotocol/adcp/pull/7509) and the curated
3.1.22/3.1.23 artifacts in [#7507](https://github.com/adcontextprotocol/adcp/pull/7507).
The legacy deploy bulk upload would otherwise expose those historical artifacts
without recovery approval. Land the human-approved fence first; then rebase and
requalify each dependent PR on that main, including combined tests and human review. Neither merge authorizes
historical backfill or incident recovery.

Routine app deployment is authorized to rebuild and upload only
`schemas/latest/**`, `compliance/latest/**`, and `protocol/latest.tgz*`.
It uses `backfill-cdn-artifacts.sh --latest-only`; root version indexes and
all semver paths are excluded. The app itself serves committed `dist`, so a
committed package version without a published GitHub Release and its four
assets also blocks app deployment. This can delay app-only fixes while a
release needs recovery.

Only the release workflow publishes a new immutable version. It verifies the
current tested branch, the original merged release PR's final-head maintainer
approval, and the committed signed tuple. Approval must come from a non-author
human with current repository write, maintain, or admin permission. Every
candidate approver is checked through GitHub's collaborator-permission API;
missing, failed, ambiguous, or unsupported permission responses stop publication.
Public review ability and author association are not sufficient authority.
It stages the four GitHub assets in
a draft, publishes the tag/release targeting the original release merge, then
uploads that version alone with `--version VERSION --skip-latest`. Changesets
only prepares release PRs; it has no independent tag/publish command. Missing
signatures must be fixed through review, never regenerated during publication.

Release runs use `queue: max` without in-progress cancellation. GitHub permits
100 pending runs; this is not an unlimited or guaranteed delivery queue.
See [GitHub's concurrency contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
The exact queue/cancellation combination is regression-tested; older actionlint
parsers require only the specific unsupported `queue`-key diagnostic exception.
Old
runs fail their current-branch fence. A later push with a stranded committed
version fails explicitly, including an app-only push, and must use the recovery
procedure below before Changesets advances the package again.

Before Changesets runs, its fence resolves exactly zero or one open Version
Packages PR and captures the prior branch OID (or confirmed absence). An existing
PR must match that ref; it is synchronously marked Draft, verified, and given a
HOLD comment before generation. An orphan ref, missing ref for an existing PR,
ambiguous lookup, or failed quarantine stops the run. The pinned action's single
push shape is replaced with an explicit lease on the captured OID. Fetch/push
URLs must identify this repository; writes use the captured URL and reject URL
rewrites. The HOLD comment's identity, issue, and body are read back before any
push. API/read commands have a 60-second bound; pushes have a 10-minute bound,
with process-group termination and read-back reconciliation on timeout. Freshness is
checked before and after that push, and again after the action's PR API calls.

Drift, push errors (including lost acknowledgements), or an incomplete action
trigger restoration of the captured ref with a second lease expecting only the
recorded new OID. Only a ref created by this transaction from confirmed absence
may be deleted. Restoration is read back and verified; a lost lease preserves
the third-party ref. Existing PRs stay Draft with HOLD/reconciliation evidence.
API outages fail closed and retain the transaction's prior/new/observed OIDs in
the Actions log, job summary, and attempted artifact upload; they are not reported
as verified quarantine. A retry only reconciles recorded state, never repeats a
push. Successful changes remain Draft (`pr-draft: always`) for a later human
Ready transition and exact-head review.

Changesets receives a fresh App token after setup, with preparation and action
bounds of 10 and 40 minutes. An `always()` step mints a separate reconciliation
token. Each token mint has a two-minute bound so a hung request cannot prevent
finalization. Git recovery uses that token through temporary command-scoped headers,
never an expired checkout credential. Failed refresh leaves explicit unverified
reconciliation evidence; it does not fall back to stale credentials.

An App-token push synchronously changes an already-open release PR, even if
the post-push check fails. Publication therefore also checks immutable Git
provenance: the approved final head must be one commit based on the release
merge's exact first parent, and its entire tree must equal the released tree.
A two-parent merge must name that approved head as its second parent. A stale
or altered merge is quarantined even with trusted approval and bypassed or
non-strict branch checks. Regenerate the release PR from current verified main
and obtain new final-head maintainer review before merging. Do not transplant
old approvals, replay an old workflow, or treat an existing PR as unchanged
just because the later PR API call was skipped.

Freshness is checked again before external writes and after uploads. GitHub
refs, GitHub Releases, and R2 have no shared transaction: a branch can move
between a check and a request. The pre-push hook narrows the Changesets race to
its push/PR requests; it does not lock main. An in-flight request can finish
after main moves. Such a failure requires inspection and explicit recovery;
never treat a previous verification or a queued run as current authority.

GitHub assets are staged privately in a draft before release publication. Exactly
the four signed tuple assets are required; extras and duplicates are rejected. R2
publication is **progressive, with per-object atomicity only**: conditional
`If-None-Match: *` writes create missing objects, and existing objects must
match byte-for-byte, including signatures and certificates. A failed upload
may leave a publicly visible subset after the approved tag/release. It must
not overwrite, delete, advertise whole-bundle atomicity, or claim CDN
completion. Consumers needing one complete artifact should use the signed
GitHub tarball and verify its checksum/signature; CDN completion additionally
requires a full committed-path byte audit, including JSONL after the separate
extension-filter fix. Mutable `latest` uploads remain progressive as well.

Live unscoped bulk backfills are disabled. `--dry-run` remains available for
inventory; it is not release authorization. Historical CDN recovery must use
an existing approved tag/release, a current tested branch fence, unchanged
committed bytes, and conditional missing-object creation. The stable-only
`recover-protocol-cdn.yml` recovers four protocol files, not schemas/compliance
and not RC releases.

### Explicit recovery of a superseded release merge

Do not rerun the obsolete push: a rerun retains its old SHA and workflow.
After the corrected workflow is merged, an authorized maintainer can dispatch
`release.yml` **on current main** (or the applicable current maintenance branch)
with `release_commit` set to the original approved release merge. The dispatch
re-runs the existing verification jobs on current main, verifies that the
release merge is an ancestor, requires the same package version and unchanged
versioned artifacts, rechecks original final-head maintainer permission and
merge provenance, and fences
every publication phase. It never silently repairs from an unrelated push.
A new main commit during the attempt requires another explicit dispatch and
verification of the new head. If a later package version has already landed,
stop for a separately reviewed historical recovery; this path refuses it.

For the 2026-09-14 `3.2.0-rc.3` incident, the recovery target is
`71f9cd5414454e94ccfef87ce25777ead6fad228` (#7485), whose final PR head
`e7d42cbe5d7b3d05c3fcdcaa6f568b08ba131439` received human approval at
12:34:18 UTC. Release run `34844149713` was cancelled with zero jobs. Deploy
`34845112730` exposed its R2 objects before a tag/GitHub Release; the independent
incident audit found 2,092 matching schema/compliance objects of 2,093 paths
(1,612 schemas and 481 compliance files). Four protocol files bring the full
release inventory to 2,097. The JSONL workstream owns the omitted path/filter
and schema/compliance enumeration verification.
This version is externally exposed; absence of a GitHub Release is not
permission to edit or retire its bytes.

**rc.3 recovery is quarantined.** The reviewed head `e7d42cbe` has parent
`decd95f6303ba08d8d482c93078adad0770a4bf3`, but release merge `71f9cd54` has
parent `eb3cbd605fc11be6e398c5b83f4e53d332a8e365`; their trees also differ.
The intervening base changes include a protocol changeset, compliance source,
and storyboard tooling. The original final-head review does not establish
approval of the exact 71f tree. The provenance gate rejects ordinary dispatch
for 71f; the previously proposed dispatch-only recovery is withdrawn. There
is no grandfather exception or provenance override in this patch.

The stale `eb3cbd605fc11be6e398c5b83f4e53d332a8e365` release run
`34842463221` subsequently created #7508 at
`102916bb28c156b1710f031aa28e4655bcf71cdc`, tree
`fd299f52f6bf1a4427ef85f890832d1e5713aade`. Its sole parent/merge-base
is eb3cbd, two commits behind then-current af1. The direct delta against
current main changes exposed rc.3 artifacts and omits #7504; its three-dot PR
display obscures that omission. The coordinator marked it Draft, disabled
auto-merge, and posted a
[HOLD](https://github.com/adcontextprotocol/adcp/pull/7508#issuecomment-5664735087).
It is not a recovery candidate. Do not merge, close, replace, or otherwise
mutate it without coordinating with that owner; retain the original committed
71f release artifacts. The fencing regression tests cover this stale-parent
shape, missing later changeset, and conflicting rc.3 bytes.

The safe incident handoff, requiring separate maintainer authorization, is:

1. Review and land the ordering fix first, then rebase/requalify and review the
   JSONL fix. Coordinate #7502/#7503's immutability guard and documentation claims;
   this patch changes no release content. Account for every existing release
   and deploy run using the old workflow, including `34842463221` and
   `34847610745`, before enabling recovery. New workflow code does not fence
   runs that already loaded the old code. Maintainers must quiesce those old
   writers and reserve a quiet publication window.
2. Recheck current main, original review and current reviewer permission, the
   reviewed-head and merge-parent/tree relationship, ancestry, package version,
   the full committed rc.3 tree, checksum, Sigstore identity, tag and release
   state, and every existing R2 object's bytes. Any conflicting tag, release
   asset, or R2 bytes is a stop; do not overwrite, delete, regenerate, roll
   back, or retag. Preserve already exposed bytes and record discrepancies.
3. **Stop at the 71f provenance mismatch.** Obtain a separately reviewed plan
   binding fresh maintainer authority to the exact original 71f tree and its
   already exposed bytes. No such exception or recovery execution is authorized
   here. Do not rerun/dispatch the ordinary workflow expecting to bypass the
   gate, regenerate artifacts, retarget the original merge, or overwrite R2.
   Any future approved recovery must retain tag target 71f, stage its unchanged
   signed tuple before release/R2 publication, and enforce conditional writes.
4. After a separately approved recovery, independently verify the tag target,
   prerelease flag, all four GitHub assets,
   all 2,093 schema/compliance paths (including JSONL) plus the four protocol
   files, byte hashes, checksum and Sigstore identity (2,097 files total). Check deployment and docs/SDK readiness separately. If
   anything fails or main advances, record the partial state and stop for
   explicit reauthorization on the next verified current head.

These are recovery instructions, not a record of operations performed. The
ordering-fix work must not publish, delete, roll back, tag, release, deploy,
rerun/cancel workflows, mutate R2/CDN, or change branch rules.
