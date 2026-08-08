# Cut a 3.1.X Patch Release

Runbook for the stable `3.1.x` maintenance line. See `.agents/playbook.md`
§ Release lines for the patch contract.

The root protocol package is private. This process creates a tag, GitHub
Release, signed protocol bundle, CDN artifacts, and docs snapshot; it does not
publish `adcontextprotocol` to npm.

## 1. Audit and backport

Patch candidates land on `main` first. Inspect the merged commit before
backporting:

```bash
MAIN_SHA=<main-merge-sha>
git show "$MAIN_SHA" -- .changeset/
git cherry origin/3.1.x "$MAIN_SHA" "$MAIN_SHA^"
```

- A protocol changeset must say `"adcontextprotocol": patch`.
- `minor` or `major` is a stop; do not downgrade it on the maintenance branch.
- No changeset is correct for non-protocol docs/tooling, but those changes do
  not create a release by themselves.
- Confirm the change is absent from `3.1.x` and does not depend on 3.2-only
  fields, enums, tasks, or behavior.

Prepare a reviewed backport PR rather than pushing directly:

```bash
git fetch origin
git switch -c backport/3.1.x-<descriptor> origin/3.1.x
git cherry-pick "$MAIN_SHA"
git diff --check origin/3.1.x...HEAD
git push -u origin backport/3.1.x-<descriptor>
gh pr create --base 3.1.x --head backport/3.1.x-<descriptor>
```

Abort a conflict that reveals a 3.2 dependency. Resolve only changes whose
3.1 behavior remains patch-compatible, then run the focused tests plus schema,
compliance, typecheck, and Changesets status checks appropriate to the diff.

## 2. Review the Version Packages PR

After the backport merges, `release.yml` refreshes
`changeset-release/3.1.x`.

Before merging, verify:

- the body lists only `adcontextprotocol@3.1.X` under `Patch Changes`;
- no app, website, Addie, infrastructure, or operational entry leaked into
  the protocol changelog;
- `package.json`, `CHANGELOG.md`, versioned schemas/compliance, and
  `dist/protocol/3.1.X.tgz{,.sha256,.sig,.crt}` agree on the version; and
- required CI and human review are green.

If the body shows `Minor Changes` or `Major Changes`, stop and remove or
correct the offending changeset on `main` before rebuilding the backport.

## 3. Merge and verify (3.1.5 example)

Merge the Version Packages PR. The workflow tags the merge, creates the
GitHub Release, uploads four assets, publishes them to R2, and verifies the
CDN copy.

```bash
VERSION=3.1.5

git fetch origin --tags
test "$(git rev-parse "v$VERSION^{}")" = "$(git rev-parse origin/3.1.x)"
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

The GitHub Release must contain exactly the tarball, `.sha256`, `.sig`, and
`.crt` assets. Existing assets are immutable; never overwrite a digest
mismatch.

## 4. Complete downstream work

- Merge the automatic docs snapshot PR and confirm `dist/docs/3.1.5/` plus the
  stable `3.1` docs selector.
- Review and merge the automatic `3.1.x → main` forward-merge PR. Never merge
  `main` into `3.1.x`; main must retain its 3.2 pre-mode metadata and
  changesets.
- Confirm the tag targets the Version Packages merge and no release commits
  are stranded: `git log v3.1.5..origin/3.1.x` should be empty.

If automation fails after the Version Packages merge, prefer fixing and
rerunning the workflow. Use `.agents/shortcuts/cut-major.md` § 4 for manual
tag/release recovery only when rerun is unsafe or impossible.
