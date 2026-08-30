import { describe, expect, it, vi } from 'vitest';
import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
} from '../../../src/addie/model-providers/model-provider.js';
import {
  ROUTER_SHADOW_PROMOTION_POLICY_VERSION,
  ROUTER_SHADOW_RESERVED_COST_MICROS,
  getRouterShadowSummary,
  maintainRouterShadowAttempts,
  runRouterShadow,
  selectRouterShadowCohort,
} from '../../../src/addie/router-shadow.js';
import {
  buildRouterModelRequest,
  type RouterModelObservation,
} from '../../../src/addie/router.js';

const SECRET_PROMPT = 'private-production-question-sentinel';
const SECRET_OUTPUT = 'private-provider-reason-sentinel';
const CHANNEL_ID = 'C0123456789';
const SECOND_CHANNEL_ID = 'C9876543210';

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    ADDIE_ROUTER_LUNA_SHADOW_ENABLED: 'true',
    ADDIE_ROUTER_LUNA_SHADOW_PRODUCTION_DATA_APPROVED: 'true',
    ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS: CHANNEL_ID,
    ADDIE_ROUTER_LUNA_SHADOW_SAMPLE_BPS: '10000',
    ADDIE_ROUTER_LUNA_SHADOW_DAILY_LIMIT: '1',
    ADDIE_ROUTER_LUNA_SHADOW_DAILY_BUDGET_MICROS: String(
      ROUTER_SHADOW_RESERVED_COST_MICROS,
    ),
    ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY: 'k'.repeat(32),
    ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY_VERSION: 'test-v1',
    OPENAI_API_KEY: 'test-openai-key',
    ...overrides,
  };
}

function observation(rawResponseText = JSON.stringify({
  action: 'respond',
  tool_sets: ['knowledge'],
  confidence: 'high',
  requires_depth: false,
  reason: SECRET_OUTPUT,
})): RouterModelObservation {
  const canonicalRequest = buildRouterModelRequest({
    message: SECRET_PROMPT,
    source: 'channel',
  });
  const capabilities = {
    streaming: false,
    structuredOutput: false,
    reasoning: false,
    reasoningEfforts: ['provider_default'] as const,
    customTools: false,
    providerWebSearch: false,
    imageInput: false,
    documentInput: false,
  };
  return {
    canonicalRequest,
    primaryInvocation: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      capabilities,
      providerRequest: Object.freeze({
        model: 'claude-haiku-4-5',
        messages: canonicalRequest.messages,
        max_tokens: 300,
      }),
    },
    isAdmin: false,
    productionPlan: {
      action: 'respond',
      tool_sets: ['knowledge'],
      confidence: 'high',
      reason: 'not persisted',
      decision_method: 'llm',
      requires_precision: false,
      requires_depth: false,
    },
    rawResponseText,
    responseContent: [{ type: 'text', text: rawResponseText }],
    finishReason: 'stop',
    primaryErrorCategory: null,
    requestedProvider: 'anthropic',
    requestedModel: 'claude-haiku-4-5',
    returnedProvider: 'anthropic',
    returnedModel: 'claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    latencyMs: 50,
  };
}

