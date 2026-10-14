/**
 * The training agent as a reference seller for buyer property-list targeting:
 * declaration, SSRF guard, fetch + cache, include/exclude application, and
 * the reject-the-whole-buy failure modes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  createTrainingAgentServer,
  invalidateCache,
} from '../../src/training-agent/task-handlers.js';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import { PUBLISHERS } from '../../src/training-agent/publishers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import {
  listAgentUrlRejection,
  setPropertyListFetchTestOverride,
} from '../../src/training-agent/property-list-targeting.js';
import {
  STORYBOARD_LIST_AGENT_URL,
  STORYBOARD_PROPERTY_LISTS,
} from '../../src/training-agent/property-list-fixtures.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: 'https://buyer.example' };

/** Drive a tool through the MCP request handler, as the HTTP route does, so
 * session state persists across calls the way it does for a real buyer. */
async function callTool(
  ctx: TrainingContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const server = createTrainingAgentServer(ctx);
  const handler = ((server as any)._requestHandlers as Map<string, Function>).get('tools/call')!;
  const response = await handler({ method: 'tools/call', params: { name: toolName, arguments: args } }, {});
  const text = response.content?.[0]?.text;
  const parsed: Record<string, any> = response.structuredContent ?? (text ? JSON.parse(text) : {});
  // Surface the adcp_error envelope as an `errors` array like the body variant.
  if (parsed.adcp_error && !parsed.errors) return { ...parsed, errors: [parsed.adcp_error] };
  return parsed;
}
const LIST_AGENT_URL = 'https://lists.buyer-agency.example/mcp';

const MERIDIAN_DOMAINS = [
  'outdoormagazine.example',
  'hikingtrails.example',
  'campinggear.example',
  'mountaineering.example',
];

interface ListAgentCall {
  authorization: string | undefined;
  listId: string;
}

interface StubReply {
  /** Resolved identifiers, or omitted to answer with an AdCP error. */
  identifiers?: string[];
  cacheValidUntil?: string;
  errorCode?: string;
  httpStatus?: number;
}

