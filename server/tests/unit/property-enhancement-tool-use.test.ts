/**
 * Pins the Anthropic tool_use contract for property-enhancement.analyzeProperty:
 *   - Ships the analyze_property tool with input_schema (confidence enum)
 *   - Forces the tool via tool_choice
 *   - Reads tool_use.input directly (no JSON.parse, no fence stripping)
 *   - Defensive fall-through when the model returns no tool_use block
 *   - Runtime confidence allowlist still bounds bogus enum values
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

// AdAgentsManager and PropertyDatabase are constructed at import time but are
// not exercised by analyzeProperty.
vi.mock('../../src/adagents-manager.js', () => ({
  AdAgentsManager: class {
    validateDomain = vi.fn();
  },
}));
vi.mock('../../src/db/property-db.js', () => ({
  PropertyDatabase: class {
    getHostedPropertyByDomain = vi.fn();
    createHostedProperty = vi.fn();
  },
}));
vi.mock('../../src/addie/mcp/registry-review.js', () => ({
  reviewNewRecord: vi.fn().mockResolvedValue(undefined),
}));

function toolUseResponse(input: unknown) {
  return {
    content: [
      { type: 'tool_use', name: 'analyze_property', id: 'toolu_test', input },
    ],
  };
}

describe('analyzeProperty: tool_use contract', () => {
  let analyzeProperty: typeof import('../../src/services/property-enhancement.js').analyzeProperty;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    vi.resetModules();
    ({ analyzeProperty } = await import('../../src/services/property-enhancement.js'));
  });

  it('ships analyze_property with input_schema and forces it via tool_choice', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        is_publisher: true,
        likely_inventory_types: ['display', 'video'],
        confidence: 'high',
        reasoning: 'Major news site with ad inventory',
      }),
    );

    await analyzeProperty('example.com');

    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    const call = mocks.anthropicCreate.mock.calls[0][0];

    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('analyze_property');
    const schema = call.tools[0].input_schema;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(
      expect.arrayContaining(['is_publisher', 'likely_inventory_types', 'confidence', 'reasoning']),
    );
    expect(schema.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'analyze_property' });
  });

  it('reads tool_use.input directly into the analysis result', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        is_publisher: true,
        likely_inventory_types: ['display'],
        structural_subdomain_note: null,
        confidence: 'medium',
        reasoning: 'Looks like a real publisher',
      }),
    );

    const result = await analyzeProperty('example.com');
    expect(result).toEqual({
      is_publisher: true,
      likely_inventory_types: ['display'],
      structural_subdomain_note: null,
      confidence: 'medium',
      reasoning: 'Looks like a real publisher',
    });
  });

  it('returns null when the model does not emit a tool_use block (defensive)', async () => {
    // tool_choice forces the tool, so this path is defensive — it only fires
    // if the model refuses or the SDK shape changes upstream.
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse to use the tool' }],
    });

    const result = await analyzeProperty('example.com');
    expect(result).toBeNull();
  });

  it('collapses an out-of-allowlist confidence value to "low" (defense-in-depth)', async () => {
    // Schema enum should prevent this at the SDK layer; the runtime filter is
    // the load-bearing defense.
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        is_publisher: true,
        likely_inventory_types: ['display'],
        confidence: 'extreme',
        reasoning: 'whatever',
      }),
    );

    const result = await analyzeProperty('example.com');
    expect(result?.confidence).toBe('low');
  });

  it('returns null and skips the LLM call when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const mod = await import('../../src/services/property-enhancement.js');
    const result = await mod.analyzeProperty('example.com');
    expect(result).toBeNull();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });
});