function fakeProvider(
  text: string,
  options: {
    finishReason?: 'stop' | 'length' | 'refusal';
    hang?: boolean;
    drift?: boolean;
    oversize?: boolean;
    omitBeforeDispatch?: boolean;
  } = {},
): ModelProvider & { dispatches: number } {
  let prepareCalls = 0;
  const provider: ModelProvider & { dispatches: number } = {
    id: 'openai',
    dispatches: 0,
    capabilities: {
      streaming: false,
      structuredOutput: true,
      reasoning: true,
      reasoningEfforts: ['provider_default', 'none'],
      customTools: false,
      providerWebSearch: false,
      imageInput: false,
      documentInput: false,
    },
    prepare(request) {
      prepareCalls++;
      return {
        provider: 'openai',
        model: request.model,
        capabilities: this.capabilities,
        providerRequest: Object.freeze({
          model: request.model,
          messages: request.messages,
          reasoning: request.reasoning,
          tools: [],
          ...(options.drift && { prepareCall: prepareCalls }),
          ...(options.oversize && { blob: 'x'.repeat(70_000) }),
        }),
      };
    },
    async *respond(
      request: ModelRequest,
      respondOptions?: ModelRespondOptions,
    ): AsyncIterable<NormalizedModelEvent> {
      if (!options.omitBeforeDispatch) {
        await respondOptions?.beforeDispatch?.(this.prepare(request));
      }
      this.dispatches++;
      if (options.hang) {
        await new Promise<void>((_resolve, reject) => {
          respondOptions?.signal?.addEventListener('abort', () => reject(new Error(SECRET_OUTPUT)), {
            once: true,
          });
        });
      }
      const content = text ? [{ type: 'text' as const, text }] : [];
      yield { type: 'response_start', provider: 'openai', model: request.model, id: 'shadow-id' };
      if (text) yield { type: 'text_delta', index: 0, text };
      yield {
        type: 'response_complete',
        response: {
          provider: 'openai',
          model: request.model,
          id: 'shadow-id',
          content,
          finishReason: options.finishReason ?? 'stop',
          providerFinishReason: options.finishReason ?? 'stop',
          usage: { inputTokens: 80, outputTokens: 20 },
        },
      };
    },
  };
  return provider;
}

