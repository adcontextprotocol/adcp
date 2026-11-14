/**
 * sync_creatives assignment operations are declared (adcp#8933).
 *
 * A seller lists the assignment_operations it accepts in
 * get_adcp_capabilities creative.assignment_operations. A seller that
 * declares creative.live_updates must list replace, because the
 * CREATIVE_LIVE_UPDATE_UNSUPPORTED recovery swaps in a new creative with a
 * replace, and every recovery that names replace or merge is conditional on
 * the seller listing it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/source');

function schema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));
}

async function compileCreativeCapabilities() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async uri => schema(uri.replace(/^\/schemas\//, '').split('#', 1)[0])
  });
  addFormats(ajv);
  const creative = schema('protocol/get-adcp-capabilities-response.json').properties.creative;
  return ajv.compileAsync({ $id: '/schemas/test/creative-capabilities.json', ...creative });
}

const livePolicy = { in_place: [{ change: 'trackers', serving: 'uninterrupted' }] };

test('creative.assignment_operations is a 3.3 list of the protocol operations', async () => {
  const field = schema('protocol/get-adcp-capabilities-response.json').properties.creative.properties.assignment_operations;
  assert.equal(field['x-added-in'], '3.3.0');
  assert.deepEqual(field.items.enum, ['assign', 'unassign', 'replace', 'merge']);
  assert.match(field.description, /accepts none/, 'absence means no operations');
  assert.match(field.description, /served at 3\.3 or later/, 'absence is scoped to responses that can carry the field');

  const validate = await compileCreativeCapabilities();
  assert.equal(validate({ assignment_operations: ['assign', 'unassign', 'replace'] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({}), true, 'the list is optional');
  assert.equal(validate({ assignment_operations: [] }), false, 'omit the list to accept none');
  assert.equal(validate({ assignment_operations: ['assign', 'assign'] }), false, 'operations are unique');
  assert.equal(validate({ assignment_operations: ['swap'] }), false, 'only protocol operations are listed');
});

test('a seller that declares live_updates lists replace', async () => {
  const validate = await compileCreativeCapabilities();
  const base = { has_creative_library: true, live_updates: livePolicy };
  assert.equal(validate(base), false, 'live_updates without the list');
  assert.equal(validate({ ...base, assignment_operations: ['assign', 'unassign'] }), false, 'live_updates without replace');
  assert.equal(
    validate({ ...base, assignment_operations: ['assign', 'unassign', 'replace'] }),
    true,
    JSON.stringify(validate.errors)
  );
});

test('listing merge needs the same library guarantees as supports_assignment_merge', async () => {
  const validate = await compileCreativeCapabilities();
  assert.equal(validate({ assignment_operations: ['merge'] }), false, 'merge needs a library with stable IDs');
  assert.equal(validate({ assignment_operations: ['merge'], has_creative_library: true }), false, 'merge needs stable IDs');
  assert.equal(
    validate({ assignment_operations: ['assign', 'merge'], has_creative_library: true, stable_creative_ids: true }),
    true,
    JSON.stringify(validate.errors)
  );
  const flag = schema('protocol/get-adcp-capabilities-response.json').properties.creative.properties.supports_assignment_merge;
  assert.match(flag.description, /assignment_operations is the authoritative declaration/);
  const library = { has_creative_library: true, stable_creative_ids: true };
  assert.equal(validate({ ...library, supports_assignment_merge: true }), false, 'the merge flag needs merge in the list');
  assert.equal(validate({ ...library, supports_assignment_merge: true, assignment_operations: ['assign'] }), false);
  assert.equal(
    validate({ ...library, supports_assignment_merge: true, assignment_operations: ['assign', 'merge'] }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(validate({ ...library, assignment_operations: ['merge'] }), true, 'listing merge without the flag is allowed');
});

test('compact sellers with a library list assign (verifier constraint)', () => {
  const field = schema('protocol/get-adcp-capabilities-response.json').properties.creative.properties.assignment_operations;
  assert.match(field.description, /buy_products or accept_proposal/);
  const rule = field['x-adcp-validation'].verifier_constraints.compact_lifecycle_assign;
  assert.match(rule.when, /served at 3\.3 or later/);
  assert.equal(rule.requires, 'creative.assignment_operations contains assign');
});

test('sync_creatives gates every operation on the declared list', () => {
  const ops = schema('creative/sync-creatives-request.json').properties.assignment_operations;
  assert.match(ops.description, /creative\.assignment_operations/);
  const gate = ops['x-adcp-validation'].verifier_constraints.capability_gate;
  assert.equal(gate.required_capability, 'creative.assignment_operations');
  assert.equal(gate.without_capability, 'UNSUPPORTED_FEATURE');
  const merge = ops.items.oneOf.find(variant => variant.properties.operation.const === 'merge');
  assert.equal(
    merge['x-adcp-validation'].verifier_constraints.capability_gate.required_capability,
    'creative.assignment_operations'
  );
  assert.match(merge['x-adcp-validation'].verifier_constraints.capability_gate.description, /must list merge/);
});

test('recoveries name replace only where the seller lists it', () => {
  const codes = schema('enums/error-code.json');
  assert.match(codes.enumDescriptions.CREATIVE_MERGE_REJECTED, /lists replace in creative\.assignment_operations/);
  assert.match(codes.enumMetadata.CREATIVE_MERGE_REJECTED.suggestion, /lists replace in creative\.assignment_operations/);
  // live_updates forces replace, so the live-update recovery has no other branch.
  for (const text of [codes.enumDescriptions.CREATIVE_LIVE_UPDATE_UNSUPPORTED, codes.enumMetadata.CREATIVE_LIVE_UPDATE_UNSUPPORTED.suggestion]) {
    assert.match(text, /every seller declaring creative\.live_updates lists in creative\.assignment_operations/);
    assert.doesNotMatch(text, /new package or media buy/);
  }
  const reasons = schema('enums/creative-merge-rejection-reason.json').enumDescriptions;
  for (const reason of ['content_mismatch', 'not_supported']) {
    assert.match(reasons[reason], /use replace where the seller lists replace in creative\.assignment_operations/i, reason);
  }
  assert.match(
    schema('error-details/creative-live-update-unsupported.json').description,
    /lists replace in creative\.assignment_operations/
  );
  assert.match(schema('core/error.json').properties.suggestion.description, /SHOULD name only operations and fields the agent declares/);
});
