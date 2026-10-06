# Cut the AdCP 3.2 GA (ships as 3.2.1)

> **Line-specific.** This runbook records the 3.2 GA, which shipped as `3.2.1`
> because `3.2.0` was withdrawn. For a normal line (3.3 onward), GA ships as
> `X.Y.0`: skip the withdrawn-number steps (`skip-withdrawn-release.mjs`, the
> `## X.Y.1` changelog retitle, the `unpublished` discovery entry) and substitute
> the line being promoted for `3.2` and the previous stable line for `3.1`
> everywhere else. Also confirm `scripts/update-release-docs-nav.mjs` maps the
> new line's release-story aliases before tagging.

Ordered runbook for promoting the 3.2 release candidate line to its first
stable release. It builds on `cut-major.md` (generic stable cut) and
`RELEASING.md` (publication authority, verification, recovery). Where they
disagree for 3.2, this file wins.

Owner legend: **[H]** a human decision or approval is required. **[A]** the
workflow does it. **[H→A]** a human merges and automation follows. Do not
treat an agent's message as a human approval.

## Version identities

| Surface | Value |
|---|---|
| Release artifact and Git tag | `3.2.1` / `v3.2.1` |
| AdCP wire pin | `"3.2"` |
| Mintlify version selector | `3.2` |
| Withdrawn number | `3.2.0` (never tagged or released) |