function claimedQuery() {
  return vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO addie_router_shadow_attempts')) {
      return { rows: [{ attempt_id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
}

const cohortInput = {
  channelId: CHANNEL_ID,
  opportunityId: '1724688000.000001',
  channelIsPublic: true,
  channelIsShared: false,
};

describe('Luna router shadow', () => {
  it.each([
    [{ ADDIE_ROUTER_LUNA_SHADOW_ENABLED: 'false' }, 'disabled'],
    [{ ADDIE_ROUTER_LUNA_SHADOW_PRODUCTION_DATA_APPROVED: 'false' }, 'production_data_not_approved'],
    [{ ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS: 'COTHER00000' }, 'channel_not_allowlisted'],
    [{ ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS: `${CHANNEL_ID},${CHANNEL_ID}` }, 'invalid_configuration'],
    [{ ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS: `${CHANNEL_ID},COTHER00000,COTHER00001,COTHER00002,COTHER00003` }, 'invalid_configuration'],
    [{ ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY: 'short' }, 'invalid_configuration'],
    [{ ADDIE_ROUTER_LUNA_SHADOW_DAILY_BUDGET_MICROS: String(ROUTER_SHADOW_RESERVED_COST_MICROS - 1) }, 'invalid_configuration'],
    [{ OPENAI_API_KEY: undefined }, 'invalid_configuration'],
  ])('fails closed for %s', (override, reason) => {
    expect(selectRouterShadowCohort(cohortInput, environment(override))).toMatchObject({
      selected: false,
      reason,
    });
  });

  it('selects any channel in the bounded allowlist', () => {
    const env = environment({
      ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS: `${CHANNEL_ID},${SECOND_CHANNEL_ID}`,
    });
    expect(selectRouterShadowCohort({
      ...cohortInput,
      channelId: SECOND_CHANNEL_ID,
    }, env)).toEqual({ selected: true, reason: 'selected' });
    expect(selectRouterShadowCohort({
      ...cohortInput,
      channelId: 'COTHER00000',
    }, env)).toEqual({ selected: false, reason: 'channel_not_allowlisted' });
  });

  it('rejects private and shared channels before sampling', () => {
    expect(selectRouterShadowCohort(
      { ...cohortInput, channelIsPublic: false },
      environment(),
    ).reason).toBe('private_channel');
    expect(selectRouterShadowCohort(
      { ...cohortInput, channelIsShared: true },
      environment(),
    ).reason).toBe('shared_channel');
  });

  it('samples deterministically without persisting the source identity', () => {
    const sparse = environment({ ADDIE_ROUTER_LUNA_SHADOW_SAMPLE_BPS: '5000' });
    const first = selectRouterShadowCohort(cohortInput, sparse);
    const second = selectRouterShadowCohort(cohortInput, sparse);
    expect(second).toEqual(first);
    expect(['selected', 'sample_excluded']).toContain(first.reason);
    expect(first).not.toHaveProperty('config');
  });

  it('dispatches one tool-free request and persists only bounded evidence', async () => {
    const shadowText = JSON.stringify({
      action: 'respond',
      tool_sets: ['knowledge'],
      confidence: 'high',
      requires_depth: false,
      reason: SECRET_OUTPUT,
    });
    const provider = fakeProvider(shadowText);
    const runQuery = claimedQuery();
    const result = await runRouterShadow({ ...cohortInput, observation: observation() }, {
      env: environment(),
      provider,
      query: runQuery,
      randomId: () => '00000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-08-26T12:00:00.000Z'),
    });

    expect(result).toEqual({ status: 'succeeded', reason: 'valid_plan' });
    expect(provider.dispatches).toBe(1);
    const allSqlParameters = JSON.stringify(runQuery.mock.calls.map((call) => call[1]));
    expect(allSqlParameters).not.toContain(SECRET_PROMPT);
    expect(allSqlParameters).not.toContain(SECRET_OUTPUT);
    expect(allSqlParameters).toMatch(/[a-f0-9]{64}/);
    const completion = runQuery.mock.calls.find(([sql]) => sql.includes('SET status = $2'));
    expect(completion?.[1]).toEqual(expect.arrayContaining([
      'succeeded',
      'valid_plan',
      true,
    ]));
  });

  it('dispatches even when primary output is not strictly valid', async () => {
    const shadowText = JSON.stringify({ action: 'ignore', reason: 'bounded' });
    const provider = fakeProvider(shadowText);
    const runQuery = claimedQuery();
    const result = await runRouterShadow({
      ...cohortInput,
      observation: observation(`not-json-${SECRET_OUTPUT}`),
    }, {
      env: environment(),
      provider,
      query: runQuery,
      randomId: () => '00000000-0000-4000-8000-000000000002',
      now: () => new Date('2026-08-26T12:00:00.000Z'),
    });
    expect(result).toEqual({ status: 'succeeded', reason: 'valid_plan' });
    expect(provider.dispatches).toBe(1);
    const beginParameters = runQuery.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO addie_router_shadow_attempts'),
    )?.[1];
    expect(beginParameters).toEqual(expect.arrayContaining(['invalid_json']));
    const completionParameters = runQuery.mock.calls.find(([sql]) => sql.includes('SET status = $2'))?.[1];
    expect(completionParameters?.[5]).toBeNull();
  });

  it('records quota exhaustion without a paid call', async () => {
    const provider = fakeProvider('never called');
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO addie_router_shadow_attempts')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT EXISTS')) {
        return { rows: [{ duplicate: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await runRouterShadow({ ...cohortInput, observation: observation() }, {
      env: environment(), provider, query: runQuery,
    });
    expect(result).toEqual({ status: 'not_dispatched', reason: 'daily_limit_reached' });
    expect(provider.dispatches).toBe(0);
    expect(runQuery.mock.calls.some(([sql]) => sql.includes('SET status = $2'))).toBe(false);
  });

  it('blocks request drift and oversized envelopes before the SDK dispatch', async () => {
    for (const [provider, reason] of [
      [fakeProvider('never called', { drift: true }), 'internal_error'],
      [fakeProvider('never called', { oversize: true }), 'request_too_large'],
    ] as const) {
      const result = await runRouterShadow({ ...cohortInput, observation: observation() }, {
        env: environment(), provider, query: claimedQuery(),
      });
      expect(result.reason).toBe(reason);
      expect(provider.dispatches).toBe(0);
    }
  });

  it('fails closed before persistence when the primary provider boundary changed', async () => {
    const provider = fakeProvider('never called');
    const runQuery = claimedQuery();
    const result = await runRouterShadow({
      ...cohortInput,
      observation: { ...observation(), requestedProvider: 'google' },
    }, { env: environment(), provider, query: runQuery });
    expect(result).toEqual({ status: 'not_selected', reason: 'invalid_configuration' });
    expect(runQuery).not.toHaveBeenCalled();
    expect(provider.dispatches).toBe(0);
  });

  it('does not accept a provider response without a last-moment dispatch receipt', async () => {
    const provider = fakeProvider('{"action":"ignore","reason":"bounded"}', {
      omitBeforeDispatch: true,
    });
    const result = await runRouterShadow({ ...cohortInput, observation: observation() }, {
      env: environment(), provider, query: claimedQuery(),
    });
    expect(result).toEqual({ status: 'error', reason: 'internal_error' });
    expect(provider.dispatches).toBe(1);
  });

  it('times out after exactly one dispatch and keeps the failure categorical', async () => {
    const provider = fakeProvider('', { hang: true });
    const runQuery = claimedQuery();
    const result = await runRouterShadow({ ...cohortInput, observation: observation() }, {
      env: environment(), provider, query: runQuery, timeoutMs: 5,
    });
    expect(result).toEqual({ status: 'error', reason: 'timeout_after_dispatch' });
    expect(provider.dispatches).toBe(1);
    expect(JSON.stringify(runQuery.mock.calls)).not.toContain(SECRET_OUTPUT);
  });

  it('returns aggregate numerator/denominator pairs without row evidence', async () => {
    const runQuery = vi.fn().mockResolvedValueOnce({
        rows: [{
          selected: '3', dispatched: '2', terminal: '3', valid: '2',
          authenticated_terminal: '3', running: '0', primary_valid: '2',
          shadow_valid: '2', shadow_validity_denominator: '2', effective_matches: '1',
          action_matches: '1', action_denominator: '2',
          tool_matches: '1', tool_denominator: '1', input_tokens: '160',
          output_tokens: '40', usage_missing: '0', estimated_cost_micros: '80',
          outcomes: [
            { status: 'succeeded', reason: 'valid_plan', count: '2' },
            { status: 'error', reason: 'provider_error', count: '1' },
          ],
          primary_outcomes: [{ status: 'valid_plan', count: '2' }, { status: 'empty', count: '1' }],
          action_confusion: [{ primary_action: 'respond', shadow_action: 'respond', count: '1' }],
          primary_models: [{ model: 'claude-haiku-4-5', count: '2' }],
          shadow_models: [{ model: 'gpt-5.6-luna', count: '2' }],
          admission_sampled: '3', admission_claimed: '3', admission_duplicates: '0',
          admission_quota_exhausted: '0', primary_model_missing: '0',
          shadow_model_missing: '0', primary_model_count: '1', shadow_model_count: '1',
          identity_failures: '0',
          primary_input_tokens: '300', primary_output_tokens: '90',
          primary_cache_read_tokens: '0', primary_cache_write_tokens: '0',
          primary_usage_missing: '0', primary_estimated_cost_micros: '750',
          shadow_input_tokens: '160', shadow_output_tokens: '40',
          shadow_usage_missing: '0', shadow_estimated_cost_micros: '80',
          reserved_cost_micros: '28000', primary_p50: 40, primary_p95: 70,
          shadow_p50: 100, shadow_p95: 140,
        }],
      });
    const summary = await getRouterShadowSummary(7, {
      query: runQuery,
      now: new Date('2026-08-26T12:00:00.000Z'),
    });
    expect(summary).toMatchObject({
      selected: 3,
      dispatched: 2,
      terminal: 3,
      shadow_validity: { numerator: 2, denominator: 2 },
      action_agreement: { numerator: 1, denominator: 2 },
      tool_set_agreement: { numerator: 1, denominator: 1 },
      admission: { sampled: 3, claimed: 3, duplicates: 0, quota_exhausted: 0, unclassified: 0 },
      evidence_complete: false,
      comparison_eligible: false,
    });
    expect(summary).not.toHaveProperty('attempts');
    expect(runQuery).toHaveBeenCalledOnce();
    expect(runQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'addie-router-luna-shadow:v2',
      'openai-gpt-5.6-luna-2026-08-26',
      'gpt-5.6-luna',
    ]));
    await expect(getRouterShadowSummary(9, { query: runQuery })).rejects.toThrow(RangeError);
  });

  it('keeps quota exclusions, mixed models, and incomplete costs out of comparison-ready evidence', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        selected: '30', dispatched: '30', terminal: '30', authenticated_terminal: '30',
        running: '0', primary_valid: '29', shadow_valid: '29',
        shadow_validity_denominator: '30', outcomes: [
          { status: 'succeeded', reason: 'valid_plan', count: '29' },
          { status: 'error', reason: 'provider_error', count: '1' },
        ],
        admission_sampled: '31', admission_claimed: '30', admission_duplicates: '0',
        admission_quota_exhausted: '1', primary_model_count: '2', shadow_model_count: '1',
        identity_failures: '0', primary_usage_missing: '1', shadow_usage_missing: '0',
        primary_model_missing: '1', shadow_model_missing: '0',
      }],
    });
    const summary = await getRouterShadowSummary(1, { query });
    expect(summary).toMatchObject({
      admission: { sampled: 31, claimed: 30, quota_exhausted: 1 },
      evidence_complete: true,
      comparison_eligible: false,
      cost_comparison_eligible: false,
      models: { primary_missing: 1, shadow_missing: 0 },
    });
  });

  it('admits a clean 30-sample cohort for quality and cost comparison', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [cleanSummaryRow()] });
    await expect(getRouterShadowSummary(1, { query })).resolves.toMatchObject({
      evidence_complete: true,
      comparison_eligible: true,
      cost_comparison_eligible: true,
      rollout: {
        policy_version: ROUTER_SHADOW_PROMOTION_POLICY_VERSION,
        scope: 'shadow_evidence_only',
        limitation: 'fixed_trace_gate_must_pass_separately',
        pass: true,
        failed_dimensions: [],
      },
    });
  });

  it.each([
    ['shadow validity', { shadow_valid: '29' }, 'shadow_validity'],
    ['action agreement', { effective_matches: '28' }, 'valid_action_match'],
    ['tool-set agreement', { tool_matches: '28' }, 'tool_set_agreement'],
    ['privilege safety', { privilege_attempts: '1' }, 'privilege_attempts'],
    ['invalid tool-set safety', { invalid_tool_set_attempts: '1' }, 'invalid_tool_set_attempts'],
    ['latency', { shadow_p95: 15_001 }, 'shadow_latency_p95'],
    ['absolute cost', { shadow_estimated_cost_micros: '150001' }, 'shadow_average_cost_micros'],
    ['relative cost', { shadow_estimated_cost_micros: '120001' }, 'shadow_to_primary_cost_ratio'],
  ] as const)('blocks promotion on %s', async (_name, overrides, dimension) => {
    const query = vi.fn().mockResolvedValue({ rows: [cleanSummaryRow(overrides)] });
    const summary = await getRouterShadowSummary(1, { query });
    expect(summary.rollout.pass).toBe(false);
    expect(summary.rollout.failed_dimensions).toContain(dimension);
  });

  it('fails promotion closed on missing rate, latency, and cost denominators', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [cleanSummaryRow({
      primary_valid: '0',
      shadow_valid: '0',
      shadow_validity_denominator: '0',
      effective_matches: '0',
      tool_matches: '0',
      tool_denominator: '0',
      primary_estimated_cost_micros: '0',
      shadow_estimated_cost_micros: '0',
      shadow_p95: null,
    })] });
    const summary = await getRouterShadowSummary(1, { query });
    expect(summary.rollout.pass).toBe(false);
    expect(summary.rollout.failed_dimensions).toEqual(expect.arrayContaining([
      'primary_validity',
      'shadow_validity',
      'valid_action_match',
      'tool_set_agreement',
      'shadow_latency_p95',
      'shadow_to_primary_cost_ratio',
    ]));
  });

  it.each([
    ['low sample', { selected: '29', dispatched: '29', terminal: '29', authenticated_terminal: '29', shadow_validity_denominator: '29', admission_sampled: '29', admission_claimed: '29', outcomes: [{ status: 'succeeded', reason: 'valid_plan', count: '29' }] }, true, false, false],
    ['quota exclusion', { admission_sampled: '31', admission_quota_exhausted: '1' }, true, false, false],
    ['unclassified admission', { admission_sampled: '31' }, false, false, false],
    ['mixed primary model', { primary_model_count: '2' }, true, false, false],
    ['identity failure', { identity_failures: '1' }, true, false, false],
    ['missing usage', { primary_usage_missing: '1' }, true, true, false],
  ] as const)(
    'gates %s independently',
    async (_name, overrides, evidenceComplete, comparisonEligible, costEligible) => {
      const query = vi.fn().mockResolvedValue({ rows: [cleanSummaryRow(overrides)] });
      const summary = await getRouterShadowSummary(1, { query });
      expect(summary.evidence_complete).toBe(evidenceComplete);
      expect(summary.comparison_eligible).toBe(comparisonEligible);
      expect(summary.cost_comparison_eligible).toBe(costEligible);
    },
  );

  it('fails closed when aggregate outcomes do not reconcile in one snapshot', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        selected: '2', dispatched: '1', terminal: '1', authenticated_terminal: '1',
        running: '1', outcomes: [{ status: 'succeeded', reason: 'valid_plan', count: '1' }],
      }],
    });
    await expect(getRouterShadowSummary(1, { query })).rejects.toThrow(
      'router shadow summary did not reconcile',
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it('recovers stale attempts and purges expired evidence categorically', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      rows: [{ recovered: '2', purged: '1' }],
    });
    await expect(maintainRouterShadowAttempts({
      query: runQuery,
      now: new Date('2026-08-26T12:00:00.000Z'),
    })).resolves.toEqual({ recovered: 2, purged: 1 });
    expect(runQuery.mock.calls[0][0]).not.toContain(SECRET_PROMPT);
    expect(runQuery.mock.calls[0][0]).toContain('retained_until > $1::timestamptz');
    expect(runQuery.mock.calls[0][0]).toContain(
      "selected_at < $1::timestamptz - INTERVAL '15 minutes'",
    );
  });
});

function cleanSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    selected: '30', dispatched: '30', terminal: '30', authenticated_terminal: '30',
    running: '0', primary_valid: '30', shadow_valid: '30',
    shadow_validity_denominator: '30', effective_matches: '30',
    action_matches: '30', action_denominator: '30',
    tool_matches: '30', tool_denominator: '30',
    confidence_matches: '30', confidence_denominator: '30',
    depth_matches: '30', depth_denominator: '30', emoji_matches: '0', emoji_denominator: '0',
    privilege_attempts: '0', invalid_tool_set_attempts: '0', outcomes: [
      { status: 'succeeded', reason: 'valid_plan', count: '30' },
    ],
    admission_sampled: '30', admission_claimed: '30', admission_duplicates: '0',
    admission_quota_exhausted: '0', primary_model_count: '1', shadow_model_count: '1',
    identity_failures: '0', primary_usage_missing: '0', shadow_usage_missing: '0',
    primary_model_missing: '0', shadow_model_missing: '0',
    primary_input_tokens: '1200', primary_output_tokens: '300',
    primary_cache_read_tokens: '0', primary_cache_write_tokens: '0',
    primary_estimated_cost_micros: '120000',
    shadow_input_tokens: '1200', shadow_output_tokens: '300',
    shadow_estimated_cost_micros: '60000', reserved_cost_micros: '420000',
    primary_p50: 700, primary_p95: 1400, shadow_p50: 500, shadow_p95: 1000,
    ...overrides,
  };
}
