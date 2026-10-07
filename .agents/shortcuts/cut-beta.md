# Cut a Minor-Line Beta Series

Runbook for an AdCP `X.Y` prerelease cycle. It was written for 3.2 and applies
unchanged to later minors: substitute the line you are cutting for `X.Y`
(current cycle: **3.3**, so `X.Y.0-beta.N` is `3.3.0-beta.N`). The release order
is intentional:

1. `X.Y.0-beta.0` publishes the canonical protocol artifacts first.
2. SDK maintainers ingest beta.0 and publish compatible prereleases or releases.
3. `X.Y.0-beta.1` incorporates integration feedback, then a second SDK refresh
   makes it the first exact-version SDK-backed ecosystem checkpoint.

Do not wait for SDK publication before beta.0. Do not describe beta.0 as an
SDK-backed integration release.

## Version identities

Keep the three version forms distinct:

| Surface | beta.0 value | beta.1 value | 3.3 example (beta.0) |
|---|---|---|---|
| Release artifact and Git tag | `X.Y.0-beta.0` / `vX.Y.0-beta.0` | `X.Y.0-beta.1` / `vX.Y.0-beta.1` | `3.3.0-beta.0` / `v3.3.0-beta.0` |
| AdCP wire pin | `"X.Y-beta.0"` | `"X.Y-beta.1"` | `"3.3-beta.0"` |
| Mintlify version selector | `X.Y-beta` | `X.Y-beta` | `3.3-beta` |

The docs selector always points to the latest published beta snapshot. Published
prerelease artifacts remain immutable even after the selector advances.

## Scope gate for a short cycle

Minors are meant to be short. Keep the `X.Y.0` milestone to work that can merge
before beta.0 or a named later beta, and move everything else to the next
minor's milestone instead of letting it hold the line open:

- **Ship now:** scoped fixes and additive fields with no open design question.
  One focused PR each, with a changeset.
- **Working-group decision:** the issue carries `needs-wg-review`, a draft PR with
  the proposed additive change, and one `## WG decision brief (X.Y)` comment.
  The brief states the problem and who is pulling for it, then lists numbered
  yes/no or pick-one questions, each with a recommendation. Unresolved items at
  the scope freeze move to the next minor.
- **Next minor / Spec Backlog / 4.0:** large, speculative, dependency-blocked,
  or breaking work. Close landed or superseded issues with a comment naming the
  PR or successor issue.

Announce the freeze date when the WG session that ratifies the briefs is
scheduled. After the freeze, the milestone gains only beta-blocking fixes.

## Pre mode

`main` is in pre mode while `.changeset/pre.json` exists. Changesets owns the
complete file, including `initialVersions` and `changesets`; do not replace it
with a hand-authored minimal object. Confirm the required mode and tag with:

```bash
jq '{mode, tag}' .changeset/pre.json
# { "mode": "pre", "tag": "beta" }
```

The console form of `changeset status` reports only bump classes. Use its JSON
output for the exact-version gate:

```bash
changeset_status_file="$(mktemp)"
npx changeset status --output "$changeset_status_file"
jq -r '.releases[] | "\(.name)@\(.newVersion)"' "$changeset_status_file"
rm "$changeset_status_file"
# adcontextprotocol@X.Y.0-beta.0
```

## Cut beta.0: protocol first

### Preconditions

- The `X.Y` scope gate has classified every remaining `X.Y.0` milestone item as
  beta.0, later-beta, next-minor (`X.Y+1.0` milestone), or Spec Backlog work.
- Pending changesets contain only protocol schemas, normative documentation,
  compliance assets, release artifacts, or release-surface fixes.
- The curated `X.Y` release notes, beta program page
  (`docs/reference/X-Y-beta.mdx`), previous-to-`X.Y` migration guide
  (`docs/reference/migration/X-(Y-1)-to-X-Y.mdx`), and What's New page
  (`docs/reference/whats-new-in-X-Y.mdx`) are live and internally linked.
- Release-docs tooling knows the line's release-story pages: check
  `RELEASE_STORY_ALIASES` and `updateReleaseStoryAliases` in
  `scripts/update-release-docs-nav.mjs` cover `X.Y`, not only an earlier line.
- `npm run test:docs-nav`, `npm run test:owned-links`,
  `npm run test:release-docs-nav`, `npm run test:storyboards`, and the release
  workflow tests pass.
- `.changeset/pre.json` remains in beta pre mode.

### Changeset audit

Review every entry in the Version Packages PR and generated `CHANGELOG.md`
block. Remove source changesets for app, site, billing, admin, Addie,
newsletter, digest, dependency-only, CI-only, migration-only, hosted-service,
or other operational work. Empty changesets do not belong in the beta cut.

Do not hand-edit `CHANGELOG.md`; changesets owns it. Correct or remove the
source `.changeset/*.md` file on `main`, then wait for the release branch to
regenerate.

### Publish

1. Confirm the Version Packages PR names `adcontextprotocol@X.Y.0-beta.0`.
2. Review the generated schema, compliance, and protocol artifacts. In the
   beta.0 Version Packages PR, also change the public at-a-glance status to
   Beta and move beta.0 from the pending table to the published-prerelease table
   with its release date before merge.
