# Release Process

This is the operational overview for AdCP releases. For patch eligibility and
conflict policy, see `.agents/playbook.md` (§ Release lines). For the complete
maintenance-line checklist, see `.agents/shortcuts/cut-patch.md`.

## Current topology

AdCP 3.2 GA ships as `3.2.1` (tag `v3.2.1`, wire pin `"3.2"`); `3.2.0` is
permanently withdrawn. The branch topology changes on GA day, in the order in
[`.agents/shortcuts/cut-minor-ga.md`](.agents/shortcuts/cut-minor-ga.md):

**Until `v3.2.1` is tagged:**

- `3.1.x` is the stable maintenance line. Patch fixes are reviewed on `main`
  first, then cherry-picked to a PR targeting `3.1.x`.
- `main` is the 3.2 line. It stays in Changesets RC pre mode
  (`.changeset/pre.json` with `"tag": "rc"`) until the separately reviewed
  pre-exit PR; the next Version Packages cut after that exit produces `3.2.1`.
- Forward merges are one-way: `3.1.x → main`.

**After `v3.2.1` (GA runbook Phase 10):**

- `3.2.x` is created from the `v3.2.1` Version Packages merge and becomes the
  stable maintenance line. Patches continue as `3.2.2`, `3.2.3`, and so on.
  Fixes land on `main` first and are cherry-picked to `3.2.x`.
- `main` re-enters Changesets **beta** pre mode for 3.3 the same day
  (`npx changeset pre enter beta`), so minor changesets can never cut an
  accidental stable release.
- `3.1.x` stays a security and critical-fix line for a maintainer-decided
  window; the fix flow among `3.1.x`, `3.2.x`, and `main` is recorded when
  `3.2.x` is created.
- Forward merges stay one-way from maintenance lines toward `main`
  (`3.2.x → main` through `forward-merge-3.2.yml`). Never merge `main` into a
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

For a fix that must ship in 3.1.x (after GA, the same flow applies to `3.2.x`):

1. Land the normal PR on `main`.
2. Confirm every protocol changeset in the merged commit is `patch`.
3. Create a clean branch from `origin/3.1.x`, cherry-pick the merged commit,
   resolve only maintenance-compatible conflicts, and open a PR to `3.1.x`.
4. Merge only after CI and human review. The push to `3.1.x` refreshes the
   `changeset-release/3.1.x` Version Packages PR.

Do not downgrade a `minor` or `major` changeset during a backport. Reclassify
the change on `main` first or leave it for the next minor.

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
re-enter another tag before that stable versioning step. 3.2 GA ships as
**`3.2.1`**, not `3.2.0` (see the next section). Follow the ordered GA runbook
in [`.agents/shortcuts/cut-minor-ga.md`](.agents/shortcuts/cut-minor-ga.md):
freeze gates, pre-exit PR contents, the Version Packages audit, CDN worker
deploy and discovery refresh, docs snapshot, SDK stable releases, hosted
surfaces, and the `3.2.x` branch and 3.3 pre-mode re-entry.

## Shipping a stable release over a withdrawn version number

A stable version number whose bytes were exposed without a release (for
example the 2026-06-30 accidental `3.2.0` cut, reverted in #5769, whose
signed artifacts remain on the artifact CDN) is permanently withdrawn. Its
bytes are never overwritten, deleted, or retired, and it stays marked
`unpublished` in `scripts/build-schemas.cjs`, `server/src/schemas-middleware.ts`,
and `workers/artifact-cdn/src/index.js` so it never wins `latest_stable` or a
`vN` / `vN.M` alias. `tests/schema-release-status.test.ts` keeps those three
maps identical. Prerelease `superseded_by` is derived from the first
*selectable* stable release on the minor line, so the 3.2 candidates point at
`3.2.1` only once it exists.

`npm run version` refuses to generate any withdrawn/unpublished number. To
ship the line's first stable release as the next patch instead, land a
reviewed `.changeset/withdrawn-release.json` while the line is still in pre
mode. It binds:

- `withdrawn_version` and `target_version` (must be the next patch);
- `withdrawn_release_commit` (the accidental Version Packages commit, which
  must commit that version) and `revert_commit` (whose first parent is that
  commit);
- `withdrawn_protocol_sha256`, the exposed tarball's digest; and
- a concrete `reason`, which is copied into the changelog.

During ordinary prerelease cuts, `scripts/version-packages.mjs` verifies the
marker and leaves it in place. On the pre-exit cut it additionally proves that
no tag or GitHub Release exists for the withdrawn number. Changesets then
consumes the complete pending and archived pool and computes the withdrawn
number. The step retitles that changelog block, moves the package to
`target_version`, and deletes the marker. Any mismatch fails closed. Preview
the effect without versioning:

