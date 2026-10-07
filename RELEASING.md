# Release Process

This document describes how to manage releases of the AdCP specification using Changesets.

## Overview

We use [Changesets](https://github.com/changesets/changesets) to manage versions and releases. Changesets automatically:

- Updates `package.json` version
- Updates all schema `adcp_version` defaults
- Updates documentation examples
- Generates CHANGELOG entries
- Prepares reviewed release packages (the guarded workflow publishes tags)

## Workflow

### 1. Making Changes

When you make changes to the protocol (adding features, fixing bugs, etc.):

```bash
npm run changeset
```

This will prompt you to:
1. Select the type of change (patch/minor/major)
2. Write a description of the change

A changeset file will be created in `.changeset/` directory. Commit this with your changes.

### 2. Preparing a maintained 3.0 release

Land protocol changes and their changesets through an ordinary source PR against
`3.0.x`. The normal release workflow then opens or updates a Version Packages PR.
Its producer runs `npm run version` to apply pending changesets, update package
and schema versions, generate release assets, and update the changelog.

Review the complete generated package, immutable assets, changelog and successful
checks on that PR. A current write/maintain/admin reviewer other than the PR
author must approve its exact final head before the normal release merge. New
source or regenerated assets require a new final-head approval.

Use `npm run version` only in the release producer or a reviewed scratch checkout
when diagnosing generation. Scratch output is not publication authority. Do not
cut a maintained release by directly committing and pushing version changes, or
by invoking the legacy `npm run release` convenience script.

### 3. Publishing maintained 3.0 releases

The `3.0.x` workflow prepares a Version Packages PR; Changesets does not tag or
publish it independently. A current write/maintain/admin reviewer other than the
PR author must approve the final generated head. The released tree and generation
base must match that approval before publication. A source change or regenerated
release head requires a new review; an approval on an earlier candidate does not
transfer.

After an approved release merge, the workflow requires the current tested branch,
the original merge SHA, matching committed package versions, and exact bytes,
file sets and modes across the schema, compliance and four protocol assets.
Missing signatures or certificates refuse publication; the publisher never
re-signs, rebuilds, or overwrites released assets. The certificate must identify
the maintained workflow, push event and repository, and the producer commit that
is the original release merge's first parent. The
reviewed generated head must have that same single base parent; a later tested
helper commit does not replace the certificate's producer. These checks do not
bind a specific workflow run ID.

A successful complete release inventory must establish zero or one matching
release. All four approved assets are staged in a draft and downloaded for byte
comparison before the draft becomes public. An existing public release is only
verified; it is not repaired by upload.
Maintained releases use `--latest=false` to preserve the main line's Latest alias.
The publisher rechecks final-head human approval and the reviewer's current
repository access after staging, immediately before making the draft public.

This maintained workflow publishes only the GitHub release tuple. It does not
write R2/CDN objects, mutable aliases, bucket policy or historical releases. A
failed publication stays withheld or draft and needs a reviewed recovery plan;
do not manually tag, re-sign, use `--clobber`, or rerun an obsolete workflow.
Verification trusts normal Git/GitHub tools and isolated Actions files; it does
not claim protection from a malicious process with the same OS user. File bytes
and mode checks use the same opened descriptor and refuse symlink leaves.

### Currentness and failure states

Merge a Version Packages PR only when its single generation parent is the current
`3.0.x` tip. A later push can make it stale, including a push that does not touch
release-relevant paths and therefore does not regenerate the package. Do not use
GitHub's "Update branch" merge or manually push version output to repair that
provenance. Land any needed source correction through a release-relevant PR and
let the normal producer regenerate the candidate; its new final head needs new
successful checks and human approval. Avoid unrelated pushes between generation
and the release merge.

A quarantined release merge or a branch advance during staging can leave
committed but unpublished artifacts or a draft. The pending-release check then
blocks subsequent ordinary pushes rather than generating the next package. A
retry on the unchanged current tip can use the normal guarded workflow if the
original authority and tuple still qualify. A published tuple is only verified.

If the branch has advanced or the guards still refuse, stop and prepare a separate
reviewed recovery plan identifying the original release merge and four-asset
tuple, the current tested maintained branch, unchanged release surfaces, and the
exact final-head human approval. The helper's `recovery` mode is a preflight, not
a wired publication dispatch or permission to mutate a release. There is no
automatic recovery path here. Do not retag, re-sign, rebuild, overwrite assets,
publish historical releases, or invoke an obsolete workflow to clear the block.

Before enabling these guards on an existing maintained line, verify its current
published tag and all four assets against the committed tuple. An incomplete or
different existing release requires a separately reviewed recovery plan; this
workflow does not repair it.

## Version Management

### Semantic Versioning

We follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.5.x): Bug fixes, documentation clarifications, schema fixes
  - Fix typos in schemas or docs
  - Correct validation patterns
  - Fix broken references

