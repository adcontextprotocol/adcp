import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE = '1';
  process.env.ADCP_TRAINING_CANDIDATE_VERSION = '3.3-beta.0';
});

import {
  clearTaskStore,
  executeTrainingAgentTool,
  invalidateCache,
} from '../../src/training-agent/task-handlers.js';
import {
  clearSessions,
  findSessionsMatching,
  flushDirtySessions,
  runWithSessionContext,
} from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open', principal: 'package-forecast-buyer' };
const ACCOUNT = { brand: { domain: 'nova-motors.example' }, operator: 'forecast-buyer', sandbox: true };
const HORIZON = { start_time: '2099-11-01T00:00:00Z', end_time: '2099-12-01T00:00:00Z' };
const PRODUCT_ID = 'streamhaus_forecast_product';

const call = (toolName: string, args: Record<string, unknown>) => runWithSessionContext(async () => {
  const result = await executeTrainingAgentTool(toolName, {
    adcp_version: '3.3-beta.0',
    idempotency_key: randomUUID(),
    account: ACCOUNT,
    ...args,
  }, CTX);
  await flushDirtySessions();
  return result;
});

const packageInput = () => ({
  pricing_option_id: 'fixture_default_cpm',
  budget: 25000,
  start_time: HORIZON.start_time,
  end_time: HORIZON.end_time,
  targeting_overlay: {},
});

describe('structured package forecasts on the reference training agent', () => {
  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    const seed = await call('comply_test_controller', {
      scenario: 'seed_product',
      params: {
        product_id: PRODUCT_ID,
        fixture: {
          delivery_type: 'guaranteed',
          channels: ['display'],
          availability: { min_bookable_days: 1, booked_windows: [] },
        },
      },
    });
    expect(seed).toMatchObject({ success: true, data: { success: true } });
  });

  it('reports unable and suppresses even a later horizon forecast without booking or reserving inventory', async () => {
    const discovery = await call('get_products', {
      buying_mode: 'wholesale',
      filters: { availability_horizon: HORIZON },
    });
    const baseline = (discovery.data as { products: Array<Record<string, unknown>> }).products
      .find(product => product.product_id === PRODUCT_ID);
    expect(baseline?.forecast).toMatchObject({ forecast_range_unit: 'availability' });

    const result = await call('get_products', {
      buying_mode: 'refine',
      filters: { availability_horizon: HORIZON },
      refine: [{ scope: 'product', product_id: PRODUCT_ID, package: packageInput() }],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      adcp_version: string;
      products: Array<Record<string, unknown>>;
      refinement_applied: Array<Record<string, unknown>>;
    };
    expect(data.adcp_version).toBe('3.3-beta.0');
    expect(data.refinement_applied).toEqual([{
      scope: 'product', product_id: PRODUCT_ID, status: 'unable', notes: expect.stringMatching(/\S/),
    }]);
    const returnedProduct = data.products.find(product => product.product_id === PRODUCT_ID);
    expect(returnedProduct).toMatchObject({ product_id: PRODUCT_ID });
    expect(returnedProduct).not.toHaveProperty('forecast');

    const sessions = await findSessionsMatching(() => true);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.mediaBuys.size).toBe(0);
      expect(session.creatives.size).toBe(0);
      expect(session.negotiatedPricingOptions.size).toBe(0);
      expect(session.lastGetProductsContext?.proposals?.some(proposal => proposal.proposal_status === 'committed')).not.toBe(true);
    }

    const ordinary = await call('get_products', {
      buying_mode: 'refine',
      filters: { availability_horizon: HORIZON },
      refine: [{ scope: 'product', product_id: PRODUCT_ID }],
    });
    expect((ordinary.data as { refinement_applied: Array<Record<string, unknown>> }).refinement_applied)
      .toEqual([{ scope: 'product', product_id: PRODUCT_ID, status: 'applied' }]);
    expect((ordinary.data as { products: Array<Record<string, unknown>> }).products
      .find(product => product.product_id === PRODUCT_ID)?.forecast)
      .toMatchObject({ forecast_range_unit: 'availability' });
  });

  it('keeps all outcomes aligned and does not reprice an unsupported package from its free-text ask', async () => {
    const result = await call('get_products', {
      buying_mode: 'refine',
      refine: [
        { scope: 'request', ask: 'Keep the selected product' },
        { scope: 'product', product_id: PRODUCT_ID, action: 'include', package: packageInput(), ask: 'Set the CPM to USD 5' },
      ],
    });
    expect(result.success).toBe(true);
    const data = result.data as { products: Array<Record<string, unknown>>; refinement_applied: Array<Record<string, unknown>> };
    expect(data.refinement_applied).toHaveLength(2);
    expect(data.refinement_applied[0]).toMatchObject({ scope: 'request' });
    expect(data.refinement_applied[1]).toMatchObject({ scope: 'product', product_id: PRODUCT_ID, status: 'unable' });
    const returnedProduct = data.products.find(product => product.product_id === PRODUCT_ID);
    expect(returnedProduct).toMatchObject({ product_id: PRODUCT_ID });
    expect(returnedProduct).not.toHaveProperty('forecast');
    for (const session of await findSessionsMatching(() => true)) {
      expect(session.negotiatedPricingOptions.size).toBe(0);
    }
  });

  it.each([
    { action: 'omit', package: packageInput() },
    { package: { ...packageInput(), budget: -1 } },
  ])('rejects an invalid structured package before treating it as ordinary refinement', async entry => {
    const result = await call('get_products', {
      buying_mode: 'refine',
      refine: [{ scope: 'product', product_id: PRODUCT_ID, ...entry }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid get_products_request/);
  });
});
