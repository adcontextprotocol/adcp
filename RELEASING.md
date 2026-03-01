# Release Process

This document describes how to manage releases of the AdCP specification using Changesets.

## Overview

We use [Changesets](https://github.com/changesets/changesets) to manage versions and releases. Changesets automatically:

- Updates `package.json` version
- Updates all schema `adcp_version` defaults
- Updates documentation examples
- Generates CHANGELOG entries
- Creates git tags

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

### 2. Creating a Release

When ready to release:

```bash
npm run version
```

This will:
- Apply all pending changesets
- Update `package.json` version
- Run `scripts/update-schema-versions.js` to sync all schemas and docs
- Update CHANGELOG.md

Review the changes, then commit:

```bash
git add -A
git commit -m "Version packages"
git push
```

Or use the convenience script:

```bash
npm run release
```

### 3. Tagging the Release

After the version commit is merged to main:

```bash
git tag -a v0.5.0 -m "Release v0.5.0"
git push origin v0.5.0
```

Then create a GitHub release from the tag.

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

### Manual Version Updates (Not Recommended)

If you need to manually update versions (avoid this - use Changesets instead):

```bash
# Update package.json version
npm version 0.6.0 --no-git-tag-version

# Run the sync script
npm run update-schema-versions

# Commit changes
git add -A
git commit -m "Bump version to 0.6.0"
```

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

- [ ] Version commit is pushed to main
- [ ] Git tag is created and pushed
- [ ] GitHub release is created with notes
- [ ] Documentation site is updated
- [ ] Community is notified (if major/minor)

## Automation

Our version management is automated through npm scripts:

```json
{
  "changeset": "changeset",
  "version": "changeset version && npm run update-schema-versions",
  "update-schema-versions": "node scripts/update-schema-versions.js",
  "release": "npm run version && npm test && git add -A && git commit -m 'Version packages' && git push"
}
```

The `scripts/update-schema-versions.js` script updates the schema registry version to match package.json.

## Troubleshooting

### Changesets not found

Install dependencies:
```bash
npm install
```

### Schema versions out of sync

Run the sync script:
```bash
npm run update-schema-versions
```

### Tests failing after version bump

The version script runs tests automatically. If they fail:
1. Check what broke
2. Fix the issue
3. Commit the fix
4. Re-run `npm run version`

## Questions?

For questions about the release process, open an issue on GitHub or reach out to the maintainers.
