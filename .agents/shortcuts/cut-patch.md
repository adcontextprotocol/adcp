# Cut a 3.0.X Patch Release

Runbook for cutting a patch release on the `3.0.x` line. Patches ship docs corrections, normative clarifications on stable surfaces, additive changes on experimental surfaces, or fixes to release tooling.

See `.agents/playbook.md` § Release lines for what counts as patch-eligible.

> **Until #3417 lands:** several steps below require manual intervention because GitHub blocks workflows from firing on events triggered by `GITHUB_TOKEN`. Steps marked _§3417_ won't be needed once the App-token swap lands. Remove those steps in this runbook when #3417 closes.

## Preconditions

- A patch-eligible fix has merged to `main` (the cherry-pick convention — see playbook).
- `3.0.x` branch exists and tracks the prior patch tag (`v3.0.1`, `v3.0.2`, …).

## 1. Audit patch eligibility BEFORE cherry-picking

Before cherry-picking, inspect the changeset(s) added by the source commit on `main`:

```bash
MAIN_SHA=<main-merge-commit-sha>
git show "$MAIN_SHA" -- .changeset/ | head -30
```

Any frontmatter line `"adcontextprotocol": (minor|major)` is a stop. **Do not cherry-pick changes whose changeset bumps the protocol package above patch.** A minor on `3.0.x` would cut `3.1.0` from the patch line — exactly the failure mode this audit prevents.

If the source commit's only changesets are `--empty` or `"adcontextprotocol": patch`, proceed.

If the change is genuinely patch-eligible (per `.agents/playbook.md` § Patch eligibility) but the original commit shipped a higher bump, you'll need to author a fresh patch-level changeset for the cherry-pick. Land that on `main` first, then cherry-pick.

## 2. Cherry-pick the fix to 3.0.x

```bash
git checkout 3.0.x
git pull origin 3.0.x
git cherry-pick <main-sha>
```

If the cherry-pick conflicts, you have two options:

- **Resolve and continue** — only if the conflict is mechanical (line-noise rebase artifacts). Run `git cherry-pick --continue` after staging.
- **Abort** — `git cherry-pick --abort` and stop. Conflicting cherry-picks usually mean the fix depends on minor-line changes that aren't on `3.0.x`, which means the fix isn't patch-eligible as-is. Either author a 3.0.x-specific version of the fix on a fresh branch, or accept that the fix only ships in 3.1.x.

**Do not push a half-resolved cherry-pick.** When you've successfully completed the cherry-pick:

```bash
git push origin 3.0.x
```

## 3. Wait for the Version Packages PR

`release.yml` fires on push to `3.0.x`, runs `changesets/action`, and opens (or refreshes) the Version Packages PR on `changeset-release/3.0.x`. The PR title is `Version Packages` and its body lists `adcontextprotocol@3.0.X`.

**Verify the bump level on the PR body.** The body shows `## adcontextprotocol@3.0.X` and a `### Patch Changes` section. If you see `### Minor Changes` or `### Major Changes`, stop — a non-patch changeset slipped through. Find the offending changeset on `3.0.x` (`git diff v3.0.{X-1}..3.0.x -- .changeset/`), drop it, fix on `main`, re-cherry-pick.

## 4. CI gates _§3417_

The Version Packages PR's required CI doesn't auto-fire. Either:

- Push a no-op commit from your identity (e.g., a CHANGELOG.md curated lead-in) to trigger CI, **or**
- `gh pr merge <pr#> --admin --merge` once review is satisfied

## 5. Merge

The Release workflow runs `npm run version` (writes `package.json: "version": "3.0.X"`, builds + signs the protocol tarball), creates the GitHub Release, and tags `v3.0.X`.

**If the Release workflow fails after merge** (e.g., `changeset tag` silent no-op, cosign signing failure, tag creation rejected), recover manually following the same fallback pattern as `cut-major.md` § 4:

```bash
VERSION=3.0.X
MERGE_SHA=$(git rev-parse origin/main)
git tag -a "v$VERSION" "$MERGE_SHA" -m "AdCP $VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" --title "AdCP v$VERSION" --latest \
  --notes-file /tmp/release-notes.md \
  dist/protocol/$VERSION.tgz{,.crt,.sha256,.sig}
```

## 6. Trigger release-docs _§3417_

The `release-docs.yml` workflow doesn't auto-fire on `release: published` from `GITHUB_TOKEN`. Trigger manually:

```bash
VERSION=3.0.X
gh api repos/adcontextprotocol/adcp/actions/workflows/release-docs.yml/dispatches \
  -X POST -f ref=main -f "inputs[version]=$VERSION"
```

This snapshots `dist/docs/$VERSION/` and opens an auto-merging PR titled `chore: snapshot docs for v$VERSION`. Admin-merge that PR.

## 7. Forward-merge to main

The `forward-merge-3.0.yml` workflow opens a PR back to `main` automatically. Review (typically a near-no-op since the patch came from `main` originally) and merge. _§3417 — admin-merge required._

## 8. Verification checklist

- [ ] Tag `v3.0.X` exists; GitHub Release renders
- [ ] `https://adcontextprotocol.org/protocol/3.0.X.tgz` returns 200
- [ ] `https://adcontextprotocol.org/schemas/3.0.X/` directory listing works
- [ ] Docs site at the `3.0` selector reflects the new patch content (Mintlify redeploy after snapshot PR merges)
- [ ] Forward-merge PR opened and merged so `main` includes the patch
- [ ] No stranded patches: `git log v3.0.X..origin/3.0.x` is empty after forward-merge
- [ ] CHANGELOG.md on `main` has the new `## 3.0.X` block
