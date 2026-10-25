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

async function compile(relativePath) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async uri => schema(uri.replace(/^\/schemas\//, '').split('#', 1)[0])
  });
  addFormats(ajv);
  return ajv.compileAsync(schema(relativePath));
}

const policy = {
  in_place: [
    { change: 'trackers', serving: 'uninterrupted' },
    { change: 'click_through', serving: 'uninterrupted' },
    { change: 'asset_content', serving: 'staged', on_rejection: 'keeps_prior' }
  ]
};

const pendingStaged = {
  status: 'pending_review',
  revision_id: 'rev_2026_11_02',
  change_kinds: ['asset_content'],
  staged_at: '2026-11-02T15:04:00Z'
};

test('live update policy allows on_rejection only on staged entries', async () => {
  const validate = await compile('core/live-update-policy.json');
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
  assert.equal(validate({ in_place: [] }), true, 'an empty list declares live creatives immutable');
  assert.equal(
    validate({ in_place: [{ change: 'trackers', serving: 'uninterrupted', on_rejection: 'keeps_prior' }] }),
    false,
    'on_rejection is meaningless outside staged'
  );
  assert.equal(validate({ in_place: [{ change: 'name', serving: 'uninterrupted' }] }), false, 'name is not a change kind');
});

test('capability requires a creative library and validates its policy', async () => {
  const validate = await compile('protocol/get-adcp-capabilities-response.json');
  const base = schema('protocol/get-adcp-capabilities-response.json');
  const creative = base.properties.creative;
  assert.equal(creative.properties.live_updates['x-status'], 'experimental');
  const libraryRule = creative.allOf.find(rule => JSON.stringify(rule.if) === JSON.stringify({ required: ['live_updates'] }));
  assert.ok(libraryRule, 'live_updates conditionally requires has_creative_library');
  assert.deepEqual(libraryRule.then.required, ['has_creative_library']);

  const liveUpdates = await (async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async uri => schema(uri.replace(/^\/schemas\//, '').split('#', 1)[0]) });
    addFormats(ajv);
    return ajv.compileAsync({ $id: '/schemas/test/live-updates-capability.json', ...creative.properties.live_updates });
  })();
  assert.equal(liveUpdates({ ...policy, max_propagation_seconds: 900 }), true, JSON.stringify(liveUpdates.errors));
  assert.equal(liveUpdates({ in_place: [{ change: 'format', serving: 'instant' }] }), false, 'serving modes are a closed enum');
  assert.equal(liveUpdates({ ...policy, max_propagation_seconds: -1 }), false, 'propagation bound is non-negative');
  assert.equal(typeof validate, 'function');
});

test('staged update requires a rejection reason exactly when rejected', async () => {
  const validate = await compile('core/creative-staged-update.json');
  assert.equal(validate(pendingStaged), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...pendingStaged, rejection_reason: 'early' }), false, 'pending updates carry no rejection reason');
  assert.equal(validate({ ...pendingStaged, status: 'rejected' }), false, 'rejected updates need a reason');
  assert.equal(validate({ ...pendingStaged, status: 'rejected', rejection_reason: 'Unsubstantiated claim' }), true);
  assert.equal(validate({ ...pendingStaged, status: 'approved' }), false, 'an approved update is promoted, not staged');
});

test('sync response and list_creatives carry staged_update beside the serving status', async () => {
  const syncResponse = await compile('creative/sync-creatives-response.json');
  const response = {
    status: 'completed',
    creatives: [{
      creative_id: 'acme_hero',
      action: 'updated',
      status: 'approved',
      staged_update: pendingStaged
    }]
  };
  assert.equal(syncResponse(response), true, JSON.stringify(syncResponse.errors));

  const listResponse = await compile('creative/list-creatives-response.json');
  const list = schema('creative/list-creatives-response.json');
  const row = list.properties.creatives.items.properties;
  assert.equal(row.live_updates.$ref, '/schemas/core/live-update-policy.json');
  assert.equal(row.staged_update.$ref, '/schemas/core/creative-staged-update.json');
  assert.equal(typeof listResponse, 'function');
});

test('status webhook allows approved to approved only for staged outcomes', async () => {
  const validate = await compile('creative/creative-status-changed-webhook.json');
  const base = {
    idempotency_key: 'whk_01HW9D2T3VXQ5M7K9N1P3R5S7U',
    notification_id: 'cs_acme_hero_1',
    notification_type: 'creative.status_changed',
    fired_at: '2026-11-02T16:00:00Z',
    subscriber_id: 'buyer-primary',
    account_id: 'acc_acme',
    creative_id: 'acme_hero',
    revision_id: 'rev_2026_11_02',
    transition: { from: 'approved', to: 'approved', observed_at: '2026-11-02T15:59:00Z' },
    reason_code: 'review_passed',
    initiator: 'seller'
  };
  assert.equal(validate(base), false, 'approved → approved without staged_update is not a transition');
  assert.equal(validate({ ...base, staged_update: { outcome: 'promoted' } }), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...base,
      reason_code: 'review_failure',
      staged_update: { outcome: 'rejected', rejection_reason: 'Unsubstantiated claim' }
    }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({
      ...base,
      transition: { from: 'approved', to: 'rejected', observed_at: '2026-11-02T15:59:00Z' },
      reason_code: 'review_failure',
      staged_update: { outcome: 'rejected', rejection_reason: 'Unsubstantiated claim' }
    }),
    true,
    'on_rejection stops reports approved → rejected'
  );
  assert.equal(
    validate({
      ...base,
      transition: { from: 'pending_review', to: 'approved', observed_at: '2026-11-02T15:59:00Z' },
      staged_update: { outcome: 'promoted' }
    }),
    false,
    'staged outcomes start from approved'
  );
});

test('refusal code and details are registered', async () => {
  const codes = schema('enums/error-code.json');
  assert.ok(codes.enum.includes('CREATIVE_LIVE_UPDATE_UNSUPPORTED'));
  assert.ok(codes.enumDescriptions.CREATIVE_LIVE_UPDATE_UNSUPPORTED.includes('creative.live_updates'));
  const validate = await compile('error-details/creative-live-update-unsupported.json');
  assert.equal(validate({ refused_changes: ['format'], live_package_ids: ['pkg_premium'] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ refused_changes: [] }), false, 'a refusal names at least one kind');
});
