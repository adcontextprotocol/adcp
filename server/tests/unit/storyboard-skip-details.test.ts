import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';
import { deriveStoryboardStatuses } from '../../src/addie/services/compliance-testing.js';
import {
  collectStoryboardSkippedSteps,
  MAX_SKIPPED_STEPS_PER_STORYBOARD,
  withStoryboardSkipDetails,
} from '../../src/compliance/storyboard-skip-details.js';

type Step = {
  step: string;
  task?: string;
  passed: boolean;
  error?: string;
  warnings?: string[];
  skipped?: boolean;
  skip_reason?: string;
};

function makeResult(scenarios: Array<{ scenario: string; steps: Step[] }>): ComplianceResult {
  return {
    agent_url: 'https://example.test/mcp',
    agent_profile: { tools: [] },
    overall_status: 'partial',
    tracks: [
      {
        track: 'media_buy',
        label: 'Media buy',
        status: 'partial',
        duration_ms: 0,
        skipped_scenarios: [],
        observations: [],
        scenarios: scenarios.map(s => ({
          agent_url: 'https://example.test/mcp',
          scenario: s.scenario,
          overall_passed: s.steps.every(step => step.passed),
          steps: s.steps.map(step => ({ duration_ms: 0, ...step })),
          summary: '',
          total_duration_ms: 0,
          tested_at: '2026-09-30T00:00:00.000Z',
        })),
      },
    ],
    summary: { tracks_passed: 0, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 1, headline: '' },
    observations: [],
    tested_at: '2026-09-30T00:00:00.000Z',
    total_duration_ms: 0,
  } as unknown as ComplianceResult;
}

describe('collectStoryboardSkippedSteps', () => {
  it('records the skipped step, runner detail, and the earlier failed step', () => {
    const result = makeResult([
      {
        scenario: 'delivery_reporting/setup',
        steps: [
          { step: 'Discover products', task: 'get_products', passed: true },
          { step: 'Create media buy', task: 'create_media_buy', passed: false, error: 'Expected media_buy_id' },
        ],
      },
      {
        scenario: 'delivery_reporting/report',
        steps: [
          {
            step: 'Check delivery',
            task: 'get_media_buy_delivery',
            passed: false,
            skipped: true,
            skip_reason: 'prerequisite_failed',
            warnings: ['Prerequisite step create_media_buy failed'],
          },
        ],
      },
    ]);

    const [status] = withStoryboardSkipDetails(
      { storyboard_statuses: deriveStoryboardStatuses(result) },
      result,
    ).storyboard_statuses!;

    expect(status.skipped_count).toBe(1);
    expect(status.skipped_steps).toEqual([
      {
        step_id: 'check_delivery',
        title: 'Check delivery',
        task: 'get_media_buy_delivery',
        reason: 'prerequisite_failed',
        detail: 'Prerequisite step create_media_buy failed',
        blocked_by_step_id: 'create_media_buy',
        blocked_by_step_title: 'Create media buy',
        blocked_by_reason: 'failed',
      },
    ]);
  });

  it('names a non-failing earlier skip as the blocker when no step failed', () => {
    // 4 passed + 1 skipped + 0 failed (adcp#7798): the old label claimed an
    // earlier failure that never happened.
    const result = makeResult([
      {
        scenario: 'governance_denied/flow',
        steps: [
          { step: 'Sync accounts', task: 'sync_accounts', passed: true },
          {
            step: 'Sync governance',
            task: 'sync_governance',
            passed: true,
            skipped: true,
            skip_reason: 'not_applicable',
            warnings: ['governance_agent_url unresolved'],
          },
          {
            step: 'Create media buy',
            task: 'create_media_buy',
            passed: false,
            skipped: true,
            skip_reason: 'prerequisite_failed',
          },
        ],
      },
    ]);

    const [status] = withStoryboardSkipDetails(
      { storyboard_statuses: deriveStoryboardStatuses(result) },
      result,
    ).storyboard_statuses!;

    expect(status.failure_count).toBe(0);
    expect(status.skipped_count).toBe(1);
    expect(status.skipped_steps?.[0]).toMatchObject({
      step_id: 'create_media_buy',
      blocked_by_step_id: 'sync_governance',
      blocked_by_reason: 'not_applicable',
      detail: null,
    });
  });

  it('ignores prerequisite skips after a fixture_unavailable abort, matching skipped_count', () => {
    const result = makeResult([
      {
        scenario: 'creative_sync/flow',
        steps: [
          { step: 'List formats', task: 'list_creative_formats', passed: true },
          { step: 'Build fixture', passed: true, skipped: true, skip_reason: 'fixture_unavailable' },
          { step: 'Sync creatives', task: 'sync_creatives', passed: false, skipped: true, skip_reason: 'prerequisite_failed' },
        ],
      },
    ]);
    expect(collectStoryboardSkippedSteps(result).get('creative_sync')).toBeUndefined();
  });

  it('drops prerequisite skips graded not_applicable for an unadvertised optional tool, matching skipped_count', () => {
    const result = makeResult([
      {
        scenario: 'sb/phase',
        steps: [
          { step: 'Create media buy', task: 'create_media_buy', passed: false, error: 'boom' },
          { step: 'Check delivery', task: 'get_media_buy_delivery', passed: false, skipped: true, skip_reason: 'prerequisite_failed' },
          { step: 'Optional audit', task: 'get_audit_log', passed: false, skipped: true, skip_reason: 'prerequisite_failed' },
        ],
      },
    ]);
    (result as { adcp_version?: string }).adcp_version = '3.0';
    const resolver = (_r: unknown, _sb: string, _phase: string, step: { task?: unknown }) =>
      step.task === 'get_audit_log' ? 'get_audit_log' : undefined;

    const skipped = collectStoryboardSkippedSteps(result, resolver).get('sb')!;
    expect(skipped.map(s => s.step_id)).toEqual(['check_delivery']);
  });

  it('caps stored skips per storyboard and redacts secrets in detail', () => {
    const steps: Step[] = [{ step: 'Create media buy', passed: false, error: 'boom' }];
    for (let i = 0; i < MAX_SKIPPED_STEPS_PER_STORYBOARD + 3; i++) {
      steps.push({
        step: `Dependent ${i}`,
        passed: false,
        skipped: true,
        skip_reason: 'prerequisite_failed',
        warnings: ['Authorization: Bearer sk_live_abcdefghijklmnop'],
      });
    }
    const skipped = collectStoryboardSkippedSteps(makeResult([{ scenario: 'sb/phase', steps }])).get('sb')!;
    expect(skipped).toHaveLength(MAX_SKIPPED_STEPS_PER_STORYBOARD);
    expect(skipped[0].detail).toBe('[redacted]');
  });

  it('leaves rows without skips untouched', () => {
    const result = makeResult([{ scenario: 'sb/phase', steps: [{ step: 'A', passed: true }] }]);
    const input = withStoryboardSkipDetails({ storyboard_statuses: deriveStoryboardStatuses(result) }, result);
    expect(input.storyboard_statuses?.[0].skipped_steps).toBeUndefined();
  });
});

