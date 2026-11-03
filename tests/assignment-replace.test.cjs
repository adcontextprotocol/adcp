const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'static/schemas/source');
const readSchema = relativePath => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));

async function compileSyncRequest() {
  const ajv = new Ajv({
    allErrors: true, strict: false, discriminator: true,
    loadSchema: async uri => readSchema(uri.replace('/schemas/', '').split('#', 1)[0])
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('creative/sync-creatives-request.json'));
}

function replaceVariant() {
  return readSchema('creative/sync-creatives-request.json')
    .properties.assignment_operations.items.oneOf
    .find(variant => variant.properties.operation.const === 'replace');
}

const TRANSFERRED = [
  'weight', 'placement_ids', 'placement_refs', 'rotation_mode', 'group_id', 'sequence_position', 'trackers', 'landing_page_url'
];

const base = { account: { account_id: 'acct_acme' }, idempotency_key: 'assignment-replace-test-0001' };
const replace = { operation: 'replace', creative_id: 'hero_v2', replaces_creative_id: 'hero_v1', package_id: 'pkg_display' };

test('replace validates with or without weight and placement overrides, and pairs with a following assign', async () => {
  const validate = await compileSyncRequest();
  assert.equal(validate({ ...base, assignment_operations: [replace] }), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...base, assignment_operations: [{ ...replace, weight: 40, placement_ids: ['above_fold'] }] }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({
      ...base,
      assignment_operations: [
        replace,
        { operation: 'assign', creative_id: 'hero_v2', package_id: 'pkg_display', landing_page_url: 'https://acme.example/v2' }
      ]
    }),
    true,
    'transferred settings are changed with a following assign in the same atomic request'
  );
  assert.equal(
    validate({ ...base, assignment_operations: [{ ...replace, trackers: [{ event: 'impression', url: 'https://m.example/i' }] }] }),
    false,
    'replace transfers trackers rather than accepting new ones'
  );
});

test('the replace schema states that every authored setting transfers and that sellers reject rather than drop', () => {
  const variant = replaceVariant();
  for (const setting of TRANSFERRED) {
    assert.ok(variant.description.includes(setting), `replace description names ${setting}`);
  }
  assert.match(variant.description, /MUST reject the atomic request rather than drop or partially apply/);
  assert.match(variant.properties.replaces_creative_id.description, /transfer to creative_id/);
  assert.match(variant.properties.weight.description, /Omitted: the replaced assignment's weight transfers/);
  assert.match(variant.description, /Supplied placement_ids replaces the transferred placement routing entirely: neither the replaced assignment's placement_ids nor its placement_refs transfer/);
  assert.match(variant.properties.placement_ids.description, /Supplied: replaces the transferred routing entirely, including any placement_refs/);
});

test('sync_creatives documents the transfer and links it from the parameter table and sync modes', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/creative/task-reference/sync_creatives.mdx'), 'utf8');
  const start = doc.indexOf('### Replacing a creative on a package');
  assert.ok(start > 0, 'section exists');
  const section = doc.slice(start, doc.indexOf('\n### ', start + 1));
  for (const setting of TRANSFERRED) {
    assert.ok(section.includes(`\`${setting}\``), `section names ${setting}`);
  }
  assert.match(section, /MUST reject the atomic request/);
  assert.equal((doc.match(/\(#replacing-a-creative-on-a-package\)/g) || []).length >= 2, true, 'linked from table and sync modes');
});
