import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  deriveStoryboardStatuses,
  extractStoryboardVerdictExplanation,
} from '../../src/addie/services/compliance-testing.js';
import type { ComplianceResult } from '@adcp/sdk/testing';

/**
 * Storyboard-level verdict explanation (adcp#8576).
 *
 * Hosted run 937a0906 showed `media_buy_seller` as "failing · 0/1 steps" with
 * a single synthetic `storyboard` step reading "storyboard-level verdict
 * failed": every visible step was a controller setup gap, so the only counted
 * row was the runner's step-less `<id>/storyboard` scenario. The SDK now puts
 * `verdict_reason` / `verdict_detail` / `verdict_contributing` on that
 * scenario; the grader must store them on the storyboard status row.
 */

type Scenario = ComplianceResult['tracks'][number]['scenarios'][number];

const VERDICT = {
  verdict_reason: 'controller_prerequisite_unmet',
  verdict_detail:
    'Required steps did not run because comply_test_controller or its seeding was unavailable: ' +
    'force_media_buy_status skipped (missing_test_controller).',
  verdict_contributing: [
    {
      kind: 'step',
      id: 'force_media_buy_status',
      reason: 'controller_prerequisite_unmet',
      status: 'skipped',
      phase_id: 'lifecycle',
      skip_reason: 'missing_test_controller',
      message: 'Not testable: requires comply_test_controller',
    },
    {
      kind: 'step',
      id: 'get_media_buys',
      reason: 'required_phase_not_executed',
      status: 'skipped',
      phase_id: 'lifecycle',
      skip_reason: 'prerequisite_failed',
    },
  ],
};

function scenario(id: string, overrides: Partial<Scenario> & Record<string, unknown>): Scenario {
  return {
    agent_url: 'https://seller.example/mcp',
    scenario: id as unknown as Scenario['scenario'],
    overall_passed: true,
    summary: 'fixture',
    total_duration_ms: 0,
    tested_at: '2026-11-15T00:00:00.000Z',
    ...overrides,
  } as Scenario;
}

function result(scenarios: Scenario[]): ComplianceResult {
  return {
    agent_url: 'https://seller.example/mcp',
    agent_profile: { tools: [] },
    overall_status: 'failing',
    tracks: [
      {
        track: 'media_buy',
        label: 'Media Buy Lifecycle',
        status: 'partial',
        duration_ms: 0,
        skipped_scenarios: [],
        observations: [],
        scenarios,
      },
    ],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 0,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 1,
      tracks_silent: 0,
      headline: 'fixture',
    },
    observations: [],
    tested_at: '2026-11-15T00:00:00.000Z',
    total_duration_ms: 0,
  } as unknown as ComplianceResult;
}

/** Every visible step is a controller setup gap; only the synthetic verdict row counts. */
function issue8576Scenarios(verdict: Record<string, unknown> = VERDICT): Scenario[] {
  return [
    scenario('media_buy_seller/lifecycle', {
      overall_passed: true,
      steps: [
        {
          step: 'Force media buy status',
          step_id: 'force_media_buy_status',
          task: 'comply_test_controller',
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          duration_ms: 0,
        },
      ],
    }),
    scenario('media_buy_seller/storyboard', {
      overall_passed: false,
      steps: [],
      summary: `Media Buy Seller: storyboard-level verdict failed: ${String(verdict.verdict_detail ?? '')}`,
      ...verdict,
    }),
  ];
}

describe('deriveStoryboardStatuses — storyboard-level verdict explanation', () => {
  it('#8576: stores why a storyboard failed when its only counted row is the synthetic verdict', () => {
    const [entry] = deriveStoryboardStatuses(result(issue8576Scenarios()));
    expect(entry).toMatchObject({
      storyboard_id: 'media_buy_seller',
      status: 'failing',
      steps_passed: 0,
      steps_total: 1,
      first_failed_step_id: 'storyboard',
    });
    expect(entry.first_failure_message).toContain('storyboard-level verdict failed: Required steps did not run');
    expect(entry.verdict_explanation).toEqual({
      reason: 'controller_prerequisite_unmet',
      detail: VERDICT.verdict_detail,
      contributing: [
        {
          kind: 'step',
          id: 'force_media_buy_status',
          reason: 'controller_prerequisite_unmet',
          status: 'skipped',
          phase_id: 'lifecycle',
          pass_index: null,
          skip_reason: 'missing_test_controller',
          requirement: null,
          message: 'Not testable: requires comply_test_controller',
        },
        {
          kind: 'step',
          id: 'get_media_buys',
          reason: 'required_phase_not_executed',
          status: 'skipped',
          phase_id: 'lifecycle',
          pass_index: null,
          skip_reason: 'prerequisite_failed',
          requirement: null,
          message: null,
        },
      ],
    });
  });

  it('keeps the old row shape for results from an SDK without verdict fields', () => {
    const [entry] = deriveStoryboardStatuses(
      result([
        ...issue8576Scenarios({}).slice(0, 1),
        scenario('media_buy_seller/storyboard', {
          overall_passed: false,
          steps: [],
          summary: 'Media Buy Seller: storyboard-level verdict failed',
        }),
      ]),
    );
    expect(entry.status).toBe('failing');
    expect(entry.first_failure_message).toBe('Media Buy Seller: storyboard-level verdict failed');
    expect(entry.verdict_explanation).toBeUndefined();
  });

  it('does not attach an explanation to a passing storyboard', () => {
    const [entry] = deriveStoryboardStatuses(
      result([
        scenario('media_buy_seller/discovery', {
          overall_passed: true,
          steps: [{ step: 'Get products', step_id: 'get_products', task: 'get_products', passed: true, duration_ms: 0 }],
        }),
      ]),
    );
    expect(entry.status).toBe('passing');
    expect(entry.verdict_explanation).toBeUndefined();
  });
});

