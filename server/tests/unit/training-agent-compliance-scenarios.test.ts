import { describe, expect, it } from 'vitest';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';
import {
  closedComplianceScenarioSet,
  complianceScenariosForServedVersion,
} from '../../src/training-agent/compliance-scenarios.js';

const THREE_ZERO_ENUM = [
  'force_creative_status',
  'force_account_status',
  'force_media_buy_status',
  'force_session_status',
  'simulate_delivery',
  'simulate_budget_spend',
];

// Scenarios the training agent implements that later releases added.
const POST_THREE_ZERO = [
  'force_create_media_buy_arm',
  'force_get_products_arm',
  'force_task_completion',
  'seed_product',
  'seed_measurement_catalog',
  'compact_product_lifecycle_probe',
  'reporting_core_lifecycle_probe',
  'expire_account_change_cursor',
];

describe('complianceScenariosForServedVersion', () => {
  it('reads the closed 3.0 set from the 3.0 capabilities schema', () => {
    expect([...closedComplianceScenarioSet('3.0') ?? []].sort()).toEqual([...THREE_ZERO_ENUM].sort());
  });

  it('keeps a 3.0 response valid against the 3.0 schema', () => {
    const scenarios = complianceScenariosForServedVersion([...THREE_ZERO_ENUM, ...POST_THREE_ZERO], '3.0');
    expect(scenarios).toEqual(THREE_ZERO_ENUM);

    const validate = getCanonicalToolValidator('get_adcp_capabilities', 'sync', { adcpVersion: '3.0' });
    const response = {
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['signals'],
      compliance_testing: { scenarios },
    };
    expect(validate?.(response), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...response, compliance_testing: { scenarios: [...THREE_ZERO_ENUM, ...POST_THREE_ZERO] } }))
      .toBe(false);
  });

  it.each(['3.1', '3.2'])('lists every scenario for %s, whose schema accepts any name', (version) => {
    expect(closedComplianceScenarioSet(version)).toBeNull();
    const all = [...THREE_ZERO_ENUM, ...POST_THREE_ZERO];
    expect(complianceScenariosForServedVersion(all, version)).toEqual(all);
  });

  it('leaves the list unchanged when the served bundle cannot be loaded', () => {
    expect(complianceScenariosForServedVersion(POST_THREE_ZERO, '9.9')).toEqual(POST_THREE_ZERO);
  });
});
