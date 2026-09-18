# Artifact CDN Worker

This Worker serves the public AdCP artifact paths from the `adcp-artifacts` R2
bucket while preserving the path aliases currently handled by the Fly app.

## Shadow Deploy

Use the normal Worker config for shadow deploys. It only exposes the
`workers.dev` URL.

```sh
npm run deploy:cdn-artifacts-worker
npm run verify:cdn-artifacts-cutover
```

## Production Cutover

The cutover config is deliberately separate from `wrangler.toml` so a normal
Worker deploy does not attach production routes.

Before cutover, GitHub Actions must have R2 credentials so release and deploy
workflows keep the bucket fresh:

- `R2_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID` or `AWS_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY` or `AWS_SECRET_ACCESS_KEY`
- optional variable: `ADCP_ARTIFACT_R2_BUCKET` (defaults to `adcp-artifacts`)

Automation after these are set:

- `release.yml` uploads the newly published versioned artifacts after a real
  Changesets publish. Main-line releases also update mutable `latest`; release
  branches such as `3.0.x` use `--skip-latest` so they cannot move global
  `latest` backward.
- `deploy.yml` rebuilds and uploads mutable `latest` artifacts after the Fly
  deploy, machine-image check, tenant smoke, and console cleanup all pass.

1. Refresh mutable artifacts in R2.

   ```sh
   npm run backfill:cdn-artifacts -- --bucket adcp-artifacts --quiet
   ```

2. Verify the shadow Worker against current production.

   ```sh
   npm run verify:cdn-artifacts-cutover
   ```

3. Dry-run the routed deploy.

   ```sh
   npm run deploy:cdn-artifacts-cutover:dry-run
   ```

4. Attach the production routes.

   ```sh
   npm run deploy:cdn-artifacts-cutover
   ```

5. Verify the production routes now match the shadow Worker.

   ```sh
   npm run verify:cdn-artifacts-cutover -- \
     --reference https://adcp-artifacts-cdn.brian-8ca.workers.dev \
     --candidate https://adcontextprotocol.org
   ```

The cutover config routes only these paths:

- `/schemas` and `/schemas/*`
- `/compliance` and `/compliance/*`
- `/protocol` and `/protocol/*`

## Compliance publication integrity

Both release and deploy currently invoke `backfill-cdn-artifacts.sh`. Its
versioned sync and mutable `latest` copy must include nested `.jsonl` as
`application/x-ndjson; charset=utf-8`, alongside `.yaml`, `.yml`, `.json`,
`.md`, `.mdx`, and `.txt`. Pinned compliance objects use
`public, max-age=31536000, immutable`; `latest` uses
`public, no-cache, must-revalidate`.

The cutover verifier now reads **every regular file** beneath local semver
`dist/compliance/<version>/` directories, independent of extensions and of
incomplete remote discovery indexes. It requires HTTP 200 and exact local
bytes from the candidate. JSONL checks also require the MIME type and pinned
cache policy above. Root-level compiled server files and mutable `latest`
are outside this pinned inventory. The existing schema/protocol alias and
bundle comparisons still run by default; matching remote HTTP errors fail.

To verify selected versions against production without remote reference or
alias discovery, use a clean checkout containing the intended committed
artifacts and the corrected verifier:

```sh
npm run verify:cdn-artifacts-cutover -- \
  --candidate https://adcontextprotocol.org \
  --compliance-version 3.2.0-rc.0 \
  --compliance-version 3.2.0-rc.1 \
  --compliance-version 3.2.0-rc.2 \
  --compliance-version 3.2.0-rc.3
```

This is a read-only check. It does not build, upload, sign, or repair anything.
Without version selectors it checks all local semver compliance trees and
can take considerably longer than the original remote-discovery-only check.
The release workflow's existing automatic CDN verification still covers the
signed protocol tuple only; the scoped compliance check is an additional
operator verification, not a new workflow publication gate.

### JSONL omissions found on 2026-09-14

At main `af1ea2666d77a56e287567567daa72a301562e52`, these are the complete
committed semver compliance JSONL inventory. The independent public CDN audit
reported true HTTP 404 for all four:

| Version | Missing CDN key |
| --- | --- |
| `3.2.0-rc.0` | `compliance/3.2.0-rc.0/test-vectors/reporting-reconciliation/rows.jsonl` |
| `3.2.0-rc.1` | `compliance/3.2.0-rc.1/test-vectors/reporting-reconciliation/rows.jsonl` |
| `3.2.0-rc.2` | `compliance/3.2.0-rc.2/test-vectors/reporting-reconciliation/rows.jsonl` |
| `3.2.0-rc.3` | `compliance/3.2.0-rc.3/test-vectors/reporting-reconciliation/rows.jsonl` |

Each committed blob is 156 bytes with SHA-256
`735610f303d6d91aa618df3aa6d7f18bcf5dfa52bdbd9ef551293e6bd14c92d9`.
The implementation workspace independently confirmed the complete Git
inventory and digests. Its HTTP probes received an environment-level 403
for both JSONL and existing indexes, so the public 404 status is attributed
to the independent audit, not those probes. The rc.3 audit covered all
2,093 committed schema/compliance paths (1,612 schemas and 481 compliance):
2,092 matched SHA-256 and this JSONL was the sole missing object. The protocol
tarball and its three sidecars are four additional files.

Enumeration audit:

- `build-compliance.cjs` copies the complete source tree; `build-protocol-tarball.cjs`
  recursively copies and archives it. The four existing versioned tarballs
  already contain these exact JSONL bytes. No artifact regeneration is needed.
