const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

test('accessibility compliance is registered in governance, not Content Standards', () => {
  const campaign = fs.readFileSync(path.join(root, 'docs/governance/campaign/index.mdx'), 'utf8');
  const syncPlans = fs.readFileSync(path.join(root, 'docs/governance/campaign/tasks/sync_plans.mdx'), 'utf8');

  assert.match(campaign, /`accessibility_compliance` \| Brand- or plan-required accessibility posture/);
  assert.match(campaign, /governance category, not a Content Standards category/);
  assert.match(syncPlans, /"category_id": "accessibility_compliance"/);
});