`3.2.0` is permanently withdrawn. The accidental 2026-06-30 Version Packages
cut (`5dbe4ae`, reverted in #5769) left signed `3.2.0` schema, compliance, and
protocol artifacts on the artifact CDN with immutable caching. Those bytes are
never overwritten, deleted, or retired. Release discovery marks `3.2.0`
`unpublished`, so it never wins `latest_stable`, `v3`, or `v3.2`. The reviewed
marker `.changeset/withdrawn-release.json` makes the pre-exit Version Packages
cut produce `3.2.1`. See `scripts/skip-withdrawn-release.mjs`.

If the marker check fails at any step, **stop**. Do not delete or edit the
marker to get unblocked. Without it, `npm run version` refuses to generate
`3.2.0`.

## Phase 0: freeze and readiness

1. **[H]** Announce the freeze. Until `v3.2.1` is tagged, no normative wire
   or schema changes land. Allowed: compliance storyboard and test-vector
   fixes, docs, experimental annotations, tooling, training agent, and Addie.
   There is **no rc.8**. Pending changesets fold into the GA cut. Leave any
   regenerated Draft `Version Packages (rc)` PR as a Draft. Do not mark it
   Ready and do not merge it.
2. **[H]** Close each remaining 3.2 milestone item, or have its decision owner
   move it out explicitly.
3. **[H→A]** Merge the open `auto/docs-v3.2.0-rc.7` snapshot PR (#7705).
4. **[H]** Record the SDK disposition matrix: TypeScript `@adcp/sdk@14.0.0`,
   Python `adcp==8.0.0`, and the Go and Java plans. The protocol publishes
   first. The stable SDKs follow in lockstep and embed the signed `3.2.1`
   bundle.
5. **[H]** Audit every changeset that the exit cut will consume. That means
   the pending `.changeset/*.md` files **and** the archived
   `.changeset/pre/*.md` files. Use the loop in `cut-major.md` §2. Remove any
   non-protocol changeset through a PR to `main`.
6. **[H]** Confirm the withdrawn-release marker against the real history, the
   tag list, and GitHub Releases:

   ```bash
   GITHUB_REPOSITORY=adcontextprotocol/adcp \
     node scripts/skip-withdrawn-release.mjs check --remote
   # Verified withdrawn 3.2.0 -> 3.2.1 (passthrough at 3.2.0-rc.N).
   ```

7. **[H]** Freeze gates. All of these must pass on the exact GA candidate
   head (current `main`). Record the SHA and the run links in the pre-exit
   PR.
   - **Storyboards: zero failed steps.** Run `npm run test:storyboards` and
     `npm run test:storyboards:3.0-compat`. Every tenant must report 0 failed
     steps. The CI floors are not enough for GA: any failing step is a stop
     until it is fixed or explicitly waived by the maintainer.
   - Run `npm run test:release-workflow`, `npm run test:docs-nav`,
     `npm run test:owned-links`, and `npm run test:release-docs-nav`.
   - Dry run in a throwaway clone. Never use the working tree. A sparse
     checkout without `dist/` keeps the clone small.

     ```bash
     git clone --no-checkout https://github.com/adcontextprotocol/adcp.git /tmp/adcp-ga-dry
     cd /tmp/adcp-ga-dry
     git sparse-checkout set --no-cone '/*' '!/dist/'
     git checkout main
     npm ci --ignore-scripts
     npx changeset pre exit
     GITHUB_REPOSITORY=adcontextprotocol/adcp node scripts/skip-withdrawn-release.mjs preview
     # Changesets computes adcontextprotocol@3.2.0; Version Packages will produce adcontextprotocol@3.2.1 (skip).
     GITHUB_REPOSITORY=adcontextprotocol/adcp node scripts/version-packages.mjs
     node -p 'require("./package.json").version'   # 3.2.1
     head -5 CHANGELOG.md                           # ## 3.2.1 + withdrawn-number note
     cd / && rm -rf /tmp/adcp-ga-dry
     ```

## Phase 1: pre-GA machinery (lands before the exit)

8. **[H]** Review and merge each of these as its own PR:
   - Stable-minor docs promotion in `update-release-docs-nav.mjs`, with a
     test. Also a `'3.2'` release entry in `schema-tools.ts`. Without these,
     `release-docs.yml` throws for a stable `3.2` label.
   - `docs-nav-validation.test.cjs` and `broken-links.yml`, re-scoped from
     `3.1.x` to the new stable line.
   - `3.1.21` and `3.1.24` registered in
     `static/compliance/published-versions.json`, and `adcp-3.1` added to
     `npm_tags`.
9. **[H]** Deploy the CDN worker by hand after the withdrawn-release PR
   merges. No workflow deploys it. Run from an up-to-date `main`:

   ```bash
   npm run deploy:cdn-artifacts-worker
   curl -s https://adcontextprotocol.org/compliance/ \
     | jq '.versions[] | select(.version == "3.2.0-rc.7" or .version == "3.2.0-rc.5")'
   # rc.7: no superseded_by (3.2.0 is unpublished); rc.5: stability "unpublished"
   ```

## Phase 2: GA docs flip

10. **[H]** Open the GA-flip PR. It must merge **before** Version Packages,
    because the `v3.2.1` docs snapshot is a `git archive` of the tag.
    - Move every GA-facing page to GA wording. The release artifact is
      `3.2.1` and the wire pin is `"3.2"`. Say plainly that `3.2.0` was never
      released.
    - Update the `docs.json` banner.
    - Make `3.2` the default selector.
    - Make `3.1` non-default and remove its Latest tag.
    - Hide the `3.2-rc` and `3.2-beta` selectors per policy. Keep their
      artifacts.
    - Update the `RELEASING.md` and `playbook.md` topology.
    - Include an `adcontextprotocol` **patch** changeset, because
      `docs/reference/**` is protocol-scoped.

## Phase 3: pre-exit PR

11. **[H]** Open `chore(release): exit 3.2 prerelease mode`. The PR contains
    only the `npx changeset pre exit` change to `.changeset/pre.json`. Do
    not add a changeset: an empty one fails the scope gate. The
    withdrawn-release marker is already on `main`, so do not add or edit it
    here. In the PR body, include:
    - the freeze-gate results from step 7;
    - the `jq '{mode, tag}' .changeset/pre.json` output, which should be
      `exit` / `rc`;
    - the `skip-withdrawn-release.mjs check --remote` and `preview` output,
      which should say `skip` and `3.2.1`.

    Get maintainer approval, then merge. Until `v3.2.1` is tagged, merge no
    new minor protocol changesets.

## Phase 4: Version Packages and publication

12. **[A]** `release.yml` regenerates `changeset-release/main` as a Draft
    Version Packages PR. Its version step does the following, in order:
    - verifies the marker, including the tag and GitHub Release absence;
    - lets Changesets consume the complete pending and archived pool, which
      computes `3.2.0`;
    - retitles that changelog block to `## 3.2.1` with the withdrawn-number
      note;
    - sets the package to `3.2.1` and deletes the marker;
    - builds and signs the `3.2.1` artifacts.
13. **[H]** Mark the PR Ready and audit it. Check each item:
    - [ ] `package.json` and `package-lock.json` are `3.2.1`.
    - [ ] The `## 3.2.1` block is at the top of `CHANGELOG.md` and there is
      no `## 3.2.0` heading.
    - [ ] The block has no non-protocol entries.
    - [ ] `.changeset/pre.json` is deleted.
    - [ ] `.changeset/withdrawn-release.json` is deleted.
    - [ ] Every `.changeset/pre/*.md` file is deleted.
    - [ ] `dist/schemas/3.2.1/`, `dist/compliance/3.2.1/`, and
      `dist/protocol/3.2.1.tgz{,.sha256,.sig,.crt}` are present.
    - [ ] No `dist/**/3.2.0` path appears.
    - [ ] `published-versions.json` lists `3.2.1`, and `3.2.0` stays under
      `package_only_versions`.
    - [ ] The RC and beta artifacts are untouched:
      `git diff --stat origin/main -- 'dist/*/3.2.0-*'` is empty.

    Get a **non-author maintainer approval on the final head SHA**, then
    merge.
14. **[A]** `release.yml` checks the approval and provenance, stages the four
    assets in a draft, publishes `v3.2.1` as non-prerelease, uploads to R2
    with `--version 3.2.1 --skip-latest`, and verifies the CDN.
15. **[H]** Verify with the exact-version commands in `RELEASING.md`, using
    `VERSION=3.2.1`. Then:

    ```bash
    gh release list --json tagName,isLatest,isPrerelease \
      --jq '.[] | select(.tagName == "v3.2.1")'          # isLatest true, isPrerelease false
    curl -fsSI https://adcontextprotocol.org/schemas/v3/ | grep -i location     # /schemas/3.2.1/index.json
    curl -fsSI https://adcontextprotocol.org/schemas/v3.2/ | grep -i location   # /schemas/3.2.1/index.json
    curl -s https://adcontextprotocol.org/compliance/ \
      | jq '.latest_stable, (.versions[] | select(.version == "3.2.0-rc.7") | .superseded_by)'
    # "3.2.1" "3.2.1"
    curl -fsS https://adcontextprotocol.org/protocol/3.2.0.tgz.sha256
    # unchanged June bytes: 9fc36017...1e83
    ```

## Phase 5: CDN discovery

16. **[H]** Redeploy the worker (`npm run deploy:cdn-artifacts-worker`) if
    `main` changed it after step 9.
17. **[H]** Refresh the root `/schemas/index.json` and `/schemas/latest.json`.
    No script path refreshes them today:
    - release uploads use `--skip-latest`;
    - deploys use `--latest-only`, which excludes the root indexes;
    - `backfill-cdn-artifacts.sh` refuses `--version` without `--skip-latest`.

    Pick one of two ways:
    - land a reviewed tooling PR that adds a root-index-only mode before GA
      day; or
    - get explicit maintainer authorization for a tracked one-off under the
      publication-authority rules in `RELEASING.md`. It uploads exactly these
      two mutable files from the `v3.2.1` tag, with the headers the script
      uses.

    Never touch semver paths this way. The one-off, run with R2 credentials:

    ```bash
    git checkout v3.2.1
    for file in index.json latest.json; do
      aws s3 cp "dist/schemas/$file" "s3://$ADCP_ARTIFACT_R2_BUCKET/schemas/$file" \
        --endpoint-url "$R2_ENDPOINT" --no-guess-mime-type \
        --cache-control 'public, no-cache, must-revalidate' \
        --content-type 'application/json; charset=utf-8'
    done
    curl -s https://adcontextprotocol.org/schemas/index.json | jq .latest_stable   # "3.2.1"
    ```

## Phase 6: docs snapshot

18. **[A→H]** `release-docs.yml` opens `auto/docs-v3.2.1`. That PR adds
    `dist/docs/3.2.1/`, retargets the default `3.2` selector and its aliases,
    and updates `llms-current.md`. Review it, then merge it.

## Phase 7: SDK stable releases

19. **[H] (adcp-client)** Publish `@adcp/sdk@14.0.0`, embedding the signed
    `3.2.1` bundle.
    - Point the dist-tags `latest` and `adcp-3.2` at `14.0.0`.
    - Keep `adcp-3.1` on `13.1.x`.
    - Publish `13.1.2` without the stale June `compliance/cache/3.2.0`, then
      deprecate `13.1.1`.
20. **[H] (adcp-python)** Publish `adcp==8.0.0` on the `3.2.1` bundle.
    Record the Go and Java disposition.

## Phase 8: hosted surfaces (follow-up PR in this repo)

21. **[H]** One reviewed PR, following the #5647 precedent plus the training
    agent. It has no protocol changeset unless it touches protocol-scoped
    files.
    - `package.json`: set `@adcp/sdk` to `14.0.0`.
    - `published-versions.json`: add `adcp-3.2` to `npm_tags`.
    - Training agent: set `TRAINING_AGENT_CURRENT_ADCP_VERSION = '3.2'` and
      add `'3.2'` to the supported releases. Keep the unpinned default at
      `'3.0'`.
    - Set `SUPPORTED_BADGE_VERSIONS = ['3.2', '3.1', '3.0']`.
    - Hosted grading (#7689): update the `hosted-compliance-version.ts`
      preference, and grade `3.2.1` and `3.1.24`.
    - Update the selectable badges in `verification-profile-db.ts` and the
      OpenAPI examples.
    - Update the Addie tool descriptions and certification pins, the
      conformance-script defaults, and `BURNDOWN_MILESTONE_TITLE`.
    - Update the tests.
22. **[A]** Deploy. **[H]** Run the hosted-grading admin refresh, then close
    #7689.

## Phase 9: website and announcements

23. **[H]** Update the GA strip in `server/public/index.html` and give it a
    new dismissal cookie key. Smoke-check `docs.adcontextprotocol.org` for
    leftover RC wording.
24. **[H]** Make the announcements in `cut-major.md` §6: newsletter, Slack,
    LinkedIn, member email, and closing the `label:3.2` issues. Optionally,
    replace the generated GitHub Release body with curated notes that explain
    `3.2.1` and the withdrawn `3.2.0`.

## Phase 10: branch topology (same day)

25. **[H]** Create `3.2.x` from the `v3.2.1` Version Packages merge.
    - Add `3.2.x` to the branch lists in `release.yml` (both the push trigger
      and the dispatch case), `check-release-state.cjs`,
      `fence-changesets.cjs`, `build-check`, `changeset-check`, `codeql`,
      `dependency-review`, `apps-web-check`, `training-agent-storyboards`,
      and `release-workflow-immutability.test.cjs`.
    - Add `forward-merge-3.2.yml`.
    - Decide how long `3.1.x` stays a security and critical-fix line, and
      how fixes flow between `3.1.x`, `3.2.x`, and `main`.

    Patches on `3.2.x` continue as `3.2.2`, `3.2.3`, and so on.
26. **[H]** Land `npx changeset pre enter beta` on `main` for 3.3 right away.
    Otherwise minor changesets on `main` can cut an accidental stable
    release, as happened on 2026-06-30.