const dashboardSource = readFileSync(
  new URL('../../public/dashboard-agents.html', import.meta.url),
  'utf8',
);

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

describe('dashboard storyboard skip drill-down', () => {
  it('shows step id, prerequisite, reason, and escaped agent detail for skipped steps', () => {
    const html = storyboardDrilldownHtml({
      status: 'partial',
      failure_count: 0,
      skipped_count: 1,
      skipped_steps: [
        {
          step_id: 'create_media_buy',
          title: 'Create <b>media</b> buy',
          task: 'create_media_buy',
          reason: 'prerequisite_failed',
          detail: '<img src=x onerror=alert(1)>',
          blocked_by_step_id: 'sync_governance',
          blocked_by_step_title: 'Sync governance',
          blocked_by_reason: 'not_applicable',
        },
      ],
    });

    expect(html).toContain('Show skip details (1 skipped)');
    expect(html).not.toContain('Blocked after earlier failure');
    expect(html).toContain('create_media_buy · create_media_buy');
    expect(html).toContain('Reason: Prerequisite step did not pass (prerequisite_failed)');
    expect(html).toContain('Earlier step that did not pass: Sync governance (sync_governance) — skipped: Not applicable (not_applicable)');
    expect(html).toContain('Create &lt;b&gt;media&lt;/b&gt; buy');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
  });

  it('keeps failure validations and summarizes extra skips', () => {
    const html = storyboardDrilldownHtml({
      status: 'partial',
      failure_count: 1,
      skipped_count: 5,
      first_failed_step_id: 'create_media_buy',
      first_failed_step_title: 'Create media buy',
      first_failure_message: 'Expected media_buy_id',
      first_failure_validations: [{ check: 'field_present', json_pointer: '/media_buy_id', expected: 'present', actual: '"><script>' }],
      skipped_steps: Array.from({ length: 5 }, (_, i) => ({
        step_id: `dependent_${i}`,
        reason: 'prerequisite_failed',
        blocked_by_step_id: 'create_media_buy',
        blocked_by_reason: 'failed',
      })),
    });

    expect(html).toContain('Show failure details (1 failure, 5 skipped)');
    expect(html).toContain('/media_buy_id');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('dependent_2');
    expect(html).not.toContain('dependent_3');
    expect(html).toContain('Showing 3 skipped steps; 2 more skipped steps remain.');
    expect(html).toContain('Earlier step that did not pass: create_media_buy — failed');
  });

  it('falls back honestly when skip evidence was not recorded', () => {
    const html = storyboardDrilldownHtml({ status: 'partial', failure_count: 0, skipped_count: 2 });
    expect(html).toContain('2 steps skipped because a prerequisite step did not pass');
    expect(html).toContain('Re-test to capture which step was skipped and why.');
    expect(html).not.toContain('earlier step failed');
  });
});