describe('extractStoryboardVerdictExplanation', () => {
  it('redacts credentials the runner text may echo and caps contributor rows', () => {
    const explanation = extractStoryboardVerdictExplanation({
      verdict_reason: 'assertion_failed',
      verdict_detail: 'A storyboard-level assertion failed: context.no_secret_echo — Authorization: Bearer sk_live_123',
      verdict_contributing: Array.from({ length: 25 }, (_, i) => ({
        kind: 'assertion',
        id: `a${i}`,
        reason: 'assertion_failed',
        status: 'failed',
        message: i === 0 ? 'api_key=sk_live_456' : 'observed drift',
      })),
    });
    expect(explanation?.detail).toBe('[redacted]');
    expect(explanation?.contributing).toHaveLength(10);
    expect(explanation?.contributing[0]?.message).toBe('[redacted]');
    expect(JSON.stringify(explanation)).not.toContain('sk_live');
  });

  it('rejects a reason that is not a runner code and drops malformed contributor fields', () => {
    expect(extractStoryboardVerdictExplanation({ verdict_reason: '<img src=x onerror=alert(1)>' })).toBeNull();
    expect(extractStoryboardVerdictExplanation({ verdict_detail: 'no reason' })).toBeNull();
    expect(extractStoryboardVerdictExplanation(null)).toBeNull();
    const explanation = extractStoryboardVerdictExplanation({
      verdict_reason: 'runner_error',
      verdict_contributing: [{ kind: 'step evil', id: 42, status: 'failed', pass_index: 1.5 }, 'not-an-object'],
    });
    expect(explanation).toEqual({
      reason: 'runner_error',
      detail: null,
      contributing: [
        {
          kind: null,
          id: null,
          reason: null,
          status: 'failed',
          phase_id: null,
          pass_index: null,
          skip_reason: null,
          requirement: null,
          message: null,
        },
      ],
    });
  });
});

const dashboardSource = readFileSync(new URL('../../public/dashboard-agents.html', import.meta.url), 'utf8');

function extract(startMarker: string, endMarker: string): string {
  const start = dashboardSource.indexOf(startMarker);
  const end = dashboardSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`dashboard helper not found: ${startMarker}`);
  return dashboardSource.slice(start, end);
}

const dashboardContext = vm.createContext({});
vm.runInContext(
  [
    extract('function normalizeStoryboardStatus', 'function storyboardStatusLabel'),
    extract('function finiteCount', 'function cachedStoryboardStatuses'),
    extract('function renderDiagnosticValidation', 'function escapeHtml'),
    extract('function escapeHtml', '\n    }\n') + '\n    }\n',
  ].join('\n'),
  dashboardContext,
);
const storyboardDrilldownHtml = dashboardContext.storyboardDrilldownHtml as (status: Record<string, unknown>) => string;
const storyboardNextStep = dashboardContext.storyboardNextStep as (status: Record<string, unknown>) => string;

describe('dashboard storyboard-level verdict drill-down', () => {
  const ownerRow = {
    status: 'failing',
    steps_passed: 0,
    steps_total: 1,
    failure_count: 1,
    skipped_count: 0,
    first_failed_step_id: 'storyboard',
    first_failed_step_title: 'storyboard',
    first_failure_message: 'Media Buy Seller: storyboard-level verdict failed: ...',
    verdict_explanation: {
      reason: 'controller_prerequisite_unmet',
      detail: 'Required steps did not run: <b>seed</b> skipped (missing_test_controller).',
      contributing: [
        {
          kind: 'step',
          id: 'force_media_buy_status',
          reason: 'controller_prerequisite_unmet',
          status: 'skipped',
          phase_id: 'lifecycle',
          pass_index: null,
          skip_reason: 'missing_test_controller',
          requirement: null,
          message: '<img src=x onerror=alert(1)>',
        },
      ],
    },
  };

  it('#8576: shows why the storyboard failed instead of a synthetic "storyboard" step', () => {
    const html = storyboardDrilldownHtml(ownerRow);
    expect(html).toContain('Why the storyboard failed');
    expect(html).toContain('Required steps need comply_test_controller or its seeding, which was unavailable');
    expect(html).toContain('controller_prerequisite_unmet');
    expect(html).toContain(
      'step force_media_buy_status — skipped: Requires comply_test_controller (missing_test_controller) (phase lifecycle)',
    );
    expect(html).not.toContain('First failed step');
    expect(html).toContain('&lt;b&gt;seed&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(storyboardNextStep(ownerRow)).toBe('Next step: review why the storyboard verdict failed, then re-test.');
  });

  it('keeps the first-failed-step view for viewers without the owner-only explanation', () => {
    const { verdict_explanation: _verdict, ...publicRow } = ownerRow;
    const html = storyboardDrilldownHtml(publicRow);
    expect(html).toContain('First failed step');
    expect(html).not.toContain('Why the storyboard failed');
  });

  it('labels a runner error as not an agent failure', () => {
    const html = storyboardDrilldownHtml({
      ...ownerRow,
      verdict_explanation: { reason: 'runner_error', detail: null, contributing: [] },
    });
    expect(html).toContain('The grader could not proceed. This is not an agent failure');
  });
});
