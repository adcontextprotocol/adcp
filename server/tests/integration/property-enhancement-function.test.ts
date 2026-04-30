/**
 * Integration test: analyzeProperty tool_use output → hosted_properties DB write contract.
 *
 * enhanceProperty() calls analyzeProperty(), which uses the analyze_property
 * tool_use pattern. This test pins that the tool_use output is correctly written
 * into the hosted_properties row's adagents_json.ext.enhancement.ai_analysis field.
 *
 * There is no HTTP route for enhanceProperty — it is only called by the MCP
 * property-tools handler. The test exercises the function directly, using the
 * real DB for the createHostedProperty write and mocking external services
 * (Anthropic, WHOIS, adagents validation, Addie review trigger).
 *
 * Gap from testing-expert review on PR #3611 (issue #3621): if the ai_analysis
 * shape from analyzeProperty drifted (e.g. likely_inventory_types becoming
 * undefined), the unit tests would pass but the hosted_properties row would
 * silently carry a malformed ext.enhancement block.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  validateDomain: vi.fn(),
  whoisDomain: vi.fn(),
  reviewNewRecord: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  return { default: FakeAnthropic, APIError, APIConnectionError };
});

// adagentsManager is instantiated at module scope in property-enhancement.ts;
// the class mock must be in place before the module loads. Must be a class (or
// regular function) — arrow functions cannot be called with `new`.
vi.mock('../../src/adagents-manager.js', () => ({
  AdAgentsManager: class FakeAdAgentsManager {
    validateDomain = mocks.validateDomain;
  },
}));

vi.mock('whoiser', () => ({
  whoisDomain: mocks.whoisDomain,
}));

vi.mock('../../src/addie/mcp/registry-review.js', () => ({
  reviewNewRecord: mocks.reviewNewRecord,
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { enhanceProperty } from '../../src/services/property-enhancement.js';

const SUFFIX = `${process.pid}_${Date.now()}`;
const TEST_DOMAIN = `prop-enhance-${SUFFIX}.example.com`;

function analyzePropertyResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', name: 'analyze_property', id: 'toolu_test', input }],
  };
}

describe('enhanceProperty — analyzeProperty tool_use output → hosted_properties contract', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain = $1', [TEST_DOMAIN]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain = $1', [TEST_DOMAIN]);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    mocks.validateDomain.mockResolvedValue({ valid: false });
    mocks.whoisDomain.mockResolvedValue({});
    mocks.reviewNewRecord.mockResolvedValue(undefined);
    mocks.anthropicCreate.mockRejectedValue(
      new Error('anthropic.messages.create was not stubbed for this test'),
    );
  });

  it('writes is_publisher and likely_inventory_types from analyze_property output to ext.enhancement', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      analyzePropertyResponse({
        is_publisher: true,
        likely_inventory_types: ['display', 'video'],
        structural_subdomain_note: null,
        confidence: 'high',
        reasoning: 'Domain pattern and name suggest a media publisher.',
      }),
    );

    const result = await enhanceProperty(TEST_DOMAIN, 'system:test');

    expect(result.submitted_to_registry).toBe(true);
    expect(result.already_exists).toBe(false);

    // Assert the shape written to the DB row, not just the return value.
    // If likely_inventory_types drifted to undefined in analyzeProperty's
    // return, the manifest would silently lose the array here.
    const row = await pool.query<{ adagents_json: Record<string, unknown> }>(
      'SELECT adagents_json FROM hosted_properties WHERE publisher_domain = $1',
      [TEST_DOMAIN],
    );
    expect(row.rows).toHaveLength(1);

    const aiAnalysis = (
      (row.rows[0].adagents_json?.ext as Record<string, unknown>)
        ?.enhancement as Record<string, unknown>
    )?.ai_analysis as Record<string, unknown> | undefined;

    expect(aiAnalysis?.is_publisher).toBe(true);
    expect(aiAnalysis?.likely_inventory_types).toEqual(['display', 'video']);
    expect(aiAnalysis?.confidence).toBe('high');
  });

  it('writes is_publisher=false correctly when the model classifies a non-publisher domain', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      analyzePropertyResponse({
        is_publisher: false,
        likely_inventory_types: [],
        structural_subdomain_note: null,
        confidence: 'high',
        reasoning: 'Domain pattern suggests a SaaS tool, not a publisher.',
      }),
    );

    await enhanceProperty(TEST_DOMAIN, 'system:test');

    const row = await pool.query<{ adagents_json: Record<string, unknown> }>(
      'SELECT adagents_json FROM hosted_properties WHERE publisher_domain = $1',
      [TEST_DOMAIN],
    );
    const aiAnalysis = (
      (row.rows[0].adagents_json?.ext as Record<string, unknown>)
        ?.enhancement as Record<string, unknown>
    )?.ai_analysis as Record<string, unknown> | undefined;

    expect(aiAnalysis?.is_publisher).toBe(false);
    expect(aiAnalysis?.likely_inventory_types).toEqual([]);
  });
});
