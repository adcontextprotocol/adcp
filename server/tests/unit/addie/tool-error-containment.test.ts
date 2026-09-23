import { describe, expect, it } from 'vitest';
import { countContainedToolErrors, type ToolExecution } from '../../../src/addie/model-providers/tool-orchestration.js';

function execution(operation: string, failed: boolean, overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    tool_name: 'call_adcp_task',
    parameters: { task: operation, agent_url: 'https://agent.example/mcp', params: { idempotency_key: 'discovery-request-key' } },
    result: failed ? 'The parameters need correction.' : 'Verified result.',
    is_error: failed,
    duration_ms: 1,
    sequence: failed ? 1 : 2,
    normalized_result: {
      status: failed ? 'invalid_input' : 'ok',
      user_summary: failed ? 'The parameters need correction.' : 'Verified result.',
      source: 'structured',
      telemetry: { operation, ...(failed && { error_category: 'validation' }) },
    },
    ...overrides,
  };
}

describe('observed tool error containment', () => {
  it('contains unsupported proposals followed by same-target product discovery without marking proposals recovered', () => {
    const rejected = execution('request_proposals', true);
    const discovery = execution('get_products', false);
    expect(countContainedToolErrors([rejected, discovery], true)).toBe(1);
    expect(rejected.normalized_result?.telemetry?.recovered_by_later_success).toBeUndefined();
  });

  it('contains corrected discovery with a different idempotency key without claiming exact recovery', () => {
    const rejected = execution('get_products', true);
    const corrected = execution('get_products', false, {
      tool_name: 'call_adcp_get_products',
      parameters: { agent_url: 'https://agent.example/mcp', idempotency_key: 'a-different-request-key' },
    });
    expect(countContainedToolErrors([rejected, corrected], true)).toBe(1);
    expect(rejected.normalized_result?.telemetry?.recovered_by_later_success).toBeUndefined();
  });

  it('does not double-count exactly recovered failures as contained', () => {
    const rejected = execution('get_products', true);
    rejected.normalized_result!.telemetry!.recovered_by_later_success = true;
    expect(countContainedToolErrors([rejected, execution('get_products', false)], true)).toBe(0);
  });

  it.each(['get_adcp_capabilities', 'list_creative_formats', 'get_media_buys'])(
    'observes same-agent continuation with %s without depending on a hardcoded task pair', operation => {
      expect(countContainedToolErrors([
        execution('request_proposals', true), execution(operation, false),
      ], true)).toBe(1);
    },
  );

  it.each([
    ['another target', { parameters: { task: 'get_products', agent_url: 'https://other.example/mcp' } }],
    ['another tenant', { parameters: { task: 'get_products', agent_url: 'https://agent.example/mcp/tenant-b' } }],
    ['a failed read', { is_error: true }],
    ['a policy-blocked read', { blocked_by_policy: true }],
    ['an arbitrary tool', { tool_name: 'search_docs' }],
    ['a missing operation', { normalized_result: { status: 'ok', user_summary: 'Done.', source: 'structured' } }],
    ['an empty result', { normalized_result: { status: 'empty', user_summary: 'None.', source: 'structured', telemetry: { operation: 'get_products' } } }],
    ['mismatched operation metadata', { parameters: { task: 'list_creative_formats', agent_url: 'https://agent.example/mcp' } }],
  ] satisfies Array<[string, Partial<ToolExecution>]>)(
    'leaves errors unresolved after %s', (_label, overrides) => {
      expect(countContainedToolErrors([
        execution('request_proposals', true), execution('get_products', false, overrides),
      ], true)).toBe(0);
    },
  );

  it('does not use a later successful mutation as containment evidence', () => {
    expect(countContainedToolErrors([
      execution('request_proposals', true), execution('create_media_buy', false),
    ], true)).toBe(0);
  });

  it.each(['transport', 'authentication', 'authorization', 'application', 'unknown'] as const)(
    'leaves %s errors unresolved despite successful subsequent reads', category => {
      const failed = execution('get_products', true);
      failed.normalized_result!.telemetry!.error_category = category;
      expect(countContainedToolErrors([failed, execution('get_products', false)], true)).toBe(0);
    },
  );

  it('requires a complete answer and subsequent read, rather than prose alone or an earlier success', () => {
    const failed = execution('request_proposals', true);
    const success = execution('get_products', false);
    expect(countContainedToolErrors([failed, success], false)).toBe(0);
    expect(countContainedToolErrors([success, failed], true)).toBe(0);
    expect(countContainedToolErrors([failed], true)).toBe(0);
  });

  it('does not correlate missing targets or policy rejections', () => {
    const failed = execution('request_proposals', true, { parameters: { task: 'request_proposals' } });
    const success = execution('get_products', false, { parameters: { task: 'get_products' } });
    expect(countContainedToolErrors([failed, success], true)).toBe(0);
    expect(countContainedToolErrors([
      execution('request_proposals', true, { blocked_by_policy: true }), execution('get_products', false),
    ], true)).toBe(0);
  });
});
