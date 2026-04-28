# Cut a 3.0.X Patch Release

Runbook for cutting a patch release on the `3.0.x` line. Patches ship docs corrections, normative clarifications on stable surfaces, additive changes on experimental surfaces, or fixes to release tooling.

See `.agents/playbook.md` § Release lines for what counts as patch-eligible.

## Preconditions

- A patch-eligible fix has merged to `main` (the cherry-pick convention — see playbook).
- `3.0.x` branch exists and tracks the prior patch tag (`v3.0.1`, `v3.0.2`, …).

## 1. Cherry-pick the fix to 3.0.x

```bash
git checkout 3.0.x
git pull origin 3.0.x
git cherry-pick <main-sha>
git push origin 3.0.x
```

If the cherry-pick conflicts, resolve manually before pushing. Do not push a half-resolved cherry-pick.

## 2. Wait for the Version Packages PR

`release.yml` fires on push to `3.0.x`, runs `changesets/action`, and opens (or refreshes) the Version Packages PR on `changeset-release/3.0.x`. The PR title is `Version Packages` and its body lists `adcontextprotocol@3.0.X`.

## 3. Verify the patch is patch-eligible

Audit the consumed changeset(s) on the PR. **Any changeset bumping at `minor` or `major` should not be on `3.0.x`** — a minor on a patch line will cut `3.1.0` from `3.0.x`, which is wrong.

Audit:

```bash
git fetch origin changeset-release/3.0.x
for f in $(git ls-tree -r origin/changeset-release/3.0.x --name-only | grep '^\.changeset/.*\.md$' | grep -v README.md); do
  git show "origin/changeset-release/3.0.x:$f" 2>/dev/null | head -3
  echo "---"
done
```

If any non-patch changesets are on `3.0.x`, fix them on `main` first, cherry-pick the fix, and re-run the cycle.

## 4. CI gates

Per #3417, the Version Packages PR's required CI doesn't auto-fire. Either:

- Push a no-op commit from your identity (e.g., a CHANGELOG.md curated lead-in) to trigger CI, **or**
- `gh pr merge <pr#> --admin --merge` once review is satisfied

## 5. Merge

The Release workflow runs `npm run version` (writes `package.json: "version": "3.0.X"`, builds + signs the protocol tarball), creates the GitHub Release, and tags `v3.0.X`.

## 6. Trigger release-docs (until #3417 lands)

The `release-docs.yml` workflow doesn't auto-fire on `release: published` from `GITHUB_TOKEN`. Trigger manually:

```bash
gh api repos/adcontextprotocol/adcp/actions/workflows/release-docs.yml/dispatches \
  -X POST -f ref=main -f 'inputs[version]=3.0.X'
```

This snapshots `dist/docs/3.0.X/` and opens an auto-merging PR titled `chore: snapshot docs for v3.0.X`. Admin-merge that PR.

## 7. Forward-merge to main

The `forward-merge-3.0.yml` workflow opens a PR back to `main` automatically. Review (typically a near-no-op since the patch came from `main` originally) and merge.

## 8. Verification checklist

- [ ] Tag `v3.0.X` exists; GitHub Release renders
- [ ] `https://adcontextprotocol.org/protocol/3.0.X.tgz` returns 200
- [ ] `https://adcontextprotocol.org/schemas/3.0.X/` directory listing works
- [ ] Docs site at the `3.0` selector reflects the new patch content (Mintlify redeploy after snapshot PR merges)
- [ ] Forward-merge PR opened and merged so `main` includes the patch
- [ ] CHANGELOG.md on `main` has the new `## 3.0.X` block
