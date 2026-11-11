import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { createTrainingAgentServer, invalidateCache, clearTaskStore } from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache, MUTATING_TOOLS } from '../../src/training-agent/idempotency.js';

// Drives the graded request of each retained get_products facade storyboard
// (#7403) through the training agent at every served legacy line.

type Server = ReturnType<typeof createTrainingAgentServer>;
type Product = Record<string, any>;

function load(name: string) {
  return YAML.parse(readFileSync(new URL(
    `../../../static/compliance/source/protocols/media-buy/scenarios/legacy_get_products_${name}.yaml`,
    import.meta.url,
  ), 'utf8'));
}

async function call(server: Server, name: string, args: Record<string, unknown>) {
  const handlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('Missing MCP tools/call handler');
  const response = await handler({ method: 'tools/call', params: { name, arguments: {
    ...(MUTATING_TOOLS.has(name) && { idempotency_key: randomUUID() }), ...args,
  } } }, {});
  const payload = response.structuredContent ?? JSON.parse(response.content[0].text);
  return payload.adcp_error ?? payload;
}

async function gradedResponse(name: string, version: string, override: Record<string, unknown> = {}) {
  const storyboard = load(name);
  const step = storyboard.phases[0].steps[0];
  const account = step.sample_request.account;
  const server = createTrainingAgentServer({ mode: 'open' });
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
  const response = await call(server, step.task, { ...step.sample_request, ...override, adcp_version: version });
  expect(response.code, JSON.stringify(response)).toBeUndefined();
  return response.products as Product[];
}

const ids = (products: Product[]) => products.map(product => product.product_id);

describe('retained get_products facade obligations on the training agent', () => {
  beforeEach(() => { clearSessions(); invalidateCache(); clearTaskStore(); clearIdempotencyCache(); });

  it.each(['3.0', '3.1', '3.2-rc.7'])('matches the full legacy format identity at %s', async version => {
    expect(ids(await gradedResponse('format_ids', version))).toEqual(['format_ids_z_matching']);
  });

  it('treats a declaration without a requested parameter as the template', async () => {
    const products = await gradedResponse('format_ids', '3.1', {
      filters: { format_ids: [{ agent_url: 'https://creative.acmeoutdoor.example', id: 'display_image' }] },
      pagination: { max_results: 10 },
    });
    expect(ids(products).sort()).toEqual(['format_ids_b_parameters', 'format_ids_z_matching']);
  });

  it.each(['3.0', '3.1', '3.2-rc.7'])('keeps preferred_delivery_types non-excluding at %s', async version => {
    expect(ids(await gradedResponse('preferred_delivery_types', version))).toContain('preferred_delivery_non_guaranteed');
  });

  it.each(['3.0', '3.1', '3.2-rc.7'])('returns the legacy-only fields member at %s', async version => {
    const product = (await gradedResponse('fields', version)).find(candidate => candidate.product_id === 'legacy_fields_measured');
    expect(product?.delivery_measurement).toEqual({ vendors: [{ domain: 'legacy-fields-measurement.example' }] });
  });

  it.each(['3.0', '3.1', '3.2-rc.7'])('applies all 26 refine entries at %s', async version => {
    expect(ids(await gradedResponse('refine_batch', version))).toEqual(
      Array.from({ length: 26 }, (_, i) => `refine_batch_${String(i + 1).padStart(2, '0')}`),
    );
  });
});