- **Minor** (0.x.0): New features, backward-compatible changes
  - Add new optional fields
  - Add new tasks
  - Add new enum values
  - Add new standard formats

- **Major** (x.0.0): Breaking changes
  - Remove or rename fields
  - Change field types
  - Make optional fields required
  - Remove enum values

### What Gets Versioned

When you run `npm run version`, these files are automatically updated:

1. **package.json**: The main version number
2. **Schema Registry** (`static/schemas/source/index.json`): `adcp_version` field and `lastUpdated` date

**That's it!** Version is maintained in only two places:
- The npm package version
- The schema registry (single source of truth for protocol version)

Individual request/response schemas and documentation do not contain version fields. Version is indicated by the schema path (`/schemas/latest/`) and the schema registry.

### Version corrections

Do not manually edit package versions or use `npm version` to cut a maintained
release. Correct the source or changeset in an ordinary PR against `3.0.x`, then
let the normal producer regenerate the Version Packages PR. Review and approve
the resulting exact final head again before publication; neither scratch version
output nor an earlier approval authorizes a replacement candidate.

## Best Practices

### Before Making Changes

1. **Check current version**: Look at `package.json`
2. **Review pending changesets**: Check `.changeset/` directory
3. **Consider impact**: Will this be patch, minor, or major?

### When Adding Features

1. Make your changes to code/docs/schemas
2. Run `npm run changeset` to create changeset
3. Select "minor" for new features
4. Write clear description of what was added
5. Commit both your changes and the changeset file

### When Fixing Bugs

1. Fix the bug
2. Run `npm run changeset`
3. Select "patch" for bug fixes
4. Describe what was fixed
5. Commit both the fix and the changeset

### When Making Breaking Changes

1. **Carefully consider** if the breaking change is necessary
2. Make your changes
3. Run `npm run changeset`
4. Select "major" for breaking changes
5. Write detailed description including migration path
6. Update migration documentation
7. Commit changes and changeset

## Release Checklist

Before releasing:

- [ ] All tests pass (`npm test`)
- [ ] Documentation is up to date
- [ ] CHANGELOG.md entries are accurate
- [ ] All changesets describe changes clearly
- [ ] Breaking changes have migration guides
- [ ] Schema validation works with new changes

After releasing:

- [ ] The approved Version Packages PR is merged into `3.0.x`
- [ ] The original release merge target and committed four-asset tuple are verified
- [ ] The guarded GitHub release is public with notes, preserving the main line's Latest alias
- [ ] Documentation site is updated
- [ ] Community is notified (if major/minor)

## Automation

For maintained `3.0.x` releases, the normal workflow uses Changesets to prepare a
Version Packages PR. Changesets does not independently tag or publish it. The
producer's version command applies changesets, updates the lockfile, builds
release schema, compliance and protocol artifacts with `--release`, and signs
the tarball through the normal producer's Sigstore flow. The guarded publisher
acts only after the reviewed release PR
merges.

The existing package scripts also support local diagnostics. Running them does
not replace the source PR, generated-package review, successful checks or exact
final-head approval. Do not use a manual commit/push, tag, signing command or the
legacy `npm run release` script as an alternative publication path.

## Troubleshooting

### Changesets not found

Install dependencies:
```bash
npm install
```

### Schema versions out of sync

The legacy `update-schema-versions` script only prints a migration notice.
Release schema versioning is performed by `build:schemas -- --release` inside
the normal producer. Diagnose in a reviewed scratch checkout, correct the source
or changeset through a maintained source PR, and let the producer regenerate the
reviewed candidate rather than manually publishing scratch output.

### Tests failing after version bump

The version command generates versioned output; it does not automatically run
the full test suite. The generated release PR must pass its normal checks.

If generation or checks fail, diagnose the failure in a reviewed scratch
checkout and fix the source or changeset through an ordinary PR against `3.0.x`.
Let the normal producer regenerate the Version Packages PR, then require its new
checks and exact final-head approval before the release merge. Re-running
`npm run version` in scratch is diagnostic only and does not authorize pushing
version output or publishing it.

## Questions?

For questions about the release process, open an issue on GitHub or reach out to the maintainers.
