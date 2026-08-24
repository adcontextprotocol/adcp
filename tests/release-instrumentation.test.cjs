const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'specs/release-instrumentation/3.2.json');
const expectedFeatureFamilies = [
  'agent_notifications',
  'audience_activation_candidate',
  'availability_and_outcome_planning',
  'campaign_governance_experimental',
  'canonical_creative_quality',
  'compact_media_buy_lifecycle',
  'creative_revisions_candidate',
  'delivery_reconciliation',
  'idempotency_retention_and_retry_binding',
  'measurement_tracking_candidate',
  'portable_attestations',
  'radio_and_place_based_audio_candidates',
  'request_signing_profile_3_2',
  'targeting_aware_discovery',
  'trusted_match_experimental',
  'webhook_delivery_identity_and_recovery',
];

test('3.2 feature families have explicit cross-surface instrumentation', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.match(manifest.release, /^3\.2\.0-beta\.\d+$/);
  assert.deepEqual(manifest.surfaces, ['docs', 'training_agent', 'compliance', 'training']);
  assert.ok(manifest.features.length >= 10, 'expected a comprehensive 3.2 feature-family inventory');

  const ids = new Set();
  for (const feature of manifest.features) {
    assert.match(feature.id, /^[a-z0-9_]+$/);
    assert.ok(!ids.has(feature.id), `duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
    assert.deepEqual(Object.keys(feature.surfaces).sort(), [...manifest.surfaces].sort(), `${feature.id} must disposition every surface`);

    for (const surfaceName of manifest.surfaces) {
      const surface = feature.surfaces[surfaceName];
      assert.ok(['covered', 'not_applicable', 'deferred'].includes(surface.status), `${feature.id}.${surfaceName} has an invalid status`);
      if (surface.status === 'covered') {
        assert.ok(Array.isArray(surface.evidence) && surface.evidence.length > 0, `${feature.id}.${surfaceName} needs evidence`);
        for (const relativePath of surface.evidence) {
          assert.equal(path.isAbsolute(relativePath), false, `${feature.id}.${surfaceName} evidence must be repo-relative`);
          assert.ok(fs.existsSync(path.join(root, relativePath)), `${feature.id}.${surfaceName} evidence does not exist: ${relativePath}`);
        }
      } else {
        assert.equal(typeof surface.reason, 'string', `${feature.id}.${surfaceName} needs a reason`);
        assert.ok(surface.reason.length >= 20, `${feature.id}.${surfaceName} reason is too terse`);
      }
    }
  }
  assert.deepEqual([...ids].sort(), expectedFeatureFamilies, '3.2 feature-family inventory drifted');
});
