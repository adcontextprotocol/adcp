import { beforeEach, describe, it, expect, vi } from 'vitest';

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
  SUPPORTED_BADGE_VERSIONS: ['3.0'],
  isStableSpecialism: vi.fn(() => true),
}));

import {
  extractFailingStepDiagnostics,
  complianceResultToDbInput,
} from '../../src/addie/services/compliance-testing.js';
import { getStoryboard } from '../../src/services/storyboards.js';

const mockGetStoryboard = vi.mocked(getStoryboard);

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
  beforeEach(() => {
    mockGetStoryboard.mockReset();
    mockGetStoryboard.mockReturnValue(undefined);
  });

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
    expect(body.preview).toBeUndefined();
    expect(out[0].request_jsonb).toEqual({ ok: true });
  });

  it('redacts diagnostic payload secrets and strips validation wire captures', () => {
    const failing = step({
      passed: false,
      request: {
        transport: 'mcp_http',
        url: 'https://x/mcp',
        payload: {
          authorization: 'Bearer should-not-persist',
          account: { brand: { domain: 'acmeoutdoor.example' } },
        },
      },
      response_record: {
        transport: 'mcp_http',
        status: 200,
        payload: {
          access_token: 'should-not-persist',
          nested: { public_value: 'ok' },
        },
      },
      validations: [
        {
          check: 'field_value',
          path: 'errors[0].code',
          passed: false,
          expected: 'INVALID_REQUEST',
          actual: 'sk_live_1234567890abcdefghijkl',
          request: { payload: { password: 'should-not-persist' } },
          response: { payload: { cookie: 'should-not-persist' } },
        },
        {
          check: 'field_value',
          path: 'errors[0].message',
          passed: false,
          expected: 'safe message',
          actual: 'Authorization: Bearer secret-token',
          error: 'cookie=session=abc',
        },
      ],
    });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 100, scenarios: [phase('sb/phase', [failing])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    expect(out[0].request_jsonb).toEqual({
      authorization: '[redacted]',
      account: { brand: { domain: 'acmeoutdoor.example' } },
    });
    expect(out[0].response_jsonb).toEqual({
      access_token: '[redacted]',
      nested: { public_value: 'ok' },
    });
    expect(out[0].failed_validations_jsonb).toEqual([
      {
        check: 'field_value',
        path: 'errors[0].code',
        passed: false,
        expected: 'INVALID_REQUEST',
        actual: '[redacted]',
      },
      {
        check: 'field_value',
        path: 'errors[0].message',
        passed: false,
        expected: 'safe message',
        actual: '[redacted]',
        error: '[redacted]',
      },
    ]);
  });

  it('preserves explicit null wire response payloads instead of falling back to observation data', () => {
    const failing = step({
      passed: false,
      response_record: { transport: 'mcp_http', status: 204, payload: null },
      observation_data: { should_not_replace_null: true },
    });

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 100, scenarios: [phase('sb/phase', [failing])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    expect(out[0].response_status).toBe(204);
    expect(out[0].response_jsonb).toBeNull();
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

  it('uses step identity when the scenario key has no storyboard/phase separator', () => {
    const failing = step({ passed: false });
    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 10, scenarios: [phase('bare_legacy_scenario', [failing])] },
      ]) as any,
    );
    expect(out).toHaveLength(1);
    expect(out[0].storyboard_id).toBe('creative_lifecycle');
    expect(out[0].phase_id).toBe('list_and_filter');
    expect(out[0].step_id).toBe('list_all');
  });

  it('skips unidentified failed steps whose scenario key has no storyboard/phase separator', () => {
    const orphan = step({ passed: false });
    delete (orphan as any).storyboard_id;
    delete (orphan as any).phase_id;
    delete (orphan as any).step_id;
    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 10, scenarios: [phase('bare_legacy_scenario', [orphan])] },
      ]) as any,
    );
    expect(out).toEqual([]);
  });

  it('derives fallback coordinates from slash-bearing scenarios when attribution is unavailable', () => {
    const flattenedStep = {
      step: 'Check agent capabilities',
      task: 'get_adcp_capabilities',
      passed: false,
      duration_ms: 50,
      error: 'Capability check failed',
    };

    const out = extractFailingStepDiagnostics(
      resultWith([
        { track: 'creative', status: 'fail', duration_ms: 50, scenarios: [phase('creative/native_in_feed/phase_one', [flattenedStep])] },
      ]) as any,
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      storyboard_id: 'creative/native_in_feed',
      phase_id: 'phase_one',
      step_id: 'check_agent_capabilities',
    });
  });

  it('persists flattened compliance-step failures using ComplianceResult.failures attribution', () => {
    const flattenedStep = {
      step: 'Read allowed_actions from get_products',
      task: 'get_products',
      passed: false,
      duration_ms: 456,
      error: 'Probe validations failed.',
      details: '✗ Product declares extend_flight as approval-routed: Field missing',
      observation_data: {
        products: [{ product_id: 'available_actions_display', allowed_actions: [] }],
      },
    };
    const result = resultWith([
      {
        track: 'media_buy',
        status: 'partial',
        duration_ms: 456,
        scenarios: [phase('media_buy_seller/available_actions/discover_product_action_template', [flattenedStep])],
      },
    ]) as any;
    result.failures = [
      {
        track: 'media_buy',
        storyboard_id: 'media_buy_seller/available_actions',
        step_id: 'get_product_allowed_actions',
        step_title: 'Read allowed_actions from get_products',
        task: 'get_products',
        error: 'Probe validations failed.',
        validation: {
          check: 'field_value',
          description: 'Product declares extend_flight as approval-routed',
          json_pointer: '/products/0/allowed_actions/1/mode',
          expected: 'requires_approval',
          actual: undefined,
        },
        fix_command: 'adcp storyboard step https://x media_buy_seller/available_actions get_product_allowed_actions --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      storyboard_id: 'media_buy_seller/available_actions',
      phase_id: 'discover_product_action_template',
      step_id: 'get_product_allowed_actions',
      task: 'get_products',
      duration_ms: 456,
      error_text: 'Probe validations failed.',
      response_jsonb: {
        products: [{ product_id: 'available_actions_display', allowed_actions: [] }],
      },
    });
    expect(out[0].failed_validations_jsonb).toEqual([
      {
        check: 'field_value',
        description: 'Product declares extend_flight as approval-routed',
        json_pointer: '/products/0/allowed_actions/1/mode',
        expected: 'requires_approval',
        actual: undefined,
        passed: false,
      },
    ]);
  });

  it('matches flattened failures when the step error text differs from the failure summary', () => {
    const result = resultWith([
      {
        track: 'media_buy',
        status: 'partial',
        duration_ms: 123,
        scenarios: [phase('media_buy_seller/available_actions/discover_product_action_template', [
          {
            step: 'Read allowed_actions from get_products',
            task: 'get_products',
            passed: false,
            duration_ms: 123,
            error: 'Different wrapper error',
          },
        ])],
      },
    ]) as any;
    result.failures = [
      {
        track: 'media_buy',
        storyboard_id: 'media_buy_seller/available_actions',
        step_id: 'get_product_allowed_actions',
        step_title: 'Read allowed_actions from get_products',
        task: 'get_products',
        error: 'Probe validations failed.',
        validation: {
          check: 'field_value',
          description: 'Product advertises the self-serve budget action',
          expected: 'increase_budget',
          actual: 'cancel',
        },
        fix_command: 'adcp storyboard step https://x media_buy_seller/available_actions get_product_allowed_actions --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(1);
    expect(out[0].storyboard_id).toBe('media_buy_seller/available_actions');
    expect(out[0].step_id).toBe('get_product_allowed_actions');
    expect(out[0].failed_validations_jsonb).toEqual([
      {
        check: 'field_value',
        description: 'Product advertises the self-serve budget action',
        expected: 'increase_budget',
        actual: 'cancel',
        passed: false,
      },
    ]);
  });

  it('does not reuse one flattened failure attribution across repeated step titles', () => {
    const result = resultWith([
      {
        track: 'media_buy',
        status: 'partial',
        duration_ms: 246,
        scenarios: [phase('media_buy_seller/available_actions/enforce_available_actions', [
          {
            step: 'Validate action rejection',
            task: 'update_media_buy',
            passed: false,
            duration_ms: 100,
            error: 'Different wrapper error',
          },
          {
            step: 'Validate action rejection',
            task: 'update_media_buy',
            passed: false,
            duration_ms: 146,
            error: 'Different wrapper error',
          },
        ])],
      },
    ]) as any;
    result.failures = [
      {
        track: 'media_buy',
        storyboard_id: 'media_buy_seller/available_actions',
        step_id: 'reject_direct_extend',
        step_title: 'Validate action rejection',
        task: 'update_media_buy',
        error: 'Probe validations failed.',
        validation: {
          check: 'error_code',
          description: 'Direct extend rejects',
          expected: 'ACTION_NOT_ALLOWED',
          actual: 'INVALID_REQUEST',
        },
        fix_command: 'adcp storyboard step https://x media_buy_seller/available_actions reject_direct_extend --json',
      },
      {
        track: 'media_buy',
        storyboard_id: 'media_buy_seller/available_actions',
        step_id: 'reject_direct_cancel',
        step_title: 'Validate action rejection',
        task: 'update_media_buy',
        error: 'Probe validations failed.',
        validation: {
          check: 'error_code',
          description: 'Direct cancel rejects',
          expected: 'ACTION_NOT_ALLOWED',
          actual: 'INVALID_STATE',
        },
        fix_command: 'adcp storyboard step https://x media_buy_seller/available_actions reject_direct_cancel --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(2);
    expect(out.map(d => d.step_id)).toEqual(['reject_direct_extend', 'reject_direct_cancel']);
    expect(out.map(d => (d.failed_validations_jsonb as any[])[0].actual)).toEqual([
      'INVALID_REQUEST',
      'INVALID_STATE',
    ]);
  });

  it('does not attach failure attribution from a different slash-bearing storyboard', () => {
    const sharedStep = {
      step: 'Check agent capabilities',
      task: 'get_adcp_capabilities',
      passed: false,
      duration_ms: 50,
      error: 'Capability check failed',
      observation_data: { scenario_payload: 'native' },
    };
    const result = resultWith([
      {
        track: 'creative',
        status: 'partial',
        duration_ms: 100,
        scenarios: [
          phase('creative/native_in_feed/phase_one', [sharedStep]),
          phase('creative/canonical_supported_formats/phase_one', [{
            ...sharedStep,
            observation_data: { scenario_payload: 'canonical' },
          }]),
        ],
      },
    ]) as any;
    result.failures = [
      {
        track: 'creative',
        storyboard_id: 'creative/canonical_supported_formats',
        step_id: 'check_canonical_caps',
        step_title: 'Check agent capabilities',
        task: 'get_adcp_capabilities',
        error: 'Capability check failed',
        validation: {
          check: 'field_present',
          description: 'Canonical formats advertised',
          expected: 'formats',
          actual: undefined,
        },
        fix_command: 'adcp storyboard step https://x creative/canonical_supported_formats check_canonical_caps --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      storyboard_id: 'creative/native_in_feed',
      phase_id: 'phase_one',
      step_id: 'check_agent_capabilities',
      response_jsonb: { scenario_payload: 'native' },
    });
    expect(out[0].failed_validations_jsonb).toBeUndefined();
    expect(out[1]).toMatchObject({
      storyboard_id: 'creative/canonical_supported_formats',
      phase_id: 'phase_one',
      step_id: 'check_canonical_caps',
      response_jsonb: { scenario_payload: 'canonical' },
    });
    expect(out[1].failed_validations_jsonb).toEqual([
      {
        check: 'field_present',
        description: 'Canonical formats advertised',
        expected: 'formats',
        actual: undefined,
        passed: false,
      },
    ]);
  });

  it('captures an unmatched failure summary when the runner halts after a passing visible step', () => {
    mockGetStoryboard.mockReturnValue({
      phases: [
        {
          id: 'list_and_filter',
          steps: [
            { id: 'list_filtered', title: 'List creatives filtered by format', task: 'list_creatives' },
          ],
        },
      ],
    } as any);
    const listAll = step({
      passed: true,
      step_id: 'list_all',
      title: 'List all creatives',
      task: 'list_creatives',
      request: { transport: 'mcp_http', url: 'https://x/mcp', payload: { filter: {} } },
      response_record: {
        transport: 'mcp_http',
        status: 200,
        payload: { creatives: [{ creative_id: 'display_trail_pro_300x250' }] },
      },
      validations: [
        { id: 'list_all_response_schema', check: 'response_schema', passed: true },
        { id: 'list_all_context_echo', check: 'field_value', passed: true },
      ],
    });
    const result = resultWith([
      {
        track: 'creative',
        status: 'fail',
        duration_ms: 100,
        scenarios: [phase('creative_lifecycle/list_and_filter', [listAll])],
      },
    ]) as any;
    result.failures = [
      {
        track: 'creative',
        storyboard_id: 'creative_lifecycle',
        step_id: 'list_filtered',
        step_title: 'List creatives filtered by format',
        task: 'list_creatives',
        error: 'Probe validations failed.',
        validation: {
          id: 'list_filtered_display_only',
          check: 'field_value',
          description: 'Filtered result contains only display creatives',
          json_pointer: '/creatives/0/format_id',
          expected: 'display_300x250',
          actual: 'native_in_feed',
        },
        fix_command: 'adcp storyboard step https://x creative_lifecycle list_filtered --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      storyboard_id: 'creative_lifecycle',
      phase_id: 'list_and_filter',
      step_id: 'list_filtered',
      task: 'list_creatives',
      error_text: 'Probe validations failed.',
    });
    expect(out[0].request_jsonb).toBeUndefined();
    expect(out[0].response_jsonb).toBeUndefined();
    expect(out[0].failed_validations_jsonb).toEqual([
      {
        id: 'list_filtered_display_only',
        check: 'field_value',
        description: 'Filtered result contains only display creatives',
        json_pointer: '/creatives/0/format_id',
        expected: 'display_300x250',
        actual: 'native_in_feed',
        passed: false,
      },
    ]);
  });

  it('captures an unmatched stale-response failure summary when the visible step has no failed validation', () => {
    mockGetStoryboard.mockReturnValue({
      phases: [
        {
          id: 'stale_response_forcing',
          steps: [
            {
              id: 'stale_response_wire_placement',
              title: 'STALE_RESPONSE in errors[] on populated success response',
              task: 'get_products',
            },
          ],
        },
      ],
    } as any);
    const visibleWireStep = step({
      passed: true,
      storyboard_id: 'stale_response_advisory',
      phase_id: 'stale_response_forcing',
      step_id: 'stale_response_wire_placement',
      title: 'STALE_RESPONSE in errors[] on populated success response',
      task: 'get_products',
      request: { transport: 'mcp_http', url: 'https://x/mcp', payload: { context: { correlation_id: 'stale_response_advisory--stale_response_wire_placement' } } },
      response_record: {
        transport: 'mcp_http',
        status: 200,
        payload: {
          status: 'completed',
          products: [{ product_id: 'cached_display' }],
          errors: [{ code: 'STALE_RESPONSE', recovery: 'transient' }],
        },
      },
      validations: [
        { id: 'stale_response_schema', check: 'response_schema', passed: true },
        { id: 'stale_response_code', check: 'field_value', path: 'errors[0].code', passed: true },
      ],
    });
    const result = resultWith([
      {
        track: 'error_handling',
        status: 'fail',
        duration_ms: 100,
        scenarios: [phase('stale_response_advisory/stale_response_forcing', [visibleWireStep])],
      },
    ]) as any;
    result.failures = [
      {
        track: 'error_handling',
        storyboard_id: 'stale_response_advisory',
        step_id: 'stale_response_wire_placement',
        step_title: 'STALE_RESPONSE in errors[] on populated success response',
        task: 'get_products',
        error: 'Probe validations failed.',
        validation: {
          id: 'stale_response_details_schema',
          check: 'response_schema',
          description: 'STALE_RESPONSE details conform to stale-response schema',
          json_pointer: '/errors/0/details',
          schema_id: '/schemas/error-details/stale-response.json',
          actual: [{ instance_path: '/upstream', message: 'must have required property name' }],
        },
        fix_command: 'adcp storyboard step https://x stale_response_advisory stale_response_wire_placement --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      storyboard_id: 'stale_response_advisory',
      phase_id: 'stale_response_forcing',
      step_id: 'stale_response_wire_placement',
      task: 'get_products',
    });
    expect(out[0].request_jsonb).toBeUndefined();
    expect(out[0].response_jsonb).toBeUndefined();
    expect(out[0].failed_validations_jsonb).toEqual([
      {
        id: 'stale_response_details_schema',
        check: 'response_schema',
        description: 'STALE_RESPONSE details conform to stale-response schema',
        json_pointer: '/errors/0/details',
        schema_id: '/schemas/error-details/stale-response.json',
        actual: [{ instance_path: '/upstream', message: 'must have required property name' }],
        passed: false,
      },
    ]);
  });

  it('does not guess the first phase for an unmatched failure in a multi-phase storyboard', () => {
    const result = resultWith([
      {
        track: 'creative',
        status: 'fail',
        duration_ms: 100,
        scenarios: [
          phase('creative_lifecycle/discovery', [step({ passed: true, step_id: 'get_capabilities', title: 'Get capabilities' })]),
          phase('creative_lifecycle/list_and_filter', [step({ passed: true, step_id: 'list_all', title: 'List all creatives' })]),
        ],
      },
    ]) as any;
    result.failures = [
      {
        track: 'creative',
        storyboard_id: 'creative_lifecycle',
        step_id: 'list_filtered',
        step_title: 'List creatives filtered by format',
        task: 'list_creatives',
        error: 'Probe validations failed.',
        validation: {
          id: 'list_filtered_display_only',
          check: 'field_value',
          description: 'Filtered result contains only display creatives',
          expected: 'display_300x250',
          actual: 'native_in_feed',
        },
        fix_command: 'adcp storyboard step https://x creative_lifecycle list_filtered --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      storyboard_id: 'creative_lifecycle',
      phase_id: 'unknown',
      step_id: 'list_filtered',
    });
  });

  it('resolves an unmatched hidden failure to its authored phase instead of the first scenario', () => {
    mockGetStoryboard.mockReturnValue({
      phases: [
        {
          id: 'discovery',
          steps: [
            { id: 'get_capabilities', title: 'Get capabilities', task: 'get_adcp_capabilities' },
          ],
        },
        {
          id: 'list_and_filter',
          steps: [
            { id: 'list_filtered', title: 'List creatives filtered by format', task: 'list_creatives' },
          ],
        },
      ],
    } as any);
    const result = resultWith([
      {
        track: 'creative',
        status: 'fail',
        duration_ms: 100,
        scenarios: [
          phase('creative_lifecycle/discovery', [step({ passed: true, step_id: 'get_capabilities', title: 'Get capabilities' })]),
          phase('creative_lifecycle/list_and_filter', [
            step({
              passed: true,
              step_id: 'list_filtered',
              title: 'List creatives filtered by format',
              task: 'list_creatives',
            }),
          ]),
        ],
      },
    ]) as any;
    result.failures = [
      {
        track: 'creative',
        storyboard_id: 'creative_lifecycle',
        step_id: 'list_filtered',
        step_title: 'List creatives filtered by format',
        task: 'list_creatives',
        error: 'Probe validations failed.',
        validation: {
          id: 'list_filtered_display_only',
          check: 'field_value',
          description: 'Filtered result contains only display creatives',
          expected: 'display_300x250',
          actual: 'native_in_feed',
        },
        fix_command: 'adcp storyboard step https://x creative_lifecycle list_filtered --json',
      },
    ];

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      storyboard_id: 'creative_lifecycle',
      phase_id: 'list_and_filter',
      step_id: 'list_filtered',
    });
  });

  it('does not consume a later-phase failure summary for an earlier step with the same title', () => {
    const sharedTitle = 'Validate response shape';
    const phaseOneFail = step({
      passed: false,
      step_id: 'phase_one_check',
      phase_id: 'phase_one',
      title: sharedTitle,
      task: 'list_creatives',
      error: 'Probe validations failed.',
      validations: [
        {
          id: 'phase_one_visible_failure',
          check: 'field_value',
          passed: false,
          description: 'Phase one visible failure',
          expected: 'one',
          actual: 'two',
        },
      ],
    });
    const result = resultWith([
      {
        track: 'creative',
        status: 'fail',
        duration_ms: 100,
        scenarios: [
          phase('creative_lifecycle/phase_one', [phaseOneFail]),
          phase('creative_lifecycle/phase_two', []),
        ],
      },
    ]) as any;
    result.failures = [
      {
        track: 'creative',
        storyboard_id: 'creative_lifecycle',
        step_id: 'phase_two_hidden',
        step_title: sharedTitle,
        task: 'list_creatives',
        error: 'Probe validations failed.',
        validation: {
          id: 'phase_two_hidden_validation',
          check: 'field_value',
          description: 'Phase two hidden failure',
          expected: 'display_300x250',
          actual: 'native_in_feed',
        },
        fix_command: 'adcp storyboard step https://x creative_lifecycle phase_two_hidden --json',
      },
    ];
    mockGetStoryboard.mockReturnValue({
      phases: [
        {
          id: 'phase_one',
          steps: [
            { id: 'phase_one_check', title: sharedTitle, task: 'list_creatives' },
          ],
        },
        {
          id: 'phase_two',
          steps: [
            { id: 'phase_two_hidden', title: sharedTitle, task: 'list_creatives' },
          ],
        },
      ],
    } as any);

    const out = extractFailingStepDiagnostics(result);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      phase_id: 'phase_one',
      step_id: 'phase_one_check',
    });
    expect(out[0].failed_validations_jsonb).toEqual([
      {
        id: 'phase_one_visible_failure',
        check: 'field_value',
        passed: false,
        description: 'Phase one visible failure',
        expected: 'one',
        actual: 'two',
      },
    ]);
    expect(out[1]).toMatchObject({
      phase_id: 'phase_two',
      step_id: 'phase_two_hidden',
    });
    expect(out[1].failed_validations_jsonb).toEqual([
      {
        id: 'phase_two_hidden_validation',
        check: 'field_value',
        description: 'Phase two hidden failure',
        expected: 'display_300x250',
        actual: 'native_in_feed',
        passed: false,
      },
    ]);
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
