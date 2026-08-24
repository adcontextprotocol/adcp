# Cut the AdCP 3.2 Beta Series

Runbook for the AdCP 3.2 prerelease cycle. The release order is intentional:

1. `3.2.0-beta.0` publishes the canonical protocol artifacts first.
2. SDK maintainers ingest beta.0 and publish compatible prereleases or releases.
3. `3.2.0-beta.1` incorporates integration feedback, then a second SDK refresh
   makes it the first exact-version SDK-backed ecosystem checkpoint.

Do not wait for SDK publication before beta.0. Do not describe beta.0 as an
SDK-backed integration release.

## Version identities

Keep the three version forms distinct:

| Surface | beta.0 value | beta.1 value |
|---|---|---|
| Release artifact and Git tag | `3.2.0-beta.0` / `v3.2.0-beta.0` | `3.2.0-beta.1` / `v3.2.0-beta.1` |
| AdCP wire pin | `"3.2-beta.0"` | `"3.2-beta.1"` |
| Mintlify version selector | `3.2-beta` | `3.2-beta` |

The docs selector always points to the latest published beta snapshot. Published
prerelease artifacts remain immutable even after the selector advances.

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
# adcontextprotocol@3.2.0-beta.0
```

## Cut beta.0: protocol first

### Preconditions

- The 3.2 scope gate has classified every remaining milestone item as beta.0,
  later-beta, 3.3, or Spec Backlog work.
- Pending changesets contain only protocol schemas, normative documentation,
  compliance assets, release artifacts, or release-surface fixes.
- The curated 3.2 release notes, beta program page, 3.1-to-3.2 migration guide,
  and What's New page are live and internally linked.
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

1. Confirm the Version Packages PR names `adcontextprotocol@3.2.0-beta.0`.
2. Review the generated schema, compliance, and protocol artifacts. In the
   beta.0 Version Packages PR, also change the public at-a-glance status to
   Beta and move beta.0 from the pending table to the published-prerelease table
   with its release date before merge.
3. Merge through normal review after required CI passes.
4. Confirm release automation creates the `v3.2.0-beta.0` prerelease and
   publishes these four immutable assets:
   - `3.2.0-beta.0.tgz`
   - `3.2.0-beta.0.tgz.sha256`
   - `3.2.0-beta.0.tgz.sig`
   - `3.2.0-beta.0.tgz.crt`
5. Confirm `release-docs.yml` snapshots `dist/docs/3.2.0-beta.0/` and adds or
   updates the `3.2-beta` Mintlify selector.
6. Smoke-test the pinned schema, compliance, and protocol URLs. Do not point a
   stable `v3` alias at the prerelease.

### beta.0 announcement contract

Say explicitly that beta.0 is:

- the canonical protocol and schema input for SDK work;
- suitable for raw-wire, code-generation, validator, and sandbox testing;
- not yet the SDK-backed ecosystem checkpoint;
- immutable once published;
- expected to receive integration-driven corrections in beta.1.

Do not issue a 3.2 verification badge from beta.0.

## SDK handoff after beta.0

For each supported SDK, record:

- the release or prerelease version;
- the exact AdCP bundle it embeds or downloads;
- supported roles and known gaps;
- the install command;
- the command that proves the SDK can load bundle `3.2.0-beta.0`, negotiate wire
  pin `"3.2-beta.0"`, and run its supported 3.2 validation path.

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
- The release notes distinguish beta.1 changes from the cumulative 3.2 story.
- Copy/paste install and validation commands have been tested against the
  published package versions.

### Publish the protocol checkpoint

Follow the beta.0 publication steps, expecting
`adcontextprotocol@3.2.0-beta.1`. Then verify:

- wire callers pin `"3.2-beta.1"` only when the peer advertises it;
- the `3.2-beta` docs selector points at the beta.1 snapshot;
- older beta.0 artifacts and URLs still resolve;
- the initial beta.1 announcement calls it SDK-informed, not yet SDK-backed, and
  links to migration guidance, known issues, and the feedback path.

### Complete the beta.1 SDK confirmation

After the beta.1 protocol artifacts exist, SDK maintainers ingest the signed
`3.2.0-beta.1` bundle and publish either an exact support statement or an
explicit unsupported/partial result. Then verify:

- SDK compatibility entries name exact package versions, supported roles, and
  beta.1 bundle support;
- copy/paste install and validation commands negotiate `"3.2-beta.1"` against
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
does not aggregate the full 3.1-to-3.2 story. Maintain one cumulative
`## Version 3.2.0` narrative in `docs/reference/release-notes.mdx`, and add a
short beta checkpoint table showing what each cut is for.

## Exit pre mode for 3.2 stable

Do not exit pre mode until:

- 3.2 is feature-complete;
- all stable-surface blockers are closed or explicitly deferred;
- the experimental-surface notice windows are satisfied;
- SDK and compliance matrices name exact stable-ready versions;
- GA docs contain no beta-only instructions on primary adoption paths;
- a short freeze for new minor changes is announced.

Run `npx changeset pre exit` in a dedicated PR. Between merging that PR and the
`v3.2.0` tag landing, do not merge new minor protocol changes. Audit the final
Version Packages PR exactly as for beta cuts.

## Verification checklist for every beta

- [ ] Expected `package.json` prerelease version
- [ ] Expected Git tag and GitHub prerelease
- [ ] Four signed/checksummed protocol assets attached
- [ ] Pinned protocol tarball URL resolves
- [ ] Pinned schema and compliance roots resolve
- [ ] Protocol discovery lists the new prerelease without changing stable aliases
- [ ] Release docs snapshot completed
- [ ] `3.2-beta` selector points at the newest beta
- [ ] Generated changelog contains no non-protocol entries
- [ ] Cumulative release notes and beta checkpoint table are current
- [ ] Published earlier beta artifacts remain unchanged and accessible