```bash
GITHUB_REPOSITORY=adcontextprotocol/adcp node scripts/skip-withdrawn-release.mjs check --remote
GITHUB_REPOSITORY=adcontextprotocol/adcp node scripts/skip-withdrawn-release.mjs preview
```

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
`schemas/latest/**`, `compliance/latest/**`, `protocol/latest.tgz*`, and the
root discovery pointers `schemas/index.json` and `schemas/latest.json`. It
uses `backfill-cdn-artifacts.sh --latest-only`; all semver paths are excluded.
The app itself serves committed `dist`, so a committed package version without
a published GitHub Release and its four assets also blocks app deployment.
This can delay app-only fixes while a release needs recovery.

The root pointers name versions, so routine deployment must not be able to
advertise one that release authority has not published.
`scripts/build-schema-discovery-pointers.cjs` enforces that mechanically:

- It starts from the regenerated `dist/schemas/index.json` and refuses a
  source document whose aliases disagree with its own version list, whose
  `$id`/`$schema`/`channel` are not the expected literals, or that carries a
  malformed entry.
- `versions[]` keeps only the releases with a `schemas/<version>/` prefix in
  one delimited bucket listing. A truncated listing is refused.
- An alias (`latest_stable`, `v3`, `v3.2`, …) may only resolve to a release
  whose `schemas/<version>/index.json` object was confirmed with a HEAD. A
  prefix appears as soon as release publication writes its first object, and
  that publication is progressive and per-object, so prefix existence alone
  would let a half-uploaded release win an alias under an immutable cache
  policy. The deploy walks each line newest-first and stops at the first
  confirmation — typically one HEAD per release line.
- Every URL in the published document is derived from a validated version
  string; nothing but two prose fields is copied from the source.
- It refuses to move any pointer backwards relative to the copy currently
  served. The one exemption is a release the source marks `withdrawn` or
  `unpublished`, which is a deliberate editorial decision. Any other
  regression means the CDN no longer serves a release it advertises: recover
  that release, do not override the guard.

A release whose version directory never reached the CDN therefore keeps its
line pinned to the newest patch that is actually fetchable, and the deploy log
carries a `Schema versions missing from the CDN` warning naming the gap.

`scripts/verify-schema-discovery.mjs` then fetches the canonical public URLs
and fails the deploy unless they serve byte-for-byte what this run uploaded —
uploading is not serving. Note the scope: it proves the public document is
this run's, not that the document names the newest release of every line. A
line pinned one release back by a CDN gap passes, and the warning above is the
signal for that.

`npm run backfill:cdn-artifacts -- --bucket "$ADCP_ARTIFACT_R2_BUCKET"
--build-latest --latest-only --aws-dry-run` computes and prints both documents
against the live bucket without uploading anything, which is how to preview
pointer state during an incident.

Pointer currency follows the deploy, not the release: `release.yml` uploads
`schemas/<version>/` with `--version V --skip-latest` and still never touches
the pointers, so a new release is advertised by the next successful `main`
deploy that sees its prefix. Releases cut on a maintenance branch wait for the
forward merge into `main`.

