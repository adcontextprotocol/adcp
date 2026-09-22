import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { createTrainingAgentServer, invalidateCache, clearTaskStore } from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache, MUTATING_TOOLS } from '../../src/training-agent/idempotency.js';

const storyboard = YAML.parse(readFileSync(new URL(
  '../../../static/compliance/source/protocols/media-buy/scenarios/product_coverage_filters.yaml',
  import.meta.url,
), 'utf8'));
const account = storyboard.phases[0].steps[0].sample_request.account;
type Server = ReturnType<typeof createTrainingAgentServer>;
async function call(server: Server, name: string, args: Record<string, unknown>) {
  const handlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('Missing MCP tools/call handler');
  const response = await handler({ method: 'tools/call', params: { name, arguments: {
    ...(MUTATING_TOOLS.has(name) && { idempotency_key: randomUUID() }), ...args,
  } } }, {});
  const payload = response.structuredContent ?? JSON.parse(response.content[0].text);
  return payload.adcp_error ?? payload.errors?.[0] ?? payload;
}
async function seed(server: Server) {
  for (const { product_id, ...fixture } of storyboard.fixtures.products) {
    expect(await call(server, 'comply_test_controller', {
      account, scenario: 'seed_product', params: { product_id, fixture },
    })).toMatchObject({ success: true });
  }
  for (const { product_id, pricing_option_id, ...fixture } of storyboard.fixtures.pricing_options) {
    expect(await call(server, 'comply_test_controller', {
      account, scenario: 'seed_pricing_option', params: { product_id, pricing_option_id, fixture },
    })).toMatchObject({ success: true });
  }
}
function atPath(value: unknown, path: string): unknown {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce<unknown>((current, key) =>
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}

describe('product coverage across retained and compact discovery', () => {
  beforeEach(() => { clearSessions(); invalidateCache(); clearTaskStore(); clearIdempotencyCache(); });

  it.each(['3.0', '3.1', '3.2-rc.3'])('preserves the graded legacy query at %s', async version => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const step = storyboard.phases[0].steps[0];
    const response = await call(server, step.task, { ...step.sample_request, adcp_version: version });
    expect(response.code, JSON.stringify(response)).toBeUndefined();
    for (const validation of step.validations) {
      if (validation.check === 'field_value') expect(atPath(response, validation.path)).toEqual(validation.value);
      if (validation.check === 'field_absent') expect(atPath(response, validation.path)).toBeUndefined();
    }
  });

  it('runs the compact storyboard through real SDK server dispatch', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const step = storyboard.phases[1].steps[0];
    const response = await call(server, step.task, { ...step.sample_request, adcp_version: '3.2-rc.3' });
    expect(response.code, JSON.stringify(response)).toBeUndefined();
    for (const validation of step.validations) {
      if (validation.check === 'field_value') expect(atPath(response, validation.path)).toEqual(validation.value);
      if (validation.check === 'field_absent') expect(atPath(response, validation.path)).toBeUndefined();
    }
  });

  it('applies Canadian coverage and US delivery independently', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const response = await call(server, 'get_products', {
      ...storyboard.phases[0].steps[0].sample_request,
      adcp_version: '3.2-rc.3',
      targeting_overlay: { geo_countries: ['US'] },
    });
    expect(response.code, JSON.stringify(response)).toBeUndefined();
    expect(response.products).toHaveLength(1);
    expect(response.products[0].is_custom).toBe(true);
    expect(response.products[0].pricing_options[0].fixed_price).toBe(10);
  });

  it('distinguishes no matches from unsupported coverage evaluation', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const base = { account, buying_mode: 'wholesale', adcp_version: '3.2-rc.3' };
    const empty = await call(server, 'get_products', {
      ...base, filters: { pricing_currencies: ['USD'], countries: ['GB'] },
    });
    expect(empty.code, JSON.stringify(empty)).toBeUndefined();
    expect(empty.products).toEqual([]);
    const unsupported = await call(server, 'get_products', {
      ...base, filters: { pricing_currencies: ['USD'], regions: ['US-NY'] },
    });
    expect(unsupported).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: '/filters/regions' });
  });
});
