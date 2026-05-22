import { describe, it, expect, vi } from 'vitest';

vi.mock('@adcp/sdk/testing', () => ({
  setAgentTesterLogger: vi.fn(),
  comply: vi.fn(),
  loadComplianceIndex: vi.fn(() => ({ specialisms: [] })),
  SAMPLE_BRIEFS: [],
  getBriefsByVertical: vi.fn(() => []),
}));

vi.mock('../../src/services/storyboards.js', () => ({
  getStoryboard: vi.fn(() => null),
  getAllStoryboards: vi.fn(() => []),
}));

vi.mock('../../src/services/adcp-taxonomy.js', () => ({
  isStableSpecialism: vi.fn(() => true),
}));

import {
  extractFailingStepDiagnostics,
  complianceResultToDbInput,
} from '../../src/addie/services/compliance-testing.js';

function step(overrides: Record<string, unknown>) {
  return {
    storyboard_id: 'creative_lifecycle',
    step_id: 'list_all',
    phase_id: 'list_and_filter',
    title: 'List all creatives',
    task: 'list_creatives',
    passed: false,
    duration_ms: 123,
    validations: [],
    context: {},
    extraction: { path: 'structured_content' },
    ...overrides,
  };
}

function phase(scenarioKey: string, steps: any[]) {
  return {
    scenario: scenarioKey,
    overall_passed: steps.every(s => s.passed),
    steps,
  };
}

function resultWith(tracks: any[]) {
  return {
    overall_status: 'partial',
    tracks,
    summary: {
      headline: 'fixture',
      tracks_passed: 0,
      tracks_failed: 1,
      tracks_partial: 0,
      tracks_skipped: 0,
    },
    total_duration_ms: 500,
    agent_profile: { name: 'test', tools: [] },
    observations: [],
  };
}

describe('extractFailingStepDiagnostics', () => {
  it('captures request + response payloads for a failing wire step', () => {
    const failing = step({
      passed: false,
      request: {
        transport: 'mcp_http',
        url: 'https://adcp.bidmachine.io/adcp/mcp',
        payload: {
          account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example' },
          context: { correlation_id: 'creative_lifecycle--list_all' },
        },
      },
      response_record: {
        transport: 'mcp_http',
        status: 200,
        headers: { 'content-type': 'application/json' },
        payload: { creatives: [], total_matching: 0 },
        duration_ms: 87,
      },
      validations: [
        { check: 'field_present', path: 'creatives', passed: true },
        { check: 'field_value', path: 'context.correlation_id', passed: false, expected: 'creative_lifecycle--list_all', actual: undefined },
      ],
    });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 100, scenarios: [phase('creative_lifecycle/list_and_filter', [failing])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    const d = out[0];
    expect(d.storyboard_id).toBe('creative_lifecycle');
    expect(d.phase_id).toBe('list_and_filter');
    expect(d.step_id).toBe('list_all');
    expect(d.task).toBe('list_creatives');
    expect(d.step_passed).toBe(false);
    expect(d.duration_ms).toBe(123);
    expect(d.request_url).toBe('https://adcp.bidmachine.io/adcp/mcp');
    expect(d.request_jsonb).toMatchObject({
      account: { brand: { domain: 'acmeoutdoor.example' } },
      context: { correlation_id: 'creative_lifecycle--list_all' },
    });
    expect(d.response_status).toBe(200);
    expect(d.response_jsonb).toEqual({ creatives: [], total_matching: 0 });
    expect(d.extraction_path).toBe('structured_content');
    expect(d.failed_validations_jsonb).toEqual([
      { check: 'field_value', path: 'context.correlation_id', passed: false, expected: 'creative_lifecycle--list_all', actual: undefined },
    ]);
  });

  it('skips passing and skipped steps', () => {
    const passing = step({ passed: true, step_id: 'passing_step' });
    const skipped = step({ passed: false, skipped: true, step_id: 'skipped_step', skip_reason: 'missing_tool' });
    const failed = step({ passed: false, step_id: 'failed_step' });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'partial', duration_ms: 100, scenarios: [phase('sb/phase', [passing, skipped, failed])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    expect(out[0].step_id).toBe('failed_step');
  });

  it('emits a row when a step failed without reaching the wire', () => {
    // Step that failed during local request building — no request/response_record.
    const localFail = step({
      passed: false,
      step_id: 'no_wire',
      error: 'Schema validation failed before send',
      request: undefined,
      response_record: undefined,
    });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 5, scenarios: [phase('sb/phase', [localFail])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    expect(out[0].step_id).toBe('no_wire');
    expect(out[0].request_url).toBeUndefined();
    expect(out[0].request_jsonb).toBeUndefined();
    expect(out[0].response_status).toBeUndefined();
    expect(out[0].response_jsonb).toBeUndefined();
    expect(out[0].error_text).toBe('Schema validation failed before send');
  });

  it('truncates oversized payloads with a marker', () => {
    const huge = { creatives: Array.from({ length: 5000 }, (_, i) => ({ creative_id: `id_${i}`, padding: 'x'.repeat(64) })) };
    const failing = step({
      passed: false,
      request: { transport: 'mcp_http', url: 'https://x/mcp', payload: { ok: true } },
      response_record: { transport: 'mcp_http', status: 200, payload: huge },
    });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 100, scenarios: [phase('sb/phase', [failing])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    const body = out[0].response_jsonb as Record<string, unknown>;
    expect(body.__truncated).toBe(true);
    expect(body.reason).toBe('size_cap');
    expect(typeof body.original_bytes).toBe('number');
    expect(out[0].request_jsonb).toEqual({ ok: true });
  });

  it('drops disallowed response headers (Set-Cookie, Authorization) and keeps content-type', () => {
    const failing = step({
      passed: false,
      request: { transport: 'mcp_http', payload: { ok: true } },
      response_record: {
        transport: 'mcp_http',
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=abc123; HttpOnly',
          authorization: 'Bearer leaked-token',
          'cache-control': 'no-store',
        },
        payload: { ok: false },
      },
    });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 10, scenarios: [phase('sb/phase', [failing])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    const headers = out[0].response_headers_jsonb!;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers).not.toHaveProperty('set-cookie');
    expect(headers).not.toHaveProperty('authorization');
  });

  it('skips phases whose scenario key has no storyboard/phase separator', () => {
    const orphan = step({ passed: false });
    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 10, scenarios: [phase('bare_legacy_scenario', [orphan])] },
      ]) as any,
    );
    expect(out).toEqual([]);
  });

  it('is wired into complianceResultToDbInput', () => {
    const failing = step({
      passed: false,
      request: { transport: 'mcp_http', payload: { x: 1 } },
      response_record: { transport: 'mcp_http', status: 200, payload: { y: 2 } },
    });
    const result = resultWith([
      { track: 'creative', status: 'fail', duration_ms: 10, scenarios: [phase('creative_lifecycle/list_and_filter', [failing])] },
    ]);

    const dbInput = complianceResultToDbInput(result as any, 'https://x/mcp', 'production');
    expect(dbInput.step_diagnostics).toBeDefined();
    expect(dbInput.step_diagnostics).toHaveLength(1);
    expect(dbInput.step_diagnostics?.[0].storyboard_id).toBe('creative_lifecycle');
  });
});
