import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';

// list_products returns the closed core/canonical-product.json shape. The
// default catalog is built as legacy Products, so the unprojected listing must
// not carry legacy-only keys (audience_activation, collections, installments,
// collection_targeting_allowed, and
// reporting_capabilities.reporting_delivery_offering_ids) that get_products
// still returns.

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };

type Product = Record<string, unknown> & { product_id: string };

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call')!;
  const response = await handler(
    {
      method: 'tools/call',
      params: { name: toolName, arguments: { adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION, ...args } },
    },
    {},
  );
  const text = response.content?.[0]?.text;
  return response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
}

async function listAllProducts(
  server: ReturnType<typeof createTrainingAgentServer>,
  args: Record<string, unknown> = {},
): Promise<Product[]> {
  const products: Product[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await callTool(server, 'list_products', {
      account: ACCOUNT,
      max_results: 10,
      ...args,
      ...(cursor && { cursor }),
    });
    expect(result.outcome, JSON.stringify(result).slice(0, 500)).toBe('listed');
    products.push(...(result.products as Product[]));
    cursor = typeof result.next_cursor === 'string' ? result.next_cursor : undefined;
    if (!cursor) return products;
  }
  throw new Error('list_products did not finish paginating');
}

function canonicalViolations(products: Product[]): string[] {
  return products.flatMap(product => {
    const validation = validateSourceSchema('core/canonical-product.json', product);
    return validation.valid
      ? []
      : validation.errors.map(error => `${product.product_id}${error.instancePath} ${error.message} ${JSON.stringify(error.params)}`);
  });
}

describe('list_products canonical product projection', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  it('returns every default-catalog product in the closed canonical shape without a fields projection', async () => {
    const products = await listAllProducts(server);
    expect(products.length).toBeGreaterThan(1);
    expect(canonicalViolations(products)).toEqual([]);
  });

  it('leaves the legacy get_products representation carrying its legacy-only keys', async () => {
    const result = await callTool(server, 'get_products', { account: ACCOUNT, buying_mode: 'wholesale' });
    const products = result.products as Product[];
    expect(products.length).toBeGreaterThan(1);
    expect(products.every(product => product.audience_activation !== undefined)).toBe(true);
    expect(products.some(product => Array.isArray(product.collections))).toBe(true);
    expect(products.some(product => Array.isArray(product.installments))).toBe(true);
    expect(products.some(product => product.collection_targeting_allowed === true)).toBe(true);
    expect(products.every(product => Array.isArray(
      (product.reporting_capabilities as Record<string, unknown> | undefined)?.reporting_delivery_offering_ids,
    ))).toBe(true);
  });
});
