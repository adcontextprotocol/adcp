import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = process.env.HOSTED_COMPLIANCE_SMOKE_APP_ROOT || '/app';
const manifestPath = path.join(
  appRoot,
  'static',
  'compliance',
  'published-versions.json',
);
const servicePath = pathToFileURL(
  path.join(appRoot, 'dist/services/hosted-compliance-version.js'),
).href;

assert.ok(fs.existsSync(manifestPath), 'The runtime image must contain the compliance publication manifest');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema_version, 1);
assert.ok(
  Array.isArray(manifest.published_versions) && manifest.published_versions.length > 0,
  'The compliance publication manifest must contain published_versions',
);

// hosted-compliance-version resolves repository-relative paths from cwd.
process.chdir(appRoot);
const {
  hostedComplianceOptions,
  hostedComplianceTarget,
  resolveHostedComplianceVersion,
} = await import(servicePath);

for (const version of manifest.published_versions) {
  assert.equal(resolveHostedComplianceVersion(version), version);
  const target = hostedComplianceTarget(version);
  assert.equal(target.version, version);
  const options = hostedComplianceOptions(target);
  assert.equal(options.version, version);
  assert.ok(
    fs.existsSync(path.join(options.complianceDir, 'index.json')),
    `Missing hosted compliance bundle ${version}`,
  );
  assert.ok(
    fs.existsSync(path.join(options.schemaRoot, 'index.json')),
    `Missing hosted schema bundle ${version}`,
  );
}

console.log(
  `Hosted compliance runtime smoke passed for ${manifest.published_versions.length} published versions.`,
);
