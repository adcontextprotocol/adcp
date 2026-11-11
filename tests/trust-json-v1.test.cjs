// Runs the trust.json v1 example and negative-case validator, including the
// one-agent-per-origin rule that JSON Schema cannot express.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

test('trust.json v1 examples validate and negative cases are rejected', () => {
  const script = path.join(__dirname, '..', 'specs', 'brand-identity-trust-split', 'validate.cjs');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
});

test('published trustjson.org examples conform to their current source schemas', async () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'server/public/sites/trustjson/index.html'), 'utf8');
  const readSchema = async (uri) => {
    assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(root, 'static/schemas/source', uri.slice('/schemas/'.length)), 'utf8'));
  };
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: readSchema });
  addFormats(ajv);

  const examples = [...html.matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/g)];
  assert.ok(examples.length > 0, 'The publication guide must include examples');
  for (const [, attributes, body] of examples) {
    const schema = attributes.match(/data-schema="([^"]+)"/)?.[1];
    assert.ok(schema, 'Every published JSON example must declare its validation schema');
    const document = JSON.parse(body.replace(/^<code>/, '').replace(/<\/code>$/, ''));
    const validate = ajv.getSchema(schema) ?? await ajv.compileAsync(await readSchema(schema));
    assert.equal(validate(document), true, `${schema}: ${JSON.stringify(validate.errors)}`);
  }
});
