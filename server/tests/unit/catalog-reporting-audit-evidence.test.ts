import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { StoryboardPhaseResult } from '@adcp/sdk/testing';

// The private audit record the adapter forwards when the SDK refuses during
// authorized execution carries the producer phase in the SDK-native
// `fixture_preparation` field (SDK 16.5+), not a repo-shaped wrapper.
const state = vi.hoisted(() => ({
  sdkRecord: {} as Record<string, unknown>,
  audits: [] as Record<string, unknown>[],
}));

const producerPhase: StoryboardPhaseResult = {
  phase_id: 'fixture_preparation',
  phase_title: 'Fixture preparation',
  passed: true,
  steps: [],
  duration_ms: 1,
};
const producerResolutions = [{ handle: 'reporting_offer', status: 'resolved' }];

vi.mock('@adcp/sdk/testing', async importOriginal => {
  const actual = await importOriginal<typeof import('@adcp/sdk/testing')>();
  return {
    ...actual,
    testCapabilityDiscovery: async () => ({
      steps: [{ passed: true, task: 'get_adcp_capabilities' }],
      profile: {
        tools: ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'get_media_buy_delivery', 'comply_test_controller'],
        raw_capabilities: { media_buy: { buying_modes: ['wholesale'] } },
        supported_protocols: ['media_buy'],
      },
    }),
    prepareStoryboardFixtures: async () => ({
      disposition: { status: 'resolved' },
      captures: { __adcp_fixture_reporting_price: { currency: 'USD' } },
      resolutions: producerResolutions,
      phase: producerPhase,
    }),
    withPreparedFixtures: () => ({}),
    runStoryboard: async (_url: unknown, _storyboard: unknown, options: { prepared_fixtures_audit_sink?: (r: unknown) => Promise<void> }) => {
      await options.prepared_fixtures_audit_sink?.(state.sdkRecord);
      throw new actual.PreparedFixturesDeniedError('binding_mismatch');
    },
  };
});

import { loadStoryboardFile } from '@adcp/sdk/testing';
import { runCatalogReportingStoryboard } from '../../src/compliance/catalog-reporting-runner.js';

const storyboard = loadStoryboardFile(path.resolve(
  import.meta.dirname,
  '../../../static/compliance/source/protocols/media-buy/scenarios/advanced_delivery_reporting.yaml',
));

async function deniedAudit(sdkRecord: Record<string, unknown>): Promise<Record<string, unknown>> {
  state.sdkRecord = sdkRecord;
  await expect(runCatalogReportingStoryboard('https://seller.example/mcp', storyboard, {
    prepared_fixtures_audit_sink: record => { state.audits.push(record as unknown as Record<string, unknown>); },
  })).rejects.toMatchObject({ name: 'PreparedFixturesDeniedError' });
  expect(state.audits).toHaveLength(1);
  return state.audits[0];
}

beforeEach(() => { state.audits = []; });

it('fills the native fixture_preparation phase and resolutions the SDK left out', async () => {
  const audit = await deniedAudit({ storyboard_id: storyboard.id, overall_passed: false, phases: [] });
  expect(audit.fixture_preparation).toBe(producerPhase);
  expect(audit.fixture_resolutions).toBe(producerResolutions);
  expect(audit).not.toHaveProperty('fixture_preparation.disposition');
});

it('keeps the evidence the SDK already stamped', async () => {
  const sdkPhase = { ...producerPhase, phase_id: 'sdk_stamped' };
  const sdkResolutions = [{ handle: 'sdk', status: 'failed' }];
  const audit = await deniedAudit({ storyboard_id: storyboard.id, fixture_preparation: sdkPhase, fixture_resolutions: sdkResolutions });
  expect(audit.fixture_preparation).toBe(sdkPhase);
  expect(audit.fixture_resolutions).toBe(sdkResolutions);
});
