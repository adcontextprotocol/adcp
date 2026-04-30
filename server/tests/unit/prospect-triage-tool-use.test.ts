/**
 * Pins the Anthropic tool_use contract for prospect-triage.assessWithClaude:
 *   - Ships the assess_prospect tool with input_schema (action / owner /
 *     priority / company_type enums)
 *   - Forces the tool via tool_choice
 *   - Reads tool_use.input directly (no JSON.parse, no fence stripping)
 *   - Defensive throw when the model returns no tool_use block (callers
 *     already catch this and return action='skip', reason='assessment_error')
 *   - Runtime company_type allowlist still bounds bogus enum values
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  return { default: FakeAnthropic, APIError };
});

// db/client and other DB imports are pulled in transitively. Stub them so the
// module loads without a live pool.
vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  SETTING_KEYS: { PROSPECT_TRIAGE_ENABLED: 'prospect_triage_enabled' },
}));

function toolUseResponse(input: unknown) {
  return {
    content: [
      { type: 'tool_use', name: 'assess_prospect', id: 'toolu_test', input },
    ],
  };
}

describe('assessWithClaude: tool_use contract', () => {
  let assessWithClaude: typeof import('../../src/services/prospect-triage.js').assessWithClaude;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    vi.resetModules();
    ({ assessWithClaude } = await import('../../src/services/prospect-triage.js'));
  });

  it('ships assess_prospect with input_schema constraining action/owner/priority/company_type', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        action: 'create',
        reason: 'Mid-market ad tech',
        owner: 'addie',
        priority: 'high',
        verdict: 'Programmatic vendor in our target segment',
        company_name: 'Example AdTech',
        company_type: 'adtech',
      }),
    );

    await assessWithClaude('example.com', 'Industry: Advertising');

    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    const call = mocks.anthropicCreate.mock.calls[0][0];

    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('assess_prospect');
    const schema = call.tools[0].input_schema;
    expect(schema.properties.action.enum).toEqual(['skip', 'create']);
    expect(schema.properties.owner.enum).toEqual(['addie', 'human']);
    expect(schema.properties.priority.enum).toEqual(['high', 'standard']);
    // company_type enum should mirror COMPANY_TYPE_VALUES + null fallback
    expect(schema.properties.company_type.enum).toEqual(
      expect.arrayContaining(['adtech', 'agency', 'brand', 'publisher', 'data', 'ai', 'other']),
    );
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'assess_prospect' });
  });

  it('reads tool_use.input directly into the triage response', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        action: 'create',
        reason: 'Programmatic vendor',
        owner: 'addie',
        priority: 'standard',
        verdict: 'Mid-market ad tech',
        company_name: 'Example',
        company_type: 'adtech',
      }),
    );

    const result = await assessWithClaude('example.com', '');
    expect(result).toEqual({
      action: 'create',
      reason: 'Programmatic vendor',
      owner: 'addie',
      priority: 'standard',
      verdict: 'Mid-market ad tech',
      company_name: 'Example',
      company_type: 'adtech',
    });
  });

  it('throws when the model does not emit a tool_use block (defensive)', async () => {
    // tool_choice forces the tool, so this is defensive. Callers
    // (triageEmailDomain) catch the throw and return action='skip',
    // reason='assessment_error'.
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse' }],
    });

    await expect(assessWithClaude('example.com', '')).rejects.toThrow(/did not invoke assess_prospect/);
  });

  it('collapses an out-of-allowlist company_type to null (defense-in-depth)', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        action: 'create',
        reason: 'Some reason',
        owner: 'addie',
        priority: 'standard',
        verdict: 'verdict text',
        company_name: 'Example',
        company_type: 'crystal_ball',
      }),
    );

    const result = await assessWithClaude('example.com', '');
    expect(result.company_type).toBeNull();
  });

  it('defaults priority to "standard" when missing or out of allowlist', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        action: 'create',
        reason: 'Some reason',
        owner: 'addie',
        verdict: 'verdict',
        company_name: 'Example',
      }),
    );

    const result = await assessWithClaude('example.com', '');
    expect(result.priority).toBe('standard');
  });

  it('returns the no-Claude fallback when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const mod = await import('../../src/services/prospect-triage.js');
    const result = await mod.assessWithClaude('example.com', '');
    expect(result.reason).toBe('claude_not_configured');
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });
});