Before [#8318](https://github.com/adcontextprotocol/adcp/issues/8318) no
workflow published these two objects at all: `--latest-only` excluded them and
`--version V --skip-latest` still does, so they froze at whatever the last
manual bulk backfill wrote while four releases shipped past them.

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
runs fail their current-branch fence before Changesets; a run already
publishing a committed release tolerates only the unrelated advances described
under publication-scoped freshness below. A later push with a stranded committed
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
After an acknowledged push, the PR read tolerates only the pulls API briefly
reporting the prior head (same PR, still Draft): it polls up to 10 times, one
second apart, and any other mismatch or a longer lag quarantines as before.

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

`scripts/check-release-state.cjs` has two freshness levels:

- **`current` (strict).** `origin/<branch>` must equal the tested SHA exactly.
  This guards everything that can lead to Changesets generation:
  `verify-release`'s "Require current release branch", the release job's
  checks before artifact detection, `pending`, `recovery`, `deploy.yml`, and
  every check in `scripts/fence-changesets.cjs` (including its pre-push hook).
  A regenerated Version Packages PR must be based on exact current main.
- **`publication-current` (publication-scoped).** Used only while publishing
  the already-committed release: inside `committed`, `published`, `approval`
  and `provenance`; in release.yml from "Require human approval for committed
  release artifacts" through the GitHub Release upload and the R2 publication
  (`backfill-cdn-artifacts.sh --version`); and for the per-object checks in
  `recover-protocol-cdn.yml` / `recover-cdn-version-trees.sh`, whose initial
  gates stay strict. It accepts a later branch head when the tested SHA is its
  ancestor (after fetching that head and checking that the fetched OID is the
  advertised one), the parsed `package.json` version is unchanged, and
  `git diff --no-renames` from the tested SHA touches none of:
  - this version's `dist/schemas/<v>/`, `dist/compliance/<v>/` and
    `dist/protocol/<v>.tgz*`, including mode, symlink and gitlink changes;
  - release identity: `.changeset/pre.json` and
    `.changeset/release-supersession.json`;
  - release status: `.changeset/withdrawn-release.json`,
    `scripts/build-schemas.cjs` (`RELEASE_STATUS_OVERRIDES`),
    `server/src/schemas-middleware.ts` and `workers/artifact-cdn/src/index.js`,
    so a withdrawal that lands mid-publication stops it;
  - the publication machinery: `release.yml`, `recover-protocol-cdn.yml`,
    `check-release-state.cjs`, `backfill-cdn-artifacts.sh`,
    `recover-cdn-version-trees.sh` and `check-protocol-bundle-parity.cjs`,
    so a fence fix that lands mid-run stops runs still executing the old logic.

  It logs the accepted advance. It compares the **net** TESTED..H diff, so a
  change to a protected path that a later commit fully reverts is accepted.

So unrelated pushes to the branch, such as app or test changes, no longer
invalidate publication. The strict fence prevented a stale run from publishing
over a newer release or over changed artifacts. Each of those changes still
refuses: a version bump, any change to this version's artifacts, a pre-mode,
supersession or release-status change, a publication-machinery change,
rewritten history, or a remote/Git failure. Approval, merge provenance,
signature verification and the byte-for-byte immutable-object checks are
unchanged.

On `main`, an ordinary push that is not a Version Packages merge skips the
storyboard matrix in `verify-release` (`generation_only`). Such a push only
regenerates the Draft Version Packages PR, which publishes nothing. That PR's
storyboard run happens in PR CI once it is marked ready (Drafts skip the
matrix), and publication requires that run (below) or full verification at
the release merge. The release job refuses to publish if a push it finds
committing release artifacts was classified `generation_only`. Without the
skip, generation waited about two hours behind verification and was staled by
the next unrelated merge, because generation still requires exact current
`main`. `main`'s own storyboard health is covered by
`training-agent-storyboards.yml` on storyboard-relevant pushes. Generation
still builds and signs a candidate tarball before any storyboard run; a
superseded candidate is never published, and its Sigstore signature attests
the producing workflow, not storyboard verification.

On `main`, a Version Packages merge also skips re-running the storyboard
matrix in `verify-release` when it is a provenance-verified release merge.
`check-release-state.cjs verified-merge`:
- finds exactly one merged release PR for the pushed SHA, with its head branch
  in this repository;
- checks `provenance` (exact base parent and identical tree);
- requires the release head not to change the storyboard harness relative to
  its base parent (`training-agent-storyboards.yml`, `scripts/run-storyboards*`,
  the schema/compliance builders, `server/tests/manual/run-storyboards.ts`,
  the training agent and `hosted-compliance-version.ts`);
- finds a completed, successful `pull_request` run of that workflow file on
  that exact head, PR branch and repository, in which every job succeeded and
  every job of the full matrix (`storyboardJobs`, kept equal to the workflow
  by `tests/release-workflow-immutability.test.cjs`) is present.

A Draft run whose matrix was skipped, a narrowed matrix, a fork run with the
same SHA, or a run from another branch does not count. Maintenance branches
always run full verification, because their PR runs use a different
candidate-version mode. If any of that can't be proven, verification runs
exactly as before. The skip changes only duplicate verification: the release
job's approval and provenance checks still run unchanged. On that full
fallback, the release job's strict start still strands the release if main
moves during the ~2h verification; recover it with an explicit dispatch.

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
committed bytes, and conditional missing-object creation.
`recover-protocol-cdn.yml` is the single dispatch for that. It accepts an
exact stable version or an exact `-beta.N` / `-rc.N` prerelease, and only a
version whose GitHub Release is published with the complete signed tuple; an
unpublished or superseded prerelease is refused.

### Recovering a release's CDN artifacts

A stable release whose objects never reached R2 does not announce itself. The
worker's pinned-semver fallback resolves `/schemas/3.0.28/...` to the newest
published release at-or-below it on the same line, so the request returns 200
with an *older release's* bytes. Only two signals distinguish that from a real
hit: the response carries `cache-control: public, no-cache, must-revalidate`
instead of the immutable policy an exact directory gets, and
`build-schema-discovery-pointers.cjs` refuses to advertise the release, so the
deploy log carries `::warning title=Schema versions missing from the CDN`
naming the gap and the line's alias stays pinned one release back (#8318,
#8324, #8347).

Nothing in the routine paths can close that gap. `release.yml` publishes only
the version in the current checkout's `package.json`; `--latest-only` excludes
every semver path; live bulk backfill is disabled. Recovery is a separate,
maintainer-dispatched authority:

```
gh workflow run recover-protocol-cdn.yml --ref main \
  -f version=<exact published semver> -f surfaces=all
```

`surfaces` defaults to `protocol` (the four signed tuple files, the original
scope of this workflow). `all` additionally recovers the immutable
`schemas/<version>/` and `compliance/<version>/` trees through
`scripts/recover-cdn-version-trees.sh`. The run:

- checks out tag `v<version>` and requires its `package.json` to hold exactly
  that version. The fence, the parity checker and the recovery script are
  copied from the dispatched branch before the tag checkout overwrites them, so
  recovery logic never comes from the artifact being recovered;
- verifies the committed signed tuple with `cosign verify-blob` against the
  `release.yml` identity and runs `check-release-state.cjs published`, which
  binds the tag to its GitHub Release and to the committed tuple bytes. Both
  happen on the protocol path, which always runs, so tree recovery inherits
  them;
- proves that the committed `dist/schemas/<v>` and `dist/compliance/<v>` trees
  are byte-for-byte the `schemas/` and `compliance/` trees inside that signed
  tarball (`scripts/check-protocol-bundle-parity.cjs`). R2 objects are
  unsigned, so this is what makes the release signature cover them. cosign's
  identity regexp binds the signing workflow, not the version, so the bundle's
  `adcp-<version>/` root directory is the load-bearing version binding. The
  only tolerated divergence is the bounded build timestamp
  `build-protocol-tarball.cjs` re-pins in `schemas/manifest.json` and
  `compliance/index.json` — the one field the signature does not cover, so it
  is constrained by shape and size instead. Any other difference, extra file or
  missing file fails the run before a single write;
- reads every published byte with `git cat-file blob`, never the working tree
  and never `git archive`, whose output is filtered by the tag's own
  `.gitattributes` (`export-subst` splices commit text into the bytes). It
  refuses any path that is not a regular blob with an unambiguous name and a
  known published content type, and re-checks each file's digest immediately
  before its write;
- writes conditionally (`If-None-Match: *`) and only where the object is
  confirmed missing. An existing object must already match byte-for-byte *and*
  carry the right content type; an inconclusive existence check aborts rather
  than reading as absent. Nothing is overwritten or deleted, and the root
  discovery pointers stay with the deploy path;
- re-checks the current-branch publication fence before and after every object,
  so a branch move mid-run stops publication;
- then fetches every recovered object from the public origin and requires the
  bytes, the immutable cache policy **and** the `ETag` to match. The ETag is
  the decisive one: R2 reports a single-part object's ETag as the body's hex
  MD5, so it proves a bucket object with exactly those bytes answered. Bytes
  and cache policy alone cannot, because on a miss the worker proxies to the
  Fly origin, which serves the same committed tree and stamps the same
  immutable policy for an exact pinned hit
  (`server/src/schemas-middleware.ts`).

The dispatch is idempotent and safe to re-run: a complete recovery reports
every object as already verified.

Operational notes:

- **It is slow.** Recovery fences the current branch before and after every
  object, exactly as release publication does, so ~770 objects means ~2,300
  `git ls-remote` round trips plus the S3 calls. Budget tens of minutes, and
  expect a transient failure to abort mid-run; re-dispatch resumes safely.
- **It runs from current `main` only.** The job is skipped for any other
  dispatch ref. Its initial gates (the preflight step, and the start of
  `recover-cdn-version-trees.sh` in both upload and verify modes) use the
  strict fence, so a stale re-run stops before doing anything.
- **Only a release-relevant branch move fails an object check.** The
  per-object fences use `publication-current` with the recovered version, so
  unrelated merges to `main` during an upload are accepted and logged. A push
  that bumps the package version, touches the recovered or current version's
  artifacts, or changes a release-identity, release-status or
  publication-machinery file still stops the job, possibly after some objects
  were published. Any `main` move before a later step's strict start (the tree
  upload or the tree verification) also stops that step. Re-dispatch to
  confirm.
