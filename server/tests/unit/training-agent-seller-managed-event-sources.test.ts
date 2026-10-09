import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import {
  clearCatalogEventStores,
  SELLER_MANAGED_PURCHASE_SOURCE_ID,
} from '../../src/training-agent/catalog-event-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

// Seller-managed event sources: the always-on sources sync_event_sources
// lists with managed_by: "seller" alongside the buyer's synced sources.

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'nova-brands.example' }, operator: 'pinnacle-media.example', sandbox: true };
const OTHER_ACCOUNT = { brand: { domain: 'acme-corp.example' }, operator: 'pinnacle-media.example', sandbox: true };

type EventSourceResult = Record<string, unknown> & { event_source_id: string; managed_by?: string; action: string };

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
  const errorInBody = Array.isArray(parsed.errors) && parsed.errors.length > 0 ? parsed.errors[0] as Record<string, unknown> : undefined;
  return (parsed.adcp_error as Record<string, unknown> | undefined) ?? errorInBody ?? parsed;
}

async function discover(
  server: ReturnType<typeof createTrainingAgentServer>,
  account: Record<string, unknown> = ACCOUNT,
): Promise<EventSourceResult[]> {
  const result = await callTool(server, 'sync_event_sources', { account });
  expect(Array.isArray(result.event_sources), JSON.stringify(result)).toBe(true);
  return result.event_sources as EventSourceResult[];
}

describe('seller-managed event sources (training agent)', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    clearCatalogEventStores();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  it('lists the seller-managed purchase attribution source in discovery with managed_by: "seller"', async () => {
    const sources = await discover(server);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID,
      managed_by: 'seller',
      event_types: ['purchase'],
      action: 'unchanged',
      setup: { snippet_type: 'server_only' },
    });
    expect(typeof sources[0]!.seller_id).toBe('string');
  });

  it('lists buyer-synced sources before seller-managed ones, on discovery and on upsert', async () => {
    const synced = await callTool(server, 'sync_event_sources', {
      account: ACCOUNT,
      event_sources: [{ event_source_id: 'nova_web_pixel', name: 'Nova web pixel', event_types: ['purchase'] }],
    });
    const upserted = synced.event_sources as EventSourceResult[];
    // Buyer results keep their request positions; the account's
    // seller-managed sources follow them.
    expect(upserted.map(source => [source.event_source_id, source.managed_by, source.action])).toEqual([
      ['nova_web_pixel', 'buyer', 'created'],
      [SELLER_MANAGED_PURCHASE_SOURCE_ID, 'seller', 'unchanged'],
    ]);

    const discovered = await discover(server);
    expect(discovered.map(source => [source.event_source_id, source.managed_by])).toEqual([
      ['nova_web_pixel', 'buyer'],
      [SELLER_MANAGED_PURCHASE_SOURCE_ID, 'seller'],
    ]);
  });

  it('gives each account its own seller-managed instance and never lists another account\'s buyer sources', async () => {
    await callTool(server, 'sync_event_sources', {
      account: OTHER_ACCOUNT,
      event_sources: [{ event_source_id: 'acme_web_pixel', name: 'Acme web pixel', event_types: ['purchase'] }],
    });

    const mine = await discover(server, ACCOUNT);
    const theirs = await discover(server, OTHER_ACCOUNT);

    expect(mine.map(source => source.event_source_id)).toEqual([SELLER_MANAGED_PURCHASE_SOURCE_ID]);
    expect(theirs.map(source => source.event_source_id)).toEqual(['acme_web_pixel', SELLER_MANAGED_PURCHASE_SOURCE_ID]);
    const mineSellerId = mine[0]!.seller_id;
    const theirsSellerId = theirs.find(source => source.managed_by === 'seller')!.seller_id;
    expect(mineSellerId).not.toBe(theirsSellerId);
    // Deterministic per account.
    expect((await discover(server, ACCOUNT))[0]!.seller_id).toBe(mineSellerId);
  });

  it('refuses a buyer upsert of a seller-managed source id and leaves the source seller-managed', async () => {
    const synced = await callTool(server, 'sync_event_sources', {
      account: ACCOUNT,
      event_sources: [
        { event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID, name: 'Hijack', event_types: ['lead'] },
        { event_source_id: 'nova_web_pixel', name: 'Nova web pixel', event_types: ['purchase'] },
      ],
    });
    const results = synced.event_sources as EventSourceResult[];

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID, action: 'failed' });
    expect((results[0]!.errors as Array<Record<string, unknown>>)[0]).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(results[1]).toMatchObject({ event_source_id: 'nova_web_pixel', action: 'created' });

    const seller = (await discover(server)).find(source => source.event_source_id === SELLER_MANAGED_PURCHASE_SOURCE_ID);
    expect(seller).toMatchObject({ managed_by: 'seller', event_types: ['purchase'] });
  });

  it('rejects buyer log_event against a seller-managed source and accepts it on a buyer source', async () => {
    const events = [{
      event_id: 'evt_nova_1',
      event_type: 'purchase',
      event_time: '2027-01-15T14:30:00Z',
      action_source: 'website',
      user_match: { hashed_email: 'a'.repeat(64) },
    }];

    const rejected = await callTool(server, 'log_event', {
      account: ACCOUNT,
      event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID,
      events,
    });
    expect(rejected.code).toBe('INVALID_REQUEST');
    expect(rejected.field).toBe('event_source_id');
    expect(rejected.events_received).toBeUndefined();

    await callTool(server, 'sync_event_sources', {
      account: ACCOUNT,
      event_sources: [{ event_source_id: 'nova_web_pixel', name: 'Nova web pixel', event_types: ['purchase'] }],
    });
    const accepted = await callTool(server, 'log_event', {
      account: ACCOUNT,
      event_source_id: 'nova_web_pixel',
      events,
    });
    expect(accepted.events_received).toBe(1);
    expect(accepted.events_processed).toBe(1);
  });
});
