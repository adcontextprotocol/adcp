const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const schemaPath = path.join(
  __dirname,
  '../static/schemas/source/content-standards/artifact.json'
);
const artifactSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const accessBranches = artifactSchema.$defs.asset_access.oneOf;

function branch(method) {
  return accessBranches.find(
    (candidate) => candidate.properties?.method?.const === method
  );
}

test('deprecates only inline service-account credentials', () => {
  const serviceAccount = branch('service_account');

  assert.ok(serviceAccount, 'service_account access remains supported');
  assert.equal(serviceAccount.properties.credentials.deprecated, true);
  assert.ok(!serviceAccount.properties.authorized_principal);
  assert.deepEqual(serviceAccount.required, ['method', 'provider']);
});

test('keeps the three 3.2 access pathways available', () => {
  assert.deepEqual(
    accessBranches.map((candidate) => candidate.properties.method.const),
    ['bearer_token', 'service_account', 'signed_url']
  );
});

test('documents signed URLs as the recommended one-off path', () => {
  assert.match(branch('signed_url').description, /Recommended default/);
  assert.match(branch('bearer_token').description, /Short-lived/);
  assert.match(branch('service_account').description, /Credential-free/);
});