- **The line alias moves as soon as the first object lands.** The worker
  resolves `v3`/`v3.0` from the R2 prefix listing, and a prefix exists after
  the first write, so mid-run those aliases already resolve to the version
  being recovered while its tree is incomplete. Objects not yet uploaded miss
  R2 and fall through to the origin. This is the same progressive-publication
  window `release.yml` has for a new release, not a new one, but it is a window
  — prefer running recovery when the line is quiet.
- The discovery pointers advance on the next successful `main` deploy that sees
  the new prefix, not as part of recovery.

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
An unrelated main commit during the publication phases is tolerated by
`publication-current`. A new main commit before artifact detection, or one that
changes the version, its artifacts or the release-authority files, requires
another explicit dispatch and verification of the new head. If a later package version has already landed,
stop for a separately reviewed historical recovery; this path refuses it.

### Superseding an unpublishable committed prerelease

An unpublished prerelease whose Version Packages merge lacks valid release
authority must not be recovered, retroactively approved, tagged, or uploaded.
Preserve its committed bytes and advance to a freshly generated candidate.
This path applies only to an `rc.N` while Changesets remains in `rc` pre mode.

Land a reviewed `.changeset/release-supersession.json` together with the
supersession gate. The marker binds the unpublishable version to its exact
release merge and protocol-tarball digest, explains why it cannot publish, and
lists every pending changeset with its digest. Mark that version `unpublished`
in generated and runtime release discovery so it cannot win a public alias.

