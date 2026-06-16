import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComplianceResult } from '@adcp/client/testing';

const storyboards = vi.hoisted(() => new Map<string, any>());

vi.mock('../../src/services/storyboards.js', () => ({
  getStoryboard: vi.fn((id: string) => storyboards.get(id)),
  getAllStoryboards: vi.fn(() => Array.from(storyboards.values())),
}));

vi.mock('@adcp/client/testing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adcp/client/testing')>();
  return {
    ...actual,
    comply: vi.fn(),
    setAgentTesterLogger: vi.fn(),
  };
});

const storyboard = (id: string, complyScenario: string) => ({
  id,
  title: id,
  category: 'universal',
  summary: '',
  agent: { interaction_model: 'task', examples: [] },
  phases: [
    {
      id: 'phase',
      title: 'Phase',
      steps: [
        {
          id: 'step',
          title: 'Step',
          comply_scenario: complyScenario,
        },
      ],
    },
  ],
});

function makeResult(
  scenario: string,
  step: {
    skipped?: boolean;
    skip_reason?: string;
    step?: string;
    step_id?: string;
    warnings?: string[];
  },
  overallPassed = false,
): ComplianceResult {
  return {
    agent_url: 'https://example.test/mcp',
    overall_status: overallPassed ? 'passing' : 'failing',
    tracks: [
      {
        track: 'core',
        label: 'Core',
        status: overallPassed ? 'pass' : 'fail',
        duration_ms: 0,
        scenarios: [
          {
            agent_url: 'https://example.test/mcp',
            scenario,
            overall_passed: overallPassed,
            steps: [
              {
                step: step.step ?? 'step',
                step_id: step.step_id,
                passed: overallPassed,
                skipped: step.skipped,
                skip_reason: step.skip_reason,
                warnings: step.warnings,
                duration_ms: 0,
              },
            ],
            summary: 'fixture',
            total_duration_ms: 0,
            tested_at: '2026-06-16T00:00:00.000Z',
          },
        ],
      },
    ],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: overallPassed ? 1 : 0,
      tracks_failed: overallPassed ? 0 : 1,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 0,
      headline: 'fixture',
    },
    observations: [],
    tested_at: '2026-06-16T00:00:00.000Z',
    total_duration_ms: 0,
  } as unknown as ComplianceResult;
}

describe('deriveStoryboardStatuses optional-tool skip handling', () => {
  beforeEach(() => {
    storyboards.clear();
  });

  it('treats not_applicable required-tool skips as untested', async () => {
    storyboards.set('signals_optional', storyboard('signals_optional', 'optional_signals'));
    const { deriveStoryboardStatuses } = await import('../../src/addie/services/compliance-testing.js');

    const [entry] = deriveStoryboardStatuses(
      makeResult('optional_signals', {
        skipped: true,
        skip_reason: 'not_applicable',
        step: 'Not applicable - missing required_tools: get_signals',
      }),
      ['signals_optional'],
    );

    expect(entry).toMatchObject({ storyboard_id: 'signals_optional', status: 'untested' });
  });

  it('treats explicit requires_tool missing-tool skips as untested', async () => {
    storyboards.set('governance_optional', storyboard('governance_optional', 'governance_setup'));
    const { deriveStoryboardStatuses } = await import('../../src/addie/services/compliance-testing.js');

    const [entry] = deriveStoryboardStatuses(
      makeResult('governance_setup', {
        skipped: true,
        skip_reason: 'missing_tool',
        step: 'Register governance agents',
        step_id: 'sync_governance',
        warnings: ['Required tool "sync_governance" not advertised; agent tools: [get_products].'],
      }),
      ['governance_optional'],
    );

    expect(entry).toMatchObject({ storyboard_id: 'governance_optional', status: 'untested' });
  });

  it('treats storyboard-level missing-tool synthetic skips as untested', async () => {
    storyboards.set('collection_lists', storyboard('collection_lists', 'collection_lists/missing_tool'));
    const { deriveStoryboardStatuses } = await import('../../src/addie/services/compliance-testing.js');

    const [entry] = deriveStoryboardStatuses(
      makeResult('collection_lists/missing_tool', {
        skipped: true,
        skip_reason: 'missing_tool',
        step_id: 'missing_tool',
        step: 'Skipped - agent does not advertise any of [list_collection_lists]',
      }),
      ['collection_lists'],
    );

    expect(entry).toMatchObject({ storyboard_id: 'collection_lists', status: 'untested' });
  });

  it('still treats ordinary missing-tool skips as failures', async () => {
    storyboards.set('delivery', storyboard('delivery', 'delivery'));
    const { deriveStoryboardStatuses } = await import('../../src/addie/services/compliance-testing.js');

    const [entry] = deriveStoryboardStatuses(
      makeResult('delivery', {
        skipped: true,
        skip_reason: 'missing_tool',
        step: 'get_media_buy_delivery',
      }),
      ['delivery'],
    );

    expect(entry).toMatchObject({ storyboard_id: 'delivery', status: 'failing' });
  });
});
