// Runs the trust.json v1 example and negative-case validator, including the
// one-agent-per-origin rule that JSON Schema cannot express.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('trust.json v1 examples validate and negative cases are rejected', () => {
  const script = path.join(__dirname, '..', 'specs', 'brand-identity-trust-split', 'validate.cjs');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
});
