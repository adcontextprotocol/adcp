/**
 * Pins the Anthropic tool_use contract for brand-classifier.classifyBrand.
 *
 * Auth-relevant fields (keller_type, confidence, house_domain) flow into
 * autoLinkByVerifiedDomain, which inherits child-brand employees into a
 * paying parent org's WorkOS membership. The tool_use schema + runtime
 * allowlists below are the load-bearing defense.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrandfetchEnrichmentResult } from '../../src/services/brandfetch.js';

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

function toolUseResponse(input: unknown) {
  return {
    content: [
      { type: 'tool_use', name: 'classify_brand', id: 'toolu_test', input },
    ],
  };
}

const SAMPLE_BRAND_DATA: BrandfetchEnrichmentResult = {
  success: true,
  manifest: {
    name: 'Apple',
    description: 'Apple makes computers and phones',
    url: 'https://apple.com',
    logos: [],
    colors: [],
    fonts: [],
  },
  company: { industries: ['technology'] },
  raw: { links: [] },
} as unknown as BrandfetchEnrichmentResult;

describe('classifyBrand: tool_use contract', () => {
  let classifyBrand: typeof import('../../src/services/brand-classifier.js').classifyBrand;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    vi.resetModules();
    ({ classifyBrand } = await import('../../src/services/brand-classifier.js'));
  });

  it('ships classify_brand with input_schema constraining keller_type and confidence', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        keller_type: 'master',
        house_domain: null,
        parent_brand: null,
        canonical_domain: 'apple.com',
        related_domains: [],
        confidence: 'high',
        reasoning: 'Top-level corporate brand',
      }),
    );

    await classifyBrand('apple.com', SAMPLE_BRAND_DATA);

    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    const call = mocks.anthropicCreate.mock.calls[0][0];

    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('classify_brand');
    const schema = call.tools[0].input_schema;
    expect(schema.properties.keller_type.enum).toEqual(['master', 'sub_brand', 'endorsed', 'independent']);
    expect(schema.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'classify_brand' });
  });

  it('reads tool_use.input directly into the classification result', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        keller_type: 'sub_brand',
        house_domain: 'disney.com',
        parent_brand: 'Disney',
        canonical_domain: 'disneyplus.com',
        related_domains: ['disney.com'],
        confidence: 'high',
        reasoning: 'Disney+ is a Disney sub-brand',
      }),
    );

    const result = await classifyBrand('disneyplus.com', SAMPLE_BRAND_DATA);
    expect(result).toEqual({
      keller_type: 'sub_brand',
      house_domain: 'disney.com',
      parent_brand: 'Disney',
      canonical_domain: 'disneyplus.com',
      related_domains: ['disney.com'],
      confidence: 'high',
      reasoning: 'Disney+ is a Disney sub-brand',
    });
  });

  it('returns null when the model does not emit a tool_use block (defensive)', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse to use the tool' }],
    });

    const result = await classifyBrand('apple.com', SAMPLE_BRAND_DATA);
    expect(result).toBeNull();
  });

  it('returns null when keller_type is not in the runtime allowlist', async () => {
    // Schema enum prevents this at the SDK layer. Runtime allowlist is the
    // load-bearing defense (keller_type drives brand-hierarchy inheritance).
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        keller_type: 'something_made_up',
        canonical_domain: 'apple.com',
        confidence: 'high',
        reasoning: 'whatever',
      }),
    );

    const result = await classifyBrand('apple.com', SAMPLE_BRAND_DATA);
    expect(result).toBeNull();
  });

  it('collapses an out-of-allowlist confidence value to "low" (auth-relevant)', async () => {
    // confidence='high' is what gates membership inheritance in
    // autoLinkByVerifiedDomain. Any unrecognised value must collapse to 'low'.
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        keller_type: 'master',
        canonical_domain: 'apple.com',
        confidence: 'extreme',
        reasoning: 'whatever',
      }),
    );

    const result = await classifyBrand('apple.com', SAMPLE_BRAND_DATA);
    expect(result?.confidence).toBe('low');
  });

  it('returns null and skips the LLM call when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const mod = await import('../../src/services/brand-classifier.js');
    const result = await mod.classifyBrand('apple.com', SAMPLE_BRAND_DATA);
    expect(result).toBeNull();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });
});
