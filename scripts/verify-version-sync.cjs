#!/usr/bin/env node

/**
 * Verify AdCP version sync between package.json and schema registry.
 *
 * The original check required strict equality (package.json ===
 * published_version === adcp_version). That caught the bug it was meant
 * to catch — someone bumps package.json but forgets to run
 * update-schema-versions, leaving the registry stale — but it was over-
 * strict for the dual-branch release model:
 *
 *   - 3.0.x release branch: a release commit pins package.json AND the
 *     registry to the same value (e.g., 3.0.4). Strict match holds.
 *   - main (dev): forward-merges from 3.0.x intentionally keep main's
 *     package.json at the in-progress dev version (`--ours` strategy
 *     introduced in #3807) while the registry pulls in the freshly
 *     released artifact (e.g., adcp_version: 3.0.4). package.json
 *     legitimately lags the registry until the next dev cycle bumps it.
 *
 * The semantic we actually want: the registry must NEVER fall BEHIND
 * package.json. That preserves the original catch (stale registry on a
 * pending release) while permitting the inverse (registry briefly ahead
 * of package.json during the forward-merge window).
 *
 * Rules:
 *   1. published_version (when set) and adcp_version legacy alias MUST
 *      agree with each other when both are present.
 *   2. Each registry version (published_version when set, adcp_version
 *      always) must be >= package.json by semver compare.
 *   3. published_version may be unset on `main` until the next time
 *      update-schema-versions runs; warn but do not fail. Once set, it
 *      becomes load-bearing.
 *
 * The release-time strict check still belongs in the release workflow
 * (CI can require strict equality on tagged commits without burdening
 * every developer's pre-push hook).
 */

const fs = require('fs');
const path = require('path');

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
);
const packageVersion = packageJson.version;

const registryPath = path.join(__dirname, '../static/schemas/source/index.json');
const schemaRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const publishedVersion = schemaRegistry.published_version;
const legacyAdcpVersion = schemaRegistry.adcp_version;

console.log('\n🔍 Verifying version synchronization...\n');
console.log(`  package.json version:               ${packageVersion}`);
console.log(`  schema registry published_version:  ${publishedVersion ?? '(unset)'}`);
console.log(`  schema registry adcp_version (legacy alias): ${legacyAdcpVersion}`);

/**
 * Compare two semver strings. Returns negative if a<b, positive if a>b,
 * zero if equal. Plain major.minor.patch only — no pre-release / build
 * metadata handling because the registry never carries those.
 */
function semverCompare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

const errors = [];
const warnings = [];

// Rule 1: published_version and adcp_version must agree when both are set.
if (publishedVersion !== undefined && legacyAdcpVersion !== undefined &&
    publishedVersion !== legacyAdcpVersion) {
  errors.push(
    `published_version (${publishedVersion}) and adcp_version legacy alias ` +
    `(${legacyAdcpVersion}) disagree — these MUST match each other.`
  );
}

// Rule 2: registry versions must not fall BEHIND package.json.
if (publishedVersion !== undefined &&
    semverCompare(publishedVersion, packageVersion) < 0) {
  errors.push(
    `published_version (${publishedVersion}) is BEHIND package.json ` +
    `(${packageVersion}). The registry must be at-or-ahead-of package.json — ` +
    `package.json was likely bumped without running update-schema-versions.`
  );
}
if (legacyAdcpVersion !== undefined &&
    semverCompare(legacyAdcpVersion, packageVersion) < 0) {
  errors.push(
    `adcp_version legacy alias (${legacyAdcpVersion}) is BEHIND package.json ` +
    `(${packageVersion}). The registry must be at-or-ahead-of package.json — ` +
    `package.json was likely bumped without running update-schema-versions.`
  );
}

// Rule 3: published_version unset is a warning, not a failure. Forward-
// merges may pull adcp_version forward without setting published_version
// (the field was added later); the next update-schema-versions run will
// populate it.
if (publishedVersion === undefined) {
  warnings.push(
    `published_version is unset in the schema registry. This is permitted ` +
    `during a forward-merge window but should be populated on the next ` +
    `update-schema-versions run.`
  );
}

if (errors.length > 0) {
  console.error('\n❌ Version sync check failed!\n');
  for (const err of errors) console.error(`  • ${err}`);
  console.error('\nTo fix, run:');
  console.error('  npm run update-schema-versions\n');
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn('\n⚠️  Version sync warnings:\n');
  for (const w of warnings) console.warn(`  • ${w}`);
}

const ahead =
  (publishedVersion !== undefined && semverCompare(publishedVersion, packageVersion) > 0) ||
  semverCompare(legacyAdcpVersion, packageVersion) > 0;
if (ahead) {
  console.log(
    `\n✅ Registry is ahead of package.json (forward-merge window). package.json ` +
    `will catch up on the next dev-version bump.`
  );
} else {
  console.log('\n✅ Versions are synchronized!\n');
}