/** A buyer's list agent: a real MCP server that records what it was asked. */
async function startListAgent(reply: (listId: string) => StubReply) {
  const calls: ListAgentCall[] = [];
  const httpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const server = new McpServer({ name: 'buyer-list-agent', version: '1.0.0' });
      server.registerTool('get_property_list', {
        inputSchema: { list_id: z.string(), resolve: z.boolean().optional(), pagination: z.any().optional() },
      }, async ({ list_id }) => {
        calls.push({ authorization: req.headers.authorization, listId: list_id });
        const r = reply(list_id);
        if (r.httpStatus) throw new Error('simulated upstream failure');
        const payload = r.identifiers
          ? {
            list: { list_id, name: 'Buyer list' },
            identifiers: r.identifiers.map(value => ({ type: 'domain', value })),
            pagination: { has_more: false },
            resolved_at: '2026-10-01T00:00:00.000Z',
            cache_valid_until: r.cacheValidUntil ?? new Date(Date.now() + 3_600_000).toISOString(),
          }
          : { errors: [{ code: r.errorCode ?? 'REFERENCE_NOT_FOUND', message: 'no such list' }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as { port: number };
  setPropertyListFetchTestOverride(LIST_AGENT_URL, {
    fetch: (_input, init) => fetch(`http://127.0.0.1:${port}/mcp`, init),
  });
  return {
    calls,
    close: async () => {
      setPropertyListFetchTestOverride(LIST_AGENT_URL, undefined);
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
}

function meridianProduct() {
  const product = buildCatalog().find(entry => entry.product.product_id === 'meridian_print_premium')!.product;
  return product as unknown as Record<string, unknown> & {
    product_id: string;
    pricing_options: Array<{ pricing_option_id: string }>;
  };
}

function singleBrandProduct() {
  // Pinnacle News sells three properties but does not let buyers subdivide them.
  const product = buildCatalog().find(entry => entry.publisherId === 'pinnacle_news')!.product;
  return product as unknown as Record<string, unknown> & {
    product_id: string;
    pricing_options: Array<{ pricing_option_id: string; pricing_model: string; fixed_price?: number; floor_price?: number }>;
  };
}

function newAccount() {
  return { brand: { domain: `list-targeting-${randomUUID().slice(0, 8)}.example` }, operator: 'pinnacle-agency.example' };
}

type Account = ReturnType<typeof newAccount>;

function packageFor(product: ReturnType<typeof meridianProduct>, targeting?: Record<string, unknown>) {
  const pricing = product.pricing_options.find(option => (option as { fixed_price?: number }).fixed_price !== undefined)
    ?? product.pricing_options[0]!;
  return {
    product_id: product.product_id,
    pricing_option_id: pricing.pricing_option_id,
    budget: 20_000,
    ...(targeting && { targeting_overlay: targeting }),
  };
}

async function createBuy(
  account: Account,
  product: ReturnType<typeof meridianProduct>,
  targeting?: Record<string, unknown>,
) {
  return await callTool(CTX, 'create_media_buy', {
    account,
    brand: account.brand,
    idempotency_key: `list-targeting-${randomUUID()}`,
    start_time: new Date(Date.now() + 86_400_000).toISOString(),
    end_time: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    packages: [packageFor(product, targeting)],
  });
}

function firstError(response: Record<string, any>): Record<string, any> {
  const error = response.errors?.[0] ?? response.adcp_error;
  expect(error, JSON.stringify(response)).toBeDefined();
  return error;
}

function effectiveIds(response: Record<string, any>, packageIndex = 0): string[] {
  const props = response.packages?.[packageIndex]?.ext?.training_agent?.effective_properties as
    Array<{ property_id: string }> | undefined;
  return (props ?? []).map(property => property.property_id).sort();
}

beforeEach(async () => {
  clearSessions();
  clearIdempotencyCache();
  clearAccountStore();
  invalidateCache();
});

afterEach(() => {
  setPropertyListFetchTestOverride(LIST_AGENT_URL, undefined);
});

describe('capability and product declarations', () => {
  it('declares both list dimensions seller-wide', async () => {
    const capabilities = await callTool(CTX, 'get_adcp_capabilities', { adcp_version: '3.2' });
    expect(capabilities.media_buy.execution.targeting.property_list).toBe(true);
    expect(capabilities.media_buy.execution.targeting.property_list_exclude).toBe(true);
  });

  it('makes Product.overlay_support authoritative: exclusion everywhere, inclusion only where selectable', () => {
    for (const { product } of buildCatalog()) {
      const record = product as unknown as Record<string, any>;
      expect(record.overlay_support.property_list_exclude, record.product_id).toBe(true);
      // The product schema ties overlay_support.property_list to the flag.
      if (record.overlay_support.property_list === true) {
        expect(record.property_targeting_allowed, record.product_id).toBe(true);
      }
    }
    const meridian = meridianProduct() as Record<string, any>;
    expect(meridian.overlay_support.property_list).toBe(true);
    expect(meridian.property_targeting_allowed).toBe(true);
    const pinnacle = singleBrandProduct() as Record<string, any>;
    expect(pinnacle.overlay_support.property_list).toBeUndefined();
    expect(pinnacle.property_targeting_allowed).toBeUndefined();
  });
});

describe('SSRF guard on the list agent URL', () => {
  it.each([
    'http://localhost:9999/mcp',
    'http://127.0.0.1:8080/mcp',
    'https://10.0.0.5/mcp',
    'https://192.168.1.10/mcp',
    'http://169.254.169.254/latest/meta-data',
    'https://[::1]/mcp',
    'https://metadata.internal/mcp',
    'https://user:secret@lists.buyer-agency.example/mcp',
  ])('rejects %s', url => {
    expect(listAgentUrlRejection(url)).toBeTypeOf('string');
  });

  it('allows public hosts, the storyboard list agent, and the training governance tenant', () => {
    expect(listAgentUrlRejection(LIST_AGENT_URL)).toBeUndefined();
    expect(listAgentUrlRejection(STORYBOARD_LIST_AGENT_URL)).toBeUndefined();
    expect(listAgentUrlRejection('https://test-agent.adcontextprotocol.org/governance/mcp')).toBeUndefined();
    expect(listAgentUrlRejection('https://test-agent.adcontextprotocol.org')).toBeUndefined();
  });

  it('rejects a private agent_url before any fetch happens', async () => {
    const agent = await startListAgent(() => ({ identifiers: MERIDIAN_DOMAINS }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list: { agent_url: 'http://127.0.0.1:9/mcp', list_id: 'pl_ssrf' },
      });
      const error = firstError(response);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.field).toBe('packages[0].targeting_overlay.property_list.agent_url');
      expect(agent.calls).toHaveLength(0);
      expect(response.media_buy_id).toBeUndefined();
    } finally {
      await agent.close();
    }
  });
});

describe('fetching and caching buyer lists', () => {
  it('fetches with Bearer auth only when a token is supplied, and caches until cache_valid_until', async () => {
    const agent = await startListAgent(() => ({ identifiers: MERIDIAN_DOMAINS.slice(0, 2) }));
    try {
      const account = newAccount();
      const targeting = {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_cached', auth_token: 'tok_buyer_secret' },
      };
      const first = await createBuy(account, meridianProduct(), targeting);
      expect(first.media_buy_id, JSON.stringify(first)).toBeDefined();
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0]!.authorization).toBe('Bearer tok_buyer_secret');

      const second = await createBuy(account, meridianProduct(), targeting);
      expect(second.media_buy_id).toBeDefined();
      expect(agent.calls).toHaveLength(1); // cache hit

      // A public list sends no Authorization header, and is cached separately
      // from the credentialed fetch of the same list_id.
      const publicTargeting = { property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_cached' } };
      const third = await createBuy(account, meridianProduct(), publicTargeting);
      expect(third.media_buy_id).toBeDefined();
      expect(agent.calls).toHaveLength(2);
      expect(agent.calls[1]!.authorization).toBeUndefined();

      // The credential never reaches the wire, in create or readback.
      const readback = await callTool(CTX, 'get_media_buys', { account, media_buy_ids: [first.media_buy_id] });
      expect(JSON.stringify([first, second, third, readback])).not.toContain('tok_buyer_secret');
    } finally {
      await agent.close();
    }
  });

  it('re-fetches once cache_valid_until has passed', async () => {
    const agent = await startListAgent(() => ({
      identifiers: MERIDIAN_DOMAINS.slice(0, 2),
      cacheValidUntil: new Date(Date.now() - 1000).toISOString(),
    }));
    try {
      const account = newAccount();
      const targeting = { property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_stale' } };
      await createBuy(account, meridianProduct(), targeting);
      await createBuy(account, meridianProduct(), targeting);
      expect(agent.calls).toHaveLength(2);
    } finally {
      await agent.close();
    }
  });
});

describe('applying lists to a package', () => {
  it('include: the package runs on the product properties intersected with the list', async () => {
    const agent = await startListAgent(() => ({
      identifiers: ['outdoormagazine.example', 'campinggear.example', 'unrelated.example'],
    }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_include' },
      });
      expect(response.media_buy_id, JSON.stringify(response)).toBeDefined();
      expect(effectiveIds(response)).toEqual(['meridian_camping_gear', 'meridian_outdoor_magazine']);
      const [receipt] = response.packages[0].ext.training_agent.list_applications;
      expect(receipt).toMatchObject({
        list_type: 'property',
        effect: 'include',
        agent_url: LIST_AGENT_URL,
        list_id: 'pl_include',
        resolved_at: '2026-10-01T00:00:00.000Z',
        summary: { matched: 2, unmatched: 1 },
      });
    } finally {
      await agent.close();
    }
  });

  it('include that matches nothing the product sells is PRODUCT_UNAVAILABLE', async () => {
    const agent = await startListAgent(() => ({ identifiers: ['never-sold-here.example'] }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_none' },
      });
      const error = firstError(response);
      expect(error.code).toBe('PRODUCT_UNAVAILABLE');
      expect(error.field).toBe('packages[0].targeting_overlay.property_list');
      expect(response.media_buy_id).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it('exclude: removes the listed properties from the package', async () => {
    const agent = await startListAgent(() => ({ identifiers: ['hikingtrails.example', 'magazines.meridianmedia.example'] }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list_exclude: { agent_url: LIST_AGENT_URL, list_id: 'pl_block' },
      });
      expect(response.media_buy_id, JSON.stringify(response)).toBeDefined();
      expect(effectiveIds(response)).toEqual([
        'meridian_camping_gear',
        'meridian_digital',
        'meridian_mountaineering',
        'meridian_outdoor_magazine',
      ]);
      expect(response.packages[0].ext.training_agent.list_applications[0]).toMatchObject({
        effect: 'exclude',
        summary: { matched: 2, unmatched: 0 },
      });
    } finally {
      await agent.close();
    }
  });

  it('exclude that empties the package is PRODUCT_UNAVAILABLE', async () => {
    const everything = PUBLISHERS.find(p => p.id === 'meridian_print')!.properties.map(p => p.identifierValue);
    const agent = await startListAgent(() => ({ identifiers: everything }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list_exclude: { agent_url: LIST_AGENT_URL, list_id: 'pl_all' },
      });
      const error = firstError(response);
      expect(error.code).toBe('PRODUCT_UNAVAILABLE');
      expect(error.field).toBe('packages[0].targeting_overlay.property_list_exclude');
      expect(response.media_buy_id).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it('exclude wins on overlap with include, and each receipt counts against the same baseline', async () => {
    const agent = await startListAgent(listId => ({
      identifiers: listId === 'pl_in'
        ? ['outdoormagazine.example', 'hikingtrails.example']
        : ['hikingtrails.example', 'campinggear.example'],
    }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_in' },
        property_list_exclude: { agent_url: LIST_AGENT_URL, list_id: 'pl_out' },
      });
      expect(response.media_buy_id, JSON.stringify(response)).toBeDefined();
      expect(effectiveIds(response)).toEqual(['meridian_outdoor_magazine']);
      const receipts = response.packages[0].ext.training_agent.list_applications as Array<Record<string, any>>;
      expect(receipts.map(receipt => receipt.effect)).toEqual(['include', 'exclude']);
      // Each receipt is counted against the full product inventory, not the
      // result of the other list.
      expect(receipts.map(receipt => receipt.summary)).toEqual([
        { matched: 2, unmatched: 0 },
        { matched: 2, unmatched: 0 },
      ]);
    } finally {
      await agent.close();
    }
  });

  it('property_targeting_allowed: false rejects include but still applies exclude', async () => {
    const agent = await startListAgent(() => ({ identifiers: ['pinnaclenews.example'] }));
    try {
      const account = newAccount();
      const rejected = await createBuy(account, singleBrandProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_fixed' },
      });
      const error = firstError(rejected);
      expect(error.code).toBe('UNSUPPORTED_FEATURE');
      expect(error.field).toBe('packages[0].targeting_overlay.property_list');
      expect(agent.calls).toHaveLength(0);

      const applied = await createBuy(account, singleBrandProduct(), {
        property_list_exclude: { agent_url: LIST_AGENT_URL, list_id: 'pl_fixed' },
      });
      expect(applied.media_buy_id, JSON.stringify(applied)).toBeDefined();
      expect(effectiveIds(applied)).toEqual(['pinnacle_app', 'pinnacle_ctv']);
    } finally {
      await agent.close();
    }
  });
});

describe('a list that cannot be fetched rejects the buy', () => {
  it('maps a missing list to REFERENCE_NOT_FOUND and creates nothing', async () => {
    const agent = await startListAgent(() => ({ errorCode: 'REFERENCE_NOT_FOUND' }));
    try {
      const account = newAccount();
      const before = await callTool(CTX, 'get_media_buys', { account });
      const response = await createBuy(account, meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_missing', auth_token: 'tok_x' },
      });
      const error = firstError(response);
      expect(error.code).toBe('REFERENCE_NOT_FOUND');
      expect(error.field).toBe('packages[0].targeting_overlay.property_list');
      expect(JSON.stringify(response)).not.toContain('tok_x');
      expect(response.media_buy_id).toBeUndefined();
      const readback = await callTool(CTX, 'get_media_buys', { account });
      expect(readback.media_buys).toHaveLength(before.media_buys.length);
    } finally {
      await agent.close();
    }
  });

  it('maps an unreachable or failing list agent to a transient SERVICE_UNAVAILABLE', async () => {
    const agent = await startListAgent(() => ({ httpStatus: 500 }));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list_exclude: { agent_url: LIST_AGENT_URL, list_id: 'pl_down' },
      });
      const error = firstError(response);
      expect(error.code).toBe('SERVICE_UNAVAILABLE');
      expect(error.recovery).toBe('transient');
      expect(response.media_buy_id).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it('never applies the satisfiable list when its sibling cannot be fetched', async () => {
    const agent = await startListAgent(listId => (
      listId === 'pl_ok' ? { identifiers: ['outdoormagazine.example'] } : { errorCode: 'REFERENCE_NOT_FOUND' }
    ));
    try {
      const response = await createBuy(newAccount(), meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_ok' },
        property_list_exclude: { agent_url: LIST_AGENT_URL, list_id: 'pl_gone' },
      });
      expect(firstError(response).code).toBe('REFERENCE_NOT_FOUND');
      expect(response.media_buy_id).toBeUndefined();
    } finally {
      await agent.close();
    }
  });
});

describe('update_media_buy', () => {
  it('re-resolves replacement targeting and recomputes the effective set', async () => {
    const agent = await startListAgent(listId => ({
      identifiers: listId === 'pl_v1' ? MERIDIAN_DOMAINS : MERIDIAN_DOMAINS.slice(0, 1),
    }));
    try {
      const account = newAccount();
      const created = await createBuy(account, meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_v1' },
      });
      expect(effectiveIds(created)).toHaveLength(4);
      const packageId = created.packages[0].package_id as string;

      const updated = await callTool(CTX, 'update_media_buy', {
        account,
        media_buy_id: created.media_buy_id,
        idempotency_key: `list-update-${randomUUID()}`,
        packages: [{
          package_id: packageId,
          targeting_overlay: { property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_v2' } },
        }],
      });
      expect(updated.errors, JSON.stringify(updated)).toBeUndefined();
      expect(effectiveIds({ packages: updated.affected_packages })).toEqual(['meridian_outdoor_magazine']);

      const readback = await callTool(CTX, 'get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
      expect(effectiveIds({ packages: readback.media_buys[0].packages })).toEqual(['meridian_outdoor_magazine']);
    } finally {
      await agent.close();
    }
  });

  it('drops the effective set when replacement targeting carries no list', async () => {
    const agent = await startListAgent(() => ({ identifiers: MERIDIAN_DOMAINS }));
    try {
      const account = newAccount();
      const created = await createBuy(account, meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_v1' },
      });
      const updated = await callTool(CTX, 'update_media_buy', {
        account,
        media_buy_id: created.media_buy_id,
        idempotency_key: `list-update-${randomUUID()}`,
        packages: [{ package_id: created.packages[0].package_id, targeting_overlay: { geo_countries: ['US'] } }],
      });
      expect(updated.errors, JSON.stringify(updated)).toBeUndefined();
      expect(effectiveIds({ packages: updated.affected_packages })).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  it('rejects the whole update when the new list cannot be fetched, leaving the buy untouched', async () => {
    const agent = await startListAgent(listId => (
      listId === 'pl_v1' ? { identifiers: MERIDIAN_DOMAINS } : { errorCode: 'REFERENCE_NOT_FOUND' }
    ));
    try {
      const account = newAccount();
      const created = await createBuy(account, meridianProduct(), {
        property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_v1' },
      });
      const packageId = created.packages[0].package_id as string;

      const updated = await callTool(CTX, 'update_media_buy', {
        account,
        media_buy_id: created.media_buy_id,
        idempotency_key: `list-update-${randomUUID()}`,
        packages: [{
          package_id: packageId,
          targeting_overlay: { property_list: { agent_url: LIST_AGENT_URL, list_id: 'pl_gone' } },
        }],
      });
      expect(firstError(updated).code).toBe('REFERENCE_NOT_FOUND');
      expect(firstError(updated).field).toBe(`packages[${packageId}].targeting_overlay.property_list`);

      const readback = await callTool(CTX, 'get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
      const pkg = readback.media_buys[0].packages[0];
      expect(pkg.targeting_overlay.property_list.list_id).toBe('pl_v1');
      expect(effectiveIds({ packages: [pkg] })).toHaveLength(4);
    } finally {
      await agent.close();
    }
  });
});

describe("this deployment's own governance tenant", () => {
  it('resolves a list created through create_property_list in process, with no outbound fetch', async () => {
    const account = newAccount();
    const created = await callTool({ ...CTX, tenantId: 'governance' }, 'create_property_list', {
      account,
      name: 'Outdoor allowlist',
      base_properties: [{ domain: 'outdoormagazine.example' }, { domain: 'hikingtrails.example' }],
      idempotency_key: `create-list-${randomUUID()}`,
    }) as { list: { list_id: string } };
    const response = await createBuy(account, meridianProduct(), {
      property_list: {
        agent_url: 'https://test-agent.adcontextprotocol.org/governance/mcp',
        list_id: created.list.list_id,
      },
    });
    expect(response.media_buy_id, JSON.stringify(response)).toBeDefined();
    expect(effectiveIds(response)).toEqual(['meridian_hiking_trails', 'meridian_outdoor_magazine']);
  });

  it('reports an unknown list on the governance tenant as REFERENCE_NOT_FOUND', async () => {
    const response = await createBuy(newAccount(), meridianProduct(), {
      property_list: {
        agent_url: 'https://test-agent.adcontextprotocol.org/governance/mcp',
        list_id: 'pl_does_not_exist',
      },
    });
    expect(firstError(response).code).toBe('REFERENCE_NOT_FOUND');
  });
});

describe('storyboard fixture lists', () => {
  it('mirror inventory_targets in the acme-outdoor test kit', () => {
    const kit = YAML.parse(readFileSync(
      new URL('../../../static/compliance/source/test-kits/acme-outdoor.yaml', import.meta.url),
      'utf8',
    )) as { inventory_targets: Record<string, { agent_url: string; list_id: string; expected_identifiers?: Array<{ type: string; value: string }> }> };
    const propertyLists = Object.values(kit.inventory_targets).filter(entry => entry.expected_identifiers);
    expect(propertyLists.length).toBeGreaterThan(0);
    for (const list of propertyLists) {
      expect(list.agent_url).toBe(STORYBOARD_LIST_AGENT_URL);
      expect(STORYBOARD_PROPERTY_LISTS.get(list.list_id), list.list_id).toEqual(list.expected_identifiers);
    }
    expect(STORYBOARD_PROPERTY_LISTS.size).toBe(propertyLists.length);
  });
});
