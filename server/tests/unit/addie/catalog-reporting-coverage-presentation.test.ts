import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ result: {} as Record<string, unknown>, options: {} as Record<string, unknown> }));
vi.mock('@adcp/sdk/testing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  getComplianceStoryboardById: (id: string) => ({ id, phases: [] }),
  testCapabilityDiscovery: async () => ({
    profile: { adcp_supported_versions: ['3.2.5'], supported_protocols: ['media_buy'] }, steps: [],
  }),
}));
vi.mock('../../../src/compliance/catalog-reporting-runner.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/compliance/catalog-reporting-runner.js')>()),
  runCatalogReportingStoryboard: async (_url: unknown, _storyboard: unknown, options: Record<string, unknown>) => { mocks.options = options; return mocks.result; },
  runCatalogReportingStoryboardStep: vi.fn(),
}));
import { createMemberToolHandlers } from '../../../src/addie/mcp/member-tools.js';

const gap = { reason: 'fixture_unsatisfied', detail: 'No qualifying native sandbox product', fixtures: [] };
async function render(storyboardId = 'media_buy_seller/advanced_delivery_reporting') {
  return createMemberToolHandlers(null).get('run_storyboard')!({
    agent_url: 'https://seller.example/mcp',
    storyboard_id: storyboardId,
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
    expect(text).toContain('NOT APPLICABLE — no qualifying product in your wholesale sandbox catalog (feature not tested)');
    expect(text).toContain('Not applicable for this run');
    expect(text).toContain('fixture_unsatisfied');
    expect(mocks.options.signal).toBeInstanceOf(AbortSignal);
    expect(text).toContain(gap.detail);
    expect(text).not.toContain('**Result:** PASSED');
    expect(mocks.result.overall_passed).toBe(true); // Raw SDK/accounting unchanged.
  });
  it('does not describe another protocol fixture gap as wholesale reporting nonsupport', async () => {
    const text = await render('creative_agent/creative_upload');
    expect(text).toContain('INCOMPLETE — coverage gap');
    expect(text).not.toContain('no qualifying product in your wholesale sandbox catalog');
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
  it.each([
    "collection_selection",
    "collection_default_materialization",
    "fixed_bundle_enforcement",
    "fixed_bundle_restatement",
    "owner_sold_channel_carriage",
    "owner_sold_channel_subset",
    "collection_selection_readback",
    "collection_default_materialization_readback",
  ])(
    "presents %s catalog fixture gaps as untested without changing raw accounting",
    async (id) => {
      expect(await render(`media_buy_seller/${id}`)).toContain(
        "NOT APPLICABLE — no qualifying product",
      );
      expect(mocks.result.passed_count).toBe(0);
      expect(mocks.result.overall_passed).toBe(true);
    },
  );
  it.each([
    "collection_selection_readback",
    "collection_default_materialization_readback",
  ])(
    "does not credit absent optional reader in %s as passed support",
    async (id) => {
      mocks.result.coverage_gaps = [];
      mocks.result.skipped_count = 1;
      mocks.result.phases = [
        {
          phase_id: "missing_tool",
          steps: [
            {
              step_id: "missing_tool",
              skipped: true,
              passed: false,
              skip_reason: "missing_tool",
            },
          ],
        },
      ];
      expect(await render(`media_buy_seller/${id}`)).toContain(
        "NOT APPLICABLE — get_media_buys is not advertised",
      );
      mocks.result.failed_count = 1;
      expect(await render(`media_buy_seller/${id}`)).toContain(
        "**Result:** FAILED",
      );
    },
  );
});
