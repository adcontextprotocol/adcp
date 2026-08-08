const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

test('accessibility compliance is documented as governance audit vocabulary only', () => {
  const campaign = fs.readFileSync(path.join(root, 'docs/governance/campaign/index.mdx'), 'utf8');
  const syncPlans = fs.readFileSync(path.join(root, 'docs/governance/campaign/tasks/sync_plans.mdx'), 'utf8');

  assert.match(campaign, /`accessibility_compliance` \| Accessibility posture evaluated by the agent's own policy model/);
  assert.match(campaign, /response\/audit vocabulary, not a policy-activation mechanism/);
  assert.match(campaign, /canonical 3\.2 format schemas do not yet define that typed contract/);
  assert.match(campaign, /belongs to governance rather than Content Standards/);
  assert.match(syncPlans, /Opaque agent-internal validation label for display and audit/);
  assert.match(syncPlans, /MUST NOT treat it as a protocol enum, policy activation, or typed format guarantee/);
  assert.doesNotMatch(syncPlans, /"category_id": "accessibility_compliance"/);
});
