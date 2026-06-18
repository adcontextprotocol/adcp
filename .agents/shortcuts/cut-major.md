# Cut a Major Release

Runbook for cutting a stable major version (e.g., 3.0.0 GA from 3.0.0-rc.N).
Patches and minors follow the same shape — just skip the "exit pre mode" step.

## Preconditions

- Current state is `3.0.0-rc.N` (or equivalent); `.changeset/pre.json` has `mode: "pre"`.
- Release notes + migration guide drafted in `docs/reference/release-notes.mdx`
  and `docs/reference/migration/prerelease-upgrades.mdx`.
- GA banner wording ready for `docs.json`.
- GA docs/site flip plan ready: version selector, default-version policy,
  release notes, migration guide, and SDK/package tags must stop presenting the
  release as RC/beta before announcements.

## 1. Exit prerelease mode

Land a single PR that:

- Runs `npx changeset pre exit` (flips `.changeset/pre.json` mode to `"exit"`).
- Adds the curated release narrative **only** to `release-notes.mdx` and
  `whats-new-*.mdx`. **Do NOT hand-write a `## 3.0.0` section in
  `CHANGELOG.md`** — `changeset version` owns that file. Hand-writing it
  creates a duplicate header when the action regenerates the release PR.
- Updates `docs.json` banner + default version.
- Updates Mintlify navigation so the stable version label is the final release
  (`3.0`, `3.1`, etc.), not the RC/beta selector. After the docs snapshot PR
  lands, the stable selector points at the final `dist/docs/<version>/`
  snapshot.
- Removes any "use N-1 for production" banners.
- Removes GA-facing RC/beta wording from release notes, versions, what's-new,
  and migration pages. Keep prerelease guidance only in prerelease archive or
  migration pages.

## 2. Audit the auto-generated Version Packages PR

After #1 merges, `changesets/action` regenerates the `changeset-release/main`
branch and opens/updates the Version Packages PR (title drops the `(rc)`
suffix, target version is `3.0.0`).

**Audit the consumed changesets** before merge:

```bash
for f in .changeset/*.md; do
  name=$(basename "$f" .md)
  [ "$name" = "README" ] && continue
  if grep -q '"adcontextprotocol"' "$f" 2>/dev/null; then
    bump=$(grep '"adcontextprotocol"' "$f" | head -1 | sed 's/.*: *//' | tr -d ' ')
    echo "$bump $name"
  fi
done | sort
```

Any changeset describing **website, admin, billing, newsletter, digest, Addie,
server-infra, migration-only, or operational work** should not exist at all.
Strip the `"adcontextprotocol": ...` line only as a temporary local diagnosis;
the durable fix is a PR to `main` that deletes the non-protocol changeset.

Keep only protocol/spec/release-surface changesets: schemas, task definitions,
compliance vectors, normative API/reference docs, release scripts, and generated
versioned dist artifacts.

Also inspect the Version Packages PR body and generated `CHANGELOG.md` block.
If a non-protocol entry appears under `adcontextprotocol@...`, stop. Do not
merge the Version Packages PR until the source changeset is removed from
`main` and `changesets/action` regenerates the release branch cleanly.

## 3. Don't manually edit `CHANGELOG.md` on `changeset-release/main`

If another PR merges to `main` between your edit and the Version Packages
merge, the action regenerates the branch and clobbers your edit. Push all
CHANGELOG source-of-truth changes to `main` via regular PRs first.

## 4. Merge the Version Packages PR

On merge, `release.yml` runs `changeset tag` + `createGithubReleases: true`.
Verify afterward:

```bash
# Tag exists
git fetch origin --tags && git tag -l "v3.0.0"

# GitHub Release exists
gh release view v3.0.0 --json tagName,isPrerelease,isDraft,assets

# Versioned tarball is served
curl -sI https://adcontextprotocol.org/protocol/3.0.0.tgz | head -3
curl -s https://adcontextprotocol.org/protocol/ | jq '.versions[].version'

# Docs snapshot PR auto-created and auto-merging
gh pr list --search "snapshot docs for v3.0.0" --state all
```

If `changeset tag` didn't create the tag (silent no-op), the most likely
cause is `privatePackages.tag` not set to `true` in `.changeset/config.json`
— private packages are skipped by default. If that's the issue, fix config
and create the tag/release manually:

```bash
git tag -a v3.0.0 <merge-sha> -m "AdCP 3.0.0"
git push origin v3.0.0
gh release create v3.0.0 --title "AdCP v3.0.0" --latest \
  --notes-file /tmp/release-notes.md \
  dist/protocol/3.0.0.tgz{,.crt,.sha256,.sig}
```

## 5. Post-release verification checklist

- [ ] `package.json` on `main` is `3.0.0` (no `-rc`)
- [ ] `.changeset/pre.json` deleted
- [ ] Tag `v3.0.0` pushed to GitHub
- [ ] GitHub Release `v3.0.0` published, marked latest, non-prerelease
- [ ] Release body references cosign verification + SHA-256
- [ ] 4 artifacts attached: `.tgz`, `.tgz.crt`, `.tgz.sha256`, `.tgz.sig`
- [ ] `release-docs.yml` workflow succeeded (snapshots `docs/` into `dist/docs/3.0.0/`)
- [ ] Auto-created "chore: snapshot docs for v3.0.0" PR merged
- [ ] `docs.adcontextprotocol.org` shows 3.0 as default and GA banner
- [ ] Public release notes, versions, what's-new, and migration pages describe
      the final GA release, not release-candidate validation
- [ ] SDK/package dist-tags for the new stable line point at the intended GA
      package, while old beta/RC package versions remain available
- [ ] Previously published RC/beta `dist/` artifacts are preserved, not deleted
      or rewritten
- [ ] `https://adcontextprotocol.org/protocol/3.0.0.tgz` serves the tarball
      (requires `!dist/protocol` in `.dockerignore` and Fly.io redeploy)
- [ ] `https://adcontextprotocol.org/protocol/` listing shows 3.0.0 in `versions[]`
- [ ] No duplicate `## 3.0.0` header in `CHANGELOG.md`
- [ ] No non-protocol entries in the autogen 3.0.0 CHANGELOG block

## 6. Announcements

- [ ] The Prompt newsletter pickup
- [ ] Slack announcement (#announcements + #adcp-community)
- [ ] LinkedIn post on AAO page + personal
- [ ] Member email via Addie
- [ ] Close tracking issues (search `label:3.0`)