3. Merge through normal review after required CI passes.
4. Confirm release automation creates the `vX.Y.0-beta.0` prerelease and
   publishes these four immutable assets:
   - `X.Y.0-beta.0.tgz`
   - `X.Y.0-beta.0.tgz.sha256`
   - `X.Y.0-beta.0.tgz.sig`
   - `X.Y.0-beta.0.tgz.crt`
5. Confirm `release-docs.yml` snapshots `dist/docs/X.Y.0-beta.0/` and adds or
   updates the `X.Y-beta` Mintlify selector.
6. Smoke-test the pinned schema, compliance, and protocol URLs. Do not point a
   stable `v3` alias at the prerelease.

### beta.0 announcement contract

Say explicitly that beta.0 is:

- the canonical protocol and schema input for SDK work;
- suitable for raw-wire, code-generation, validator, and sandbox testing;
- not yet the SDK-backed ecosystem checkpoint;
- immutable once published;
- expected to receive integration-driven corrections in beta.1.

Do not issue an `X.Y` verification badge from beta.0.

## SDK handoff after beta.0

For each supported SDK, record:

- the release or prerelease version;
- the exact AdCP bundle it embeds or downloads;
- supported roles and known gaps;
- the install command;
- the command that proves the SDK can load bundle `X.Y.0-beta.0`, negotiate wire
  pin `"X.Y-beta.0"`, and run its supported `X.Y` validation path.

SDK maintainers must use the signed beta.0 protocol tarball as their source.
They must not copy schemas from a moving `main` or `/schemas/latest/` snapshot.
Any required protocol correction lands on `main` with a changeset; beta.0 is
never rewritten.

## Cut beta.1: protocol convergence, then SDK confirmation

### Preconditions

- TypeScript, Python, and Go support for beta.0 is either published or
  explicitly marked unsupported/partial in the public compatibility matrix.
- Integration feedback from beta.0 is triaged. Accepted protocol corrections
  are merged with changesets; SDK-only bugs remain in the SDK repositories.
- The buyer/seller and generative integration scenarios in the public beta
  program have been run against beta.0, and their retained evidence identifies
  any corrections included in the beta.1 candidate.
- The release notes distinguish beta.1 changes from the cumulative `X.Y` story.
- Copy/paste install and validation commands have been tested against the
  published package versions.

### Publish the protocol checkpoint

Follow the beta.0 publication steps, expecting
`adcontextprotocol@X.Y.0-beta.1`. Then verify:

- wire callers pin `"X.Y-beta.1"` only when the peer advertises it;
- the `X.Y-beta` docs selector points at the beta.1 snapshot;
- older beta.0 artifacts and URLs still resolve;
- the initial beta.1 announcement calls it SDK-informed, not yet SDK-backed, and
  links to migration guidance, known issues, and the feedback path.

### Complete the beta.1 SDK confirmation

After the beta.1 protocol artifacts exist, SDK maintainers ingest the signed
`X.Y.0-beta.1` bundle and publish either an exact support statement or an
explicit unsupported/partial result. Then verify:

- SDK compatibility entries name exact package versions, supported roles, and
  beta.1 bundle support;
- copy/paste install and validation commands negotiate `"X.Y-beta.1"` against
  peers that advertise it;
- the buyer/seller and generative scenarios pass with the exact beta.1 SDK and
  protocol pair;
- only after those checks does public copy call beta.1 the SDK-backed ecosystem
  checkpoint.

Until this second refresh completes, an SDK generated from beta.0 may use a
beta.1 wire pin only when its maintainer explicitly documents forward
compatibility.

Later beta cuts repeat this protocol-tag-then-SDK-confirmation contract. A beta
number identifies an immutable protocol checkpoint, not a rolling channel.

## Curated release notes during beta

`CHANGELOG.md` records the changesets consumed by each individual beta cut. It
does not aggregate the full previous-to-`X.Y` story. Maintain one cumulative
`## Version X.Y.0` narrative in `docs/reference/release-notes.mdx`, and add a
short beta checkpoint table showing what each cut is for.

## Exit pre mode for X.Y stable

Do not exit pre mode until:

- `X.Y` is feature-complete;
- all stable-surface blockers are closed or explicitly deferred;
- the experimental-surface notice windows are satisfied;
- SDK and compliance matrices name exact stable-ready versions;
- GA docs contain no beta-only instructions on primary adoption paths;
- a short freeze for new minor changes is announced.

Run `npx changeset pre exit` in a dedicated PR. Between merging that PR and the
stable tag landing, do not merge new minor protocol changes. A normal line ships
GA as `X.Y.0`; 3.2 was the exception (GA shipped as `3.2.1` because `3.2.0` was
withdrawn; see `cut-minor-ga.md`). Audit the final
Version Packages PR exactly as for beta cuts.

## Verification checklist for every beta

- [ ] Expected `package.json` prerelease version
- [ ] Expected Git tag and GitHub prerelease
- [ ] Four signed/checksummed protocol assets attached
- [ ] Pinned protocol tarball URL resolves
- [ ] Pinned schema and compliance roots resolve
- [ ] Protocol discovery lists the new prerelease without changing stable aliases
- [ ] Release docs snapshot completed
- [ ] `X.Y-beta` selector points at the newest beta
- [ ] Generated changelog contains no non-protocol entries
- [ ] Cumulative release notes and beta checkpoint table are current
- [ ] Published earlier beta artifacts remain unchanged and accessible