- Deploy and release both use the same backfill helper. Both its immutable
  sync and mutable copy omitted `.jsonl`; the fix covers both. Schema JSON,
  protocol tarball/sidecar, schema index/pointer, and `--skip-latest` behavior
  is unchanged.
- The committed semver compliance trees contain only `.yaml`, `.json`, `.md`,
  and `.jsonl`. Root-level `storyboard-runner-options` `.js`, `.d.ts`, and map
  files are compiled server outputs, not compliance release assets. There
  are no other omitted compliance release extensions in this inventory.
- `publish-schema-pr-bundle.yml` uploads a tarball/checksum/provenance tuple;
  it does not enumerate individual compliance files. `recover-protocol-cdn.yml`
  handles only stable protocol tarball/checksum/signature/certificate tuples,
  so it cannot recover these RC compliance objects. Release docs snapshots
  use Git/Mintlify, not the artifact R2 publisher.
- The Worker passes through R2 metadata and now recognizes JSONL when MIME
  metadata is absent. Missing files in an existing pinned prefix remain 404;
  the change does not alter alias resolution or missing-prefix fallback.

### Recovery and deployment handoff

1. Obtain human review and land the JSONL fix before recovery. Coordinate
   publication with [the publication gate PR #7510](https://github.com/adcontextprotocol/adcp/pull/7510);
   require independent combined validation and old-writer quiescence. This change
   performs no live deployment, release, tag, signing, workflow rerun, or R2
   mutation.
2. Once both fixes are present, rc.3 recovery uses an explicitly authorized
   `release.yml` workflow dispatch on current tested main, using its original
   approved `RELEASE_SHA`. This dispatch requires main's package version still
   to match rc.3. The original release commits are:

   | Version | Release commit |
   | --- | --- |
   | `3.2.0-rc.0` | `0a3672608d323c615e7ea73c9e8a62306510cb76` |
   | `3.2.0-rc.1` | `a42e86df500b176c8d9d1d6640dc7edbf2eb21a6` |
   | `3.2.0-rc.2` | `929ceb16090b2f11ad20348b889780097173b00a` |
   | `3.2.0-rc.3` | `71f9cd5414454e94ccfef87ce25777ead6fad228` |

   Older rc.0–rc.2 cannot use that dispatch. After separate explicit maintainer
   authorization, run the scoped helper from fresh verified current main for
   each version independently: set `TESTED_SHA` to that tested main SHA,
   `PUBLICATION_BRANCH=main`, and `RELEASE_SHA` to the original approved tag
   target above, then invoke `backfill-cdn-artifacts.sh --version VERSION
   --skip-latest` with the normal bucket/endpoint configuration. Do not use
   `--build-latest` or rerun an old-code workflow. Each original tag and published
   GitHub prerelease must already exist with the correct target/metadata, and all
   four GitHub tuple files must match the unchanged tagged/local bytes. Missing
   or conflicting release authority requires a separately reviewed recovery plan.

   Historical recovery authorization permits creation only of the one confirmed
   missing JSONL key per version. The scoped helper enumerates the whole version;
   `--version` alone does not enforce that one-key boundary. Require a complete
   inventory proving all other objects exist unchanged and an execution boundary
   enforcing the authorized key before proceeding. Any other missing object is a
   stop for a separately reviewed recovery plan, not permission to expand recovery.

   Restore the four keys above from their existing committed blobs. Check the exact
   release commit and any required release approvals. Recheck remote objects:
   preserve matching objects, stop on differing bytes or an ambiguous read
   failure, and create only confirmed missing objects with `If-None-Match: *`.
   Audit all committed schema/compliance and protocol paths for each version
   after its publication, including any partial attempt. Do not regenerate
   artifacts, overwrite immutable bytes, or use an unrestricted bulk backfill
   as a substitute for approved recovery.
3. Set the JSONL MIME type and immutable cache policy above. The fencing work's
   `--latest-only` routine deployment will not
   repair the four pinned versions. Refresh mutable JSONL only through the
   ordinary authorized latest publication path, using revalidation caching.
   Correct upload metadata is sufficient for the existing Worker to serve
   JSONL; deploy its MIME fallback through the normal reviewed Worker flow.
4. Run the scoped verification command above against production. Require all
   files in each selected compliance tree to match the reviewed checkout,
   including the four 156-byte JSONL objects and their metadata. Recheck the
   full rc.3 2,093-path inventory and the existing signed protocol tuple
   separately. Investigate any immutable-byte mismatch; never repair it by
   overwriting the release record. Do not assume a query-string cache buster
   bypasses the Worker's immutable cache (its cache key ignores queries).

### Separate release-ordering follow-up

[Deploy run 34845112730](https://github.com/adcontextprotocol/adcp/actions/runs/34845112730)
checked out `71f9cd5414454e94ccfef87ce25777ead6fad228` (Version Packages
[PR #7485](https://github.com/adcontextprotocol/adcp/pull/7485)). Its final main
SHA check was at 12:47:03 UTC. `Publish latest artifacts to R2` ran from
13:06:30 to 13:15:05 UTC and invoked the bulk backfill helper. Logs show the
rc.3 schema sync at 13:09:17 UTC and compliance syncs starting at 13:12:15 UTC,
without another main-SHA fence immediately before R2 use. Despite its name,
this deploy step also publishes committed versioned artifacts.

The independent release audit records human approval of #7485's exact head
`e7d42cbe` at 12:34:18 UTC, but no rc.3 tag or GitHub Release when deploy
progressively exposed the objects. The problem is publication ordering and
separate authorization/freshness gates; absence of release-PR approval is
not the finding. Work in `conductor/fix-release-publication-gate` owns deploy
and release fencing, concurrency/recovery, invocation modes, and freshness
checks. Keep those changes separate from the JSONL enumeration/MIME fix.
