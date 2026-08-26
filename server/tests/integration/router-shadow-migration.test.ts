import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
} from '../../src/addie/model-providers/model-provider.js';
import {
  ROUTER_SHADOW_RESERVED_COST_MICROS,
  runRouterShadow,
} from '../../src/addie/router-shadow.js';
import {
  buildRouterModelRequest,
  type RouterModelObservation,
} from '../../src/addie/router.js';

const CHANNEL_ID = 'C0123456789';
const KEY_VERSION = 'router-shadow-integration-v1';

function env() {
  return {
    ADDIE_ROUTER_LUNA_SHADOW_ENABLED: 'true',
    ADDIE_ROUTER_LUNA_SHADOW_PRODUCTION_DATA_APPROVED: 'true',
    ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS: CHANNEL_ID,
    ADDIE_ROUTER_LUNA_SHADOW_SAMPLE_BPS: '10000',
    ADDIE_ROUTER_LUNA_SHADOW_DAILY_LIMIT: '1',
    ADDIE_ROUTER_LUNA_SHADOW_DAILY_BUDGET_MICROS: String(
      ROUTER_SHADOW_RESERVED_COST_MICROS,
    ),
    ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY: 'integration-key-'.padEnd(32, 'x'),
    ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY_VERSION: KEY_VERSION,
    OPENAI_API_KEY: 'unused',
  };
}

function observation(): RouterModelObservation {
  const raw = '{"action":"ignore","reason":"not needed"}';
  const canonicalRequest = buildRouterModelRequest({
    message: 'integration private sentinel', source: 'channel',
  });
  return {
    canonicalRequest,
    primaryInvocation: {
      provider: 'anthropic', model: 'claude-haiku-4-5',
      capabilities: {
        streaming: false, structuredOutput: false, reasoning: false,
        reasoningEfforts: ['provider_default'], customTools: false,
        providerWebSearch: false, imageInput: false, documentInput: false,
      },
      providerRequest: Object.freeze({
        model: 'claude-haiku-4-5', messages: canonicalRequest.messages,
      }),
    },
    isAdmin: false,
    productionPlan: {
      action: 'ignore', reason: 'not needed', decision_method: 'llm',
    },
    rawResponseText: raw,
    responseContent: [{ type: 'text', text: raw }],
    finishReason: 'stop',
    primaryErrorCategory: null,
    requestedProvider: 'anthropic',
    requestedModel: 'claude-haiku-4-5',
    returnedProvider: 'anthropic',
    returnedModel: 'claude-haiku-4-5',
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    latencyMs: 5,
  };
}

function provider(): ModelProvider & { dispatches: number } {
  return {
    id: 'openai',
    dispatches: 0,
    capabilities: {
      streaming: false, structuredOutput: true, reasoning: true,
      reasoningEfforts: ['provider_default', 'none'], customTools: false,
      providerWebSearch: false, imageInput: false, documentInput: false,
    },
    prepare(request) {
      return {
        provider: 'openai', model: request.model, capabilities: this.capabilities,
        providerRequest: Object.freeze({ model: request.model, input: request.messages, tools: [] }),
      };
    },
    async *respond(
      request: ModelRequest,
      options?: ModelRespondOptions,
    ): AsyncIterable<NormalizedModelEvent> {
      await options?.beforeDispatch?.(this.prepare(request));
      this.dispatches++;
      const text = '{"action":"ignore","reason":"not needed"}';
      yield { type: 'response_start', provider: 'openai', model: request.model, id: 'id' };
      yield { type: 'text_delta', index: 0, text };
      yield {
        type: 'response_complete',
        response: {
          provider: 'openai', model: request.model, id: 'id',
          content: [{ type: 'text', text }], finishReason: 'stop',
          providerFinishReason: 'completed', usage: { inputTokens: 10, outputTokens: 4 },
        },
      };
    },
  };
}

