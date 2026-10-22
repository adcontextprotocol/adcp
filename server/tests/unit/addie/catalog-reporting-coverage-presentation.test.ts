import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('@adcp/sdk/testing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  getComplianceStoryboardById: () => ({ id: 'media_buy_seller/advanced_delivery_reporting', phases: [] }),
  testCapabilityDiscovery: async () => ({
    profile: { adcp_supported_versions: ['3.2.5'], supported_protocols: ['media_buy'] }, steps: [],
  }),
}));
vi.mock('../../../src/compliance/catalog-reporting-runner.js', () => ({
  runCatalogReportingStoryboard: async () => mocks.result,
  runCatalogReportingStoryboardStep: vi.fn(),
}));
import { createMemberToolHandlers } from '../../../src/addie/mcp/member-tools.js';

const gap = { reason: 'fixture_unsatisfied', detail: 'No qualifying native sandbox product', fixtures: [] };
async function render() {
  return createMemberToolHandlers(null).get('run_storyboard')!({
    agent_url: 'https://seller.example/mcp',
    storyboard_id: 'media_buy_seller/advanced_delivery_reporting',
    compliance_target: '3.2.5',
  });
}

describe('Addie reporting fixture coverage presentation', () => {
  beforeEach(() => {
    mocks.result = { storyboard_title: 'Catalog reporting', overall_passed: true,
      passed_count: 0, failed_count: 0, skipped_count: 0, total_duration_ms: 0,
      phases: [], coverage_gaps: [gap] };
  });
  it('does not present an unexercised fixture gap as a reporting pass', async () => {
    const text = await render();
    expect(text).toContain('INCOMPLETE — coverage gap');
    expect(text).toContain('Not applicable for this run');
    expect(text).toContain('fixture_unsatisfied');
    expect(text).toContain(gap.detail);
    expect(text).not.toContain('**Result:** PASSED');
    expect(mocks.result.overall_passed).toBe(true); // Raw SDK/accounting unchanged.
  });
  it('retains a real failure even when a coverage gap also exists', async () => {
    mocks.result.overall_passed = false;
    mocks.result.failed_count = 1;
    const text = await render();
    expect(text).toContain('**Result:** FAILED');
    expect(text).toContain('fixture_unsatisfied');
  });
  it('retains the normal success label for executed support without gaps', async () => {
    mocks.result.coverage_gaps = [];
    mocks.result.passed_count = 5;
    expect(await render()).toContain('**Result:** PASSED');
  });
});
