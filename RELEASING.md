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

If the automated release fails after the Version Packages merge, fix and
rerun the workflow when safe. Manual tag/release recovery is the last resort:
the tag must target the Version Packages merge, and the same four signed
assets must be uploaded without overwriting an existing artifact with a
different digest. See `.agents/shortcuts/cut-major.md` for the fallback
commands.