After that plan merges, dispatch `release.yml` on the exact current `main` SHA:

```bash
MAIN_SHA=$(git ls-remote origin refs/heads/main | cut -f1)
gh workflow run release.yml --ref main \
  -f release_commit="$MAIN_SHA" \
  -f prepare_next=true
```

The workflow fails closed unless `main` is still that exact SHA, the named RC
artifacts remain byte-identical to their merge, no tag or GitHub Release exists,
the tarball and pending changesets match the reviewed digests, and the complete
pending changeset set advances the candidate. The new Version Packages commit
consumes the marker. Review that generated PR normally and require a non-author
maintainer approval on its final head before merge; only the new candidate may
publish.

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
## Maintained 3.1 publication authority

The 3.1 release workflow publishes only the exact committed version after current-branch and original release-merge provenance checks. Its final generated head needs approval from a non-author human with current repository write, maintain or admin permission. Existing approval on an older head does not authorize a refreshed candidate. Here, non-author means the release PR author; this check does not establish last-pusher independence. Independently verify the actual bot producer/run and final generated head before recording human approval.

This maintained-line policy overrides the older direct tag/public-release fallbacks in `cut-patch.md` and `cut-major.md`; do not use those fallbacks or their `--latest` flag for 3.1 publication. Keep the maintained branch unchanged until its publication run completes.

Changesets prepares the release PR without tagging or publishing. Publication requires all four committed signed tuple files; it never re-signs or rebuilds missing artifacts. Signature verification binds the original producer commit (the original release merge's first parent), maintained branch, repository and push event; it does not identify a particular run attempt. GitHub assets are byte-checked and staged as an exact four-file draft before publication. The workflow rechecks final-head review state and current maintainer permission after all four assets are read back, immediately before making the release public. R2 publication uses `--version VERSION --skip-latest`, preserves existing objects only when their bytes match, and conditionally creates missing objects. It cannot write historical versions, mutable aliases, CORS or deletions. CDN verification retries the full tuple and stops each attempt on any failed download or checksum before checking the signature. A failed or stale release remains held for separately reviewed recovery.

R2 object writes are individually atomic, not a bundle transaction. A branch move or storage failure after GitHub publication can leave the CDN version missing or partial. The failed publication/CDN verification run is the signal; the later `pending` check verifies GitHub only and does not certify R2 completeness. Do not rerun an obsolete workflow, bulk-backfill, or infer authority from a public tag alone. Hold publication and prepare a separately reviewed recovery plan tied to the original signed tuple, exact original release merge, current tested maintained head and current-version final-head human approval. Historical versions need separate explicit authorization. Any regenerated release candidate needs a fresh human review on its exact head. Maintenance publication explicitly preserves the repository's GitHub Latest alias.

Recovery dispatch checks out the current tested workflow commit and keeps the requested original release commit in `RELEASE_SHA`. The original release must still be an ancestor of the current supported branch. Its package version and all six artifact surfaces must match the current tested tree and local checkout; a later helper change does not replace the original signed producer. A newer package version requires a separately reviewed historical recovery plan.