describe('migration 558: Luna router shadow ledger', () => {
  let pool: Pool;
  let migrationReady = false;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL
        || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    migrationReady = true;
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM addie_router_shadow_attempts WHERE hash_key_version = $1',
      [KEY_VERSION],
    );
    await pool.query(
      'DELETE FROM addie_router_shadow_daily_admissions WHERE hash_key_version = $1',
      [KEY_VERSION],
    );
  });

  afterAll(async () => {
    if (pool && migrationReady) {
      await pool.query(
        'DELETE FROM addie_router_shadow_attempts WHERE hash_key_version = $1',
        [KEY_VERSION],
      );
      await pool.query(
        'DELETE FROM addie_router_shadow_daily_admissions WHERE hash_key_version = $1',
        [KEY_VERSION],
      );
    }
    await closeDatabase();
  });

  it('contains no production identity or raw-text columns', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'addie_router_shadow_attempts'`,
    );
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).toEqual(expect.arrayContaining([
      'source_binding_hmac', 'canonical_request_hmac', 'primary_output_hmac',
      'primary_provider_request_hmac',
      'provider_request_hmac', 'provider_output_hmac', 'completion_hmac',
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      'channel_id', 'thread_id', 'message_id', 'user_id', 'prompt', 'response',
    ]));
  });

  it('admits only one of two distinct concurrent opportunities at limit one', async () => {
    const first = provider();
    const second = provider();
    const results = await Promise.all([
      runRouterShadow({
        channelId: CHANNEL_ID, opportunityId: '1.000001', channelIsPublic: true,
        channelIsShared: false, observation: observation(),
      }, { env: env(), provider: first }),
      runRouterShadow({
        channelId: CHANNEL_ID, opportunityId: '1.000002', channelIsPublic: true,
        channelIsShared: false, observation: observation(),
      }, { env: env(), provider: second }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(['not_dispatched', 'succeeded']);
    expect(first.dispatches + second.dispatches).toBe(1);
    const counts = await pool.query<{ attempts: string; slots: string }>(
      `SELECT COUNT(*)::text AS attempts,
              COUNT(quota_slot)::text AS slots
       FROM addie_router_shadow_attempts WHERE hash_key_version = $1`,
      [KEY_VERSION],
    );
    expect(counts.rows[0]).toEqual({ attempts: '1', slots: '1' });
    const admissions = await pool.query<{
      sampled: string; claimed: string; duplicate: string; quota: string;
    }>(
      `SELECT SUM(sampled_count)::text AS sampled, SUM(claimed_count)::text AS claimed,
              SUM(duplicate_count)::text AS duplicate,
              SUM(quota_exhausted_count)::text AS quota
       FROM addie_router_shadow_daily_admissions WHERE hash_key_version = $1`,
      [KEY_VERSION],
    );
    expect(admissions.rows[0]).toEqual({
      sampled: '2', claimed: '1', duplicate: '0', quota: '1',
    });
  });

  it('deduplicates the same source under a concurrent race', async () => {
    const first = provider();
    const second = provider();
    const run = (selectedProvider: ModelProvider) => runRouterShadow({
      channelId: CHANNEL_ID, opportunityId: '2.000001', channelIsPublic: true,
      channelIsShared: false, observation: observation(),
    }, { env: env(), provider: selectedProvider });
    const results = await Promise.all([run(first), run(second)]);
    expect(results.map(({ status }) => status).sort()).toEqual(['duplicate', 'succeeded']);
    expect(first.dispatches + second.dispatches).toBe(1);
    const admissions = await pool.query<{
      sampled: string; claimed: string; duplicate: string; quota: string;
    }>(
      `SELECT SUM(sampled_count)::text AS sampled, SUM(claimed_count)::text AS claimed,
              SUM(duplicate_count)::text AS duplicate,
              SUM(quota_exhausted_count)::text AS quota
       FROM addie_router_shadow_daily_admissions WHERE hash_key_version = $1`,
      [KEY_VERSION],
    );
    expect(admissions.rows[0]).toEqual({
      sampled: '2', claimed: '1', duplicate: '1', quota: '0',
    });
  });
});
