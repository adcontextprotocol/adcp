import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'outcome-target.example.com' }, operator: 'outcome-tester', sandbox: true };
const OUTCOME_TARGET_PRODUCT_ID = 'outcome_target_test_product';

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `test-${crypto.randomUUID()}` };
}

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  return (parsed.adcp_error as Record<string, unknown> | undefined) ?? parsed;
}

async function seedOutcomeTargetProduct(
  server: ReturnType<typeof createTrainingAgentServer>,
): Promise<void> {
  const seed = await callTool(server, 'comply_test_controller', {
    scenario: 'seed_product',
    account: ACCOUNT,
    params: {
      product_id: OUTCOME_TARGET_PRODUCT_ID,
      fixture: {
        delivery_type: 'non_guaranteed',
        channels: ['display'],
        pricing_options: [{
          pricing_option_id: 'po_outcome_target_fixed_cpm',
          pricing_model: 'cpm',
          currency: 'USD',
          fixed_price: 40,
        }],
      },
    },
  });
  expect(seed.success).toBe(true);
}

function requestProposalsArgs(outcomeTarget?: Record<string, unknown>): Record<string, unknown> {
  return {
    account: ACCOUNT,
    brief: 'Reverse-forecast planning test',
    criteria: {
      product_ids: [OUTCOME_TARGET_PRODUCT_ID],
      ...(outcomeTarget && { outcome_target: outcomeTarget }),
    },
  };
}

describe('reverse-forecast outcome_target planning (training agent)', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('get_adcp_capabilities', () => {
    it('declares media_buy.outcome_target: true', async () => {
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      expect((caps as { media_buy: { outcome_target?: boolean } }).media_buy.outcome_target).toBe(true);
    });
  });

  describe('clicks metric goal', () => {
    it('solves budget and a 3-point clicks forecast from volume 10000 on a fixed_price 40 product', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'metric', metric: 'clicks' },
        volume: 10000,
      }));

      expect(result.outcome).toBe('proposed');
      const proposals = result.proposals as Array<Record<string, unknown>>;
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0]!;

      // impressions = 10000 / 0.001 = 10,000,000; B = 10,000,000/1000 * 40 = 400,000
      expect(proposal.total_budget_guidance).toEqual({
        min: 320000,
        recommended: 400000,
        max: 500000,
        currency: 'USD',
      });

      const forecast = proposal.forecast as Record<string, unknown>;
      expect(forecast.forecast_range_unit).toBe('clicks');
      expect(forecast.method).toBe('modeled');
      expect(forecast.currency).toBe('USD');
      expect(typeof forecast.generated_at).toBe('string');
      expect(typeof forecast.valid_until).toBe('string');

      const points = forecast.points as Array<Record<string, unknown>>;
      expect(points).toHaveLength(3);
      expect(points[0]).toEqual({ budget: 200000, metrics: { clicks: { mid: 5000 } } });
      expect(points[1]).toEqual({ budget: 400000, metrics: { clicks: { mid: 10000 } } });
      expect(points[2]).toEqual({ budget: 600000, metrics: { clicks: { mid: 15000 } } });
    });
  });

  describe('event goal', () => {
    it('solves a conversions forecast carrying the event_type as the metrics key', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'purchase' },
        volume: 500,
      }));

      expect(result.outcome).toBe('proposed');
      const proposals = result.proposals as Array<Record<string, unknown>>;
      const proposal = proposals[0]!;

      const guidance = proposal.total_budget_guidance as Record<string, unknown>;
      expect(guidance.currency).toBe('USD');
      expect(typeof guidance.recommended).toBe('number');

      const forecast = proposal.forecast as Record<string, unknown>;
      expect(forecast.forecast_range_unit).toBe('conversions');
      const points = forecast.points as Array<Record<string, unknown>>;
      expect(points).toHaveLength(3);
      const midPoint = points[1] as { metrics: Record<string, { mid: number }> };
      expect(midPoint.metrics.purchase.mid).toBe(500);
    });
  });

  describe('unplannable spend goal', () => {
    it('rejects a metric:"spend" goal with INVALID_REQUEST naming criteria.outcome_target.goal', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'metric', metric: 'spend' },
        volume: 1000,
      }));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.goal');
      expect(result.proposals).toBeUndefined();
    });
  });

  describe('no outcome_target', () => {
    it('leaves proposals without total_budget_guidance or an outcome_target-shaped forecast', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs());

      expect(result.outcome).toBe('proposed');
      const proposals = result.proposals as Array<Record<string, unknown>>;
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.total_budget_guidance).toBeUndefined();
    });
  });
});
