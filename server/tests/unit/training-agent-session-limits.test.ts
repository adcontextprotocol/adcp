import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import {
  clearSessions,
  findSessionsMatching,
  flushDirtySessions,
  getSession,
  MAX_CONTENT_STANDARDS_PER_SESSION,
  MAX_CREATIVES_PER_SESSION,
  MAX_MEDIA_BUYS_PER_SESSION,
  MAX_PROPERTY_LISTS_PER_SESSION,
  MAX_USAGE_RECORDS_PER_SESSION,
  runWithSessionContext,
  sessionKeyFromArgs,
} from '../../src/training-agent/state.js';
import { createTrainingAgentServer, invalidateCache, MAX_PACKAGES_PER_BUY } from '../../src/training-agent/task-handlers.js';
import { MAX_PROPERTIES_PER_LIST } from '../../src/training-agent/property-handlers.js';
import { clearIdempotencyCache, MUTATING_TOOLS } from '../../src/training-agent/idempotency.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import type {
  AccountRef,
  MediaBuyState,
  SessionState,
  TrainingContext,
} from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: 'https://buyer.example' };
const TEST_AGENT_URL = 'http://localhost:3000/api/training-agent';
const DAY_MS = 24 * 60 * 60 * 1000;
const FLIGHT_START_DAYS_AHEAD = 30;
const FLIGHT_END_DAYS_AHEAD = 60;
const PACKAGE_BUDGET = 50_000;
const FULL_MEDIA_BUY_LIMIT_DETAILS = { limit: MAX_MEDIA_BUYS_PER_SESSION, current: MAX_MEDIA_BUYS_PER_SESSION };
const HIGHEST_STORED_PACKAGE_INDEX = 500;
const CREATIVES_OVER_LIMIT = MAX_CREATIVES_PER_SESSION + 1;
const USAGE_RECORDS_NEARLY_FULL = MAX_USAGE_RECORDS_PER_SESSION - 1;
const LIVE_STATUSES = ['pending_creatives', 'pending_start', 'active', 'paused'];
const USAGE_PERIOD = { start: '2026-03-01T00:00:00Z', end: '2026-03-31T23:59:59Z' };
const DISPLAY_FORMAT_ID = { agent_url: TEST_AGENT_URL, id: 'display_300x250' };
const BUDGET_SIMULATION = {
  spendPercentage: 10,
  computedSpend: { amount: 5_000, currency: 'USD' },
  budget: { amount: PACKAGE_BUDGET, currency: 'USD' },
};
const PUBLIC_TOKEN = 'test-session-limits-token';
const PUBLIC_ADCP_VERSION = '3.1';
const ROUTER_SETUP_TIMEOUT_MS = 60_000;
const PUBLIC_ACCOUNT = {
  brand: { domain: 'limit-public.example' },
  operator: 'pinnacle-agency.example',
  sandbox: true,
};

// The router module reads the public API key once, when it is first imported.
process.env.PUBLIC_TEST_AGENT_TOKEN = PUBLIC_TOKEN;

interface ToolResponse {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ text?: string }>;
}

type ToolCallHandler = (request: unknown, extra: unknown) => Promise<ToolResponse>;

/** Call a tool on the legacy MCP server and unwrap either error surface. */
async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const server = createTrainingAgentServer(DEFAULT_CTX);
  const handlers = (server as unknown as { _requestHandlers: Map<string, ToolCallHandler> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const withKey = MUTATING_TOOLS.has(toolName) && args.idempotency_key === undefined
    ? { ...args, idempotency_key: `test-${randomUUID()}` }
    : args;
  const response = await handler({ method: 'tools/call', params: { name: toolName, arguments: withKey } }, {});
  const text = response.content?.[0]?.text;
  const parsed = response.structuredContent ?? (text ? JSON.parse(text) as Record<string, unknown> : {});
  const errorInBody = Array.isArray(parsed.errors) && parsed.errors.length > 0
    ? parsed.errors[0] as Record<string, unknown>
    : undefined;
  return { result: (parsed.adcp_error as Record<string, unknown> | undefined) ?? errorInBody ?? parsed, isError: response.isError };
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function testAccount(label: string): AccountRef {
  const domain = `${label}.example`;
  return { brand: { domain }, operator: domain };
}

function storedMediaBuy(account: AccountRef, mediaBuyId: string, overrides: Partial<MediaBuyState> = {}): MediaBuyState {
  const now = new Date().toISOString();
  return {
    mediaBuyId,
    accountRef: account,
    status: 'active',
    currency: 'USD',
    packages: [],
    startTime: isoDaysFromNow(FLIGHT_START_DAYS_AHEAD),
    endTime: isoDaysFromNow(FLIGHT_END_DAYS_AHEAD),
    revision: 1,
    confirmedAt: now,
    createdAt: now,
    updatedAt: now,
    history: [],
    ...overrides,
  };
}

/** Mutate the account's stored session directly and persist it. */
async function editSession(account: AccountRef, edit: (session: SessionState) => void): Promise<void> {
  await runWithSessionContext(async () => {
    edit(await getSession(sessionKeyFromArgs({ account }, 'open')));
    await flushDirtySessions();
  });
}

async function readSession(account: AccountRef): Promise<SessionState> {
  return runWithSessionContext(() => getSession(sessionKeyFromArgs({ account }, 'open')));
}

function fillWithLiveBuys(session: SessionState, account: AccountRef, count: number): void {
  for (let index = 0; index < count; index++) {
    const mediaBuyId = `mb_live_${index}`;
    session.mediaBuys.set(mediaBuyId, storedMediaBuy(account, mediaBuyId));
  }
}

function storeUsageRecords(session: SessionState, account: AccountRef, count: number): void {
  const reportedAt = new Date().toISOString();
  for (let index = 0; index < count; index++) {
    session.usageRecords.push({ account, vendorCost: 1, currency: 'USD', reportedAt });
  }
}

function usageRecord(account: AccountRef): Record<string, unknown> {
  return { account, vendor_cost: 1, currency: 'USD' };
}

function createMediaBuyArgs(account: AccountRef, packageCount = 1): Record<string, unknown> {
  const product = buildCatalog()[0].product;
  const pricingOptionId = (product.pricing_options as Array<{ pricing_option_id: string }>)[0].pricing_option_id;
  return {
    account,
    brand: account.brand,
    start_time: isoDaysFromNow(FLIGHT_START_DAYS_AHEAD),
    end_time: isoDaysFromNow(FLIGHT_END_DAYS_AHEAD),
    packages: Array.from({ length: packageCount }, () => ({
      product_id: product.product_id,
      pricing_option_id: pricingOptionId,
      budget: PACKAGE_BUDGET,
    })),
  };
}

beforeEach(async () => {
  invalidateCache();
  await clearSessions();
});

afterEach(async () => {
  await clearSessions();
});

describe('media buy session limit', () => {
  it('refuses with INVALID_STATE and names the recovery path when every stored buy is live', async () => {
    const account = testAccount('limit-live');
    await editSession(account, session => fillWithLiveBuys(session, account, MAX_MEDIA_BUYS_PER_SESSION));

    const { result, isError } = await callTool('create_media_buy', createMediaBuyArgs(account));

    expect(isError).toBe(true);
    expect(result).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'correctable',
      details: FULL_MEDIA_BUY_LIMIT_DETAILS,
    });
    expect(result.message).toContain('canceled: true');
    expect((await readSession(account)).mediaBuys.size).toBe(MAX_MEDIA_BUYS_PER_SESSION);
  });

  it('evicts terminal buys least recently updated first, then refuses once every buy is live', async () => {
    const account = testAccount('limit-terminal');
    const terminalBuys = [
      storedMediaBuy(account, 'mb_canceled', { canceledAt: isoDaysFromNow(-2), updatedAt: isoDaysFromNow(-2) }),
      storedMediaBuy(account, 'mb_rejected', { status: 'rejected', updatedAt: isoDaysFromNow(-3) }),
      // Stored as active, but its flight ended: get_media_buys reports it completed.
      storedMediaBuy(account, 'mb_flight_ended', {
        startTime: isoDaysFromNow(-FLIGHT_START_DAYS_AHEAD),
        endTime: isoDaysFromNow(-1),
        updatedAt: isoDaysFromNow(-4),
      }),
      // Inserted last but updated longest ago, and holds the highest package id.
      storedMediaBuy(account, 'mb_completed', {
        status: 'completed',
        updatedAt: isoDaysFromNow(-5),
        packages: [{
          packageId: `pkg-${HIGHEST_STORED_PACKAGE_INDEX}`,
          productId: 'retired_product',
          pricingOptionId: 'retired_pricing',
          budget: PACKAGE_BUDGET,
          paused: false,
          startTime: isoDaysFromNow(-FLIGHT_END_DAYS_AHEAD),
          endTime: isoDaysFromNow(-FLIGHT_START_DAYS_AHEAD),
          creativeAssignments: [],
        }],
      }),
    ];
    await editSession(account, session => {
      fillWithLiveBuys(session, account, MAX_MEDIA_BUYS_PER_SESSION - terminalBuys.length);
      for (const buy of terminalBuys) session.mediaBuys.set(buy.mediaBuyId, buy);
      session.complyExtensions.budgetSimulations.set('mb_completed', structuredClone(BUDGET_SIMULATION));
      session.complyExtensions.budgetSimulations.set('mb_rejected', structuredClone(BUDGET_SIMULATION));
    });

    const first = await callTool('create_media_buy', createMediaBuyArgs(account));
    expect(first.isError, JSON.stringify(first.result)).not.toBe(true);
    const firstPackages = first.result.packages as Array<{ package_id: string }>;
    expect(firstPackages[0].package_id).toBe(`pkg-${HIGHEST_STORED_PACKAGE_INDEX + 1}`);
    let session = await readSession(account);
    expect(session.mediaBuys.size).toBe(MAX_MEDIA_BUYS_PER_SESSION);
    expect(session.mediaBuys.has(first.result.media_buy_id as string)).toBe(true);
    expect(session.mediaBuys.has('mb_completed')).toBe(false);
    expect(session.complyExtensions.budgetSimulations.has('mb_completed')).toBe(false);
    expect(session.complyExtensions.budgetSimulations.has('mb_rejected')).toBe(true);

    const evictionOrder = ['mb_flight_ended', 'mb_rejected', 'mb_canceled'];
    for (const expectedEviction of evictionOrder) {
      const created = await callTool('create_media_buy', createMediaBuyArgs(account));
      expect(created.isError, JSON.stringify(created.result)).not.toBe(true);
      session = await readSession(account);
      expect(session.mediaBuys.has(expectedEviction)).toBe(false);
      expect(session.mediaBuys.size).toBe(MAX_MEDIA_BUYS_PER_SESSION);
    }
    expect([...session.mediaBuys.keys()].filter(id => id.startsWith('mb_live_')))
      .toHaveLength(MAX_MEDIA_BUYS_PER_SESSION - terminalBuys.length);

    const refused = await callTool('create_media_buy', createMediaBuyArgs(account));
    expect(refused.result).toMatchObject({ code: 'INVALID_STATE', details: FULL_MEDIA_BUY_LIMIT_DETAILS });
  });

  it('evicts nothing when the create request is refused for another reason', async () => {
    const account = testAccount('limit-refused');
    await editSession(account, session => {
      fillWithLiveBuys(session, account, MAX_MEDIA_BUYS_PER_SESSION - 1);
      session.mediaBuys.set('mb_rejected', storedMediaBuy(account, 'mb_rejected', { status: 'rejected' }));
    });

    const { result } = await callTool('create_media_buy', {
      ...createMediaBuyArgs(account),
      start_time: isoDaysFromNow(FLIGHT_END_DAYS_AHEAD),
      end_time: isoDaysFromNow(FLIGHT_START_DAYS_AHEAD),
    });

    expect(result).toMatchObject({ code: 'INVALID_REQUEST', message: 'start_time must be before end_time' });
    expect((await readSession(account)).mediaBuys.has('mb_rejected')).toBe(true);
  });

  it('counts a buy as live whenever get_media_buys reports it live', async () => {
    const account = testAccount('limit-parity');
    // A controller-seeded buy stored as canceled, without canceledAt, whose
    // package still waits for creatives: get_media_buys reports it live.
    const seededCanceled = storedMediaBuy(account, 'mb_seeded_canceled', {
      status: 'canceled',
      packages: [{
        packageId: 'pkg-0',
        productId: 'seed_product',
        pricingOptionId: 'seed_pricing',
        budget: PACKAGE_BUDGET,
        paused: false,
        startTime: isoDaysFromNow(FLIGHT_START_DAYS_AHEAD),
        endTime: isoDaysFromNow(FLIGHT_END_DAYS_AHEAD),
        creativeAssignments: [],
      }],
    });
    await editSession(account, session => {
      fillWithLiveBuys(session, account, MAX_MEDIA_BUYS_PER_SESSION - 1);
      session.mediaBuys.set(seededCanceled.mediaBuyId, seededCanceled);
    });

    const read = await callTool('get_media_buys', { account, media_buy_ids: [seededCanceled.mediaBuyId] });
    const [reported] = read.result.media_buys as Array<{ status: string }>;
    expect(LIVE_STATUSES).toContain(reported.status);

    const refused = await callTool('create_media_buy', createMediaBuyArgs(account));
    expect(refused.result).toMatchObject({ code: 'INVALID_STATE', details: FULL_MEDIA_BUY_LIMIT_DETAILS });
    expect((await readSession(account)).mediaBuys.has(seededCanceled.mediaBuyId)).toBe(true);
  });

  it('lets a buyer recover by canceling a buy it no longer needs', async () => {
    const account = testAccount('limit-recover');
    const original = await callTool('create_media_buy', createMediaBuyArgs(account));
    const originalId = original.result.media_buy_id as string;
    expect(originalId, JSON.stringify(original.result)).toEqual(expect.any(String));
    await editSession(account, session => fillWithLiveBuys(session, account, MAX_MEDIA_BUYS_PER_SESSION - 1));

    const refused = await callTool('create_media_buy', createMediaBuyArgs(account));
    expect(refused.result.code).toBe('INVALID_STATE');

    const canceled = await callTool('update_media_buy', {
      account,
      media_buy_id: originalId,
      revision: original.result.revision,
      canceled: true,
    });
    expect(canceled.isError, JSON.stringify(canceled.result)).not.toBe(true);

    const retried = await callTool('create_media_buy', createMediaBuyArgs(account));
    expect(retried.isError, JSON.stringify(retried.result)).not.toBe(true);
    expect(retried.result.media_buy_id).toEqual(expect.any(String));
  });
});

describe('package limits', () => {
  it('refuses a create_media_buy with too many packages as a correctable validation error', async () => {
    const account = testAccount('limit-packages');
    const { result } = await callTool('create_media_buy', createMediaBuyArgs(account, MAX_PACKAGES_PER_BUY + 1));

    expect(result).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'packages',
      recovery: 'correctable',
      details: { limit: MAX_PACKAGES_PER_BUY },
    });
  });

  it('refuses new_packages that would push a buy past the per-buy limit', async () => {
    const account = testAccount('limit-new-packages');
    const created = await callTool('create_media_buy', createMediaBuyArgs(account));
    const newPackages = createMediaBuyArgs(account, MAX_PACKAGES_PER_BUY).packages;

    const { result } = await callTool('update_media_buy', {
      account,
      media_buy_id: created.result.media_buy_id,
      revision: created.result.revision,
      new_packages: newPackages,
    });

    expect(result).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'new_packages',
      recovery: 'correctable',
      details: { limit: MAX_PACKAGES_PER_BUY, current: 1 },
    });
  });
});

describe('creative session limit', () => {
  it('still accepts updates to stored creatives and refuses new ones with INVALID_STATE', async () => {
    const account = testAccount('limit-creatives');
    const existing = { creative_id: 'cr_existing', format_id: DISPLAY_FORMAT_ID };
    const synced = await callTool('sync_creatives', { account, creatives: [existing] });
    expect(synced.isError, JSON.stringify(synced.result)).not.toBe(true);
    await editSession(account, session => {
      for (let index = session.creatives.size; index < MAX_CREATIVES_PER_SESSION; index++) {
        const creativeId = `cr_fill_${index}`;
        session.creatives.set(creativeId, { creativeId, status: 'approved', syncedAt: new Date().toISOString() });
      }
    });

    const updated = await callTool('sync_creatives', { account, creatives: [{ ...existing, name: 'Renamed' }] });
    expect(updated.result.creatives).toEqual([expect.objectContaining({ creative_id: 'cr_existing', action: 'updated' })]);

    const { result } = await callTool('sync_creatives', {
      account,
      creatives: [{ creative_id: 'cr_new', format_id: DISPLAY_FORMAT_ID }],
    });
    expect(result).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'correctable',
      details: { limit: MAX_CREATIVES_PER_SESSION, current: MAX_CREATIVES_PER_SESSION },
    });
  });

  it('accepts a pure re-sync when inline or seeded creatives left the account over the limit', async () => {
    const account = testAccount('limit-creatives-over');
    const existing = { creative_id: 'cr_existing', format_id: DISPLAY_FORMAT_ID };
    await callTool('sync_creatives', { account, creatives: [existing] });
    await editSession(account, session => {
      for (let index = session.creatives.size; index < CREATIVES_OVER_LIMIT; index++) {
        const creativeId = `cr_fill_${index}`;
        session.creatives.set(creativeId, { creativeId, status: 'approved', syncedAt: new Date().toISOString() });
      }
    });

    const updated = await callTool('sync_creatives', { account, creatives: [{ ...existing, name: 'Renamed' }] });

    expect(updated.isError, JSON.stringify(updated.result)).not.toBe(true);
    expect(updated.result.creatives).toEqual([expect.objectContaining({ creative_id: 'cr_existing', action: 'updated' })]);
  });
});

describe('property list limits', () => {
  it('refuses a new list with INVALID_STATE until the buyer deletes one', async () => {
    const account = testAccount('limit-property-lists');
    const kept = await callTool('create_property_list', { account, name: 'Kept list' });
    const keptId = (kept.result.list as { list_id: string }).list_id;
    await editSession(account, session => {
      const template = session.propertyLists.get(keptId)!;
      for (let index = session.propertyLists.size; index < MAX_PROPERTY_LISTS_PER_SESSION; index++) {
        const listId = `pl_fill_${index}`;
        session.propertyLists.set(listId, { ...template, listId });
      }
    });

    const refused = await callTool('create_property_list', { account, name: 'One too many' });
    expect(refused.result).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'correctable',
      details: { limit: MAX_PROPERTY_LISTS_PER_SESSION, current: MAX_PROPERTY_LISTS_PER_SESSION },
    });
    expect(refused.result.message).toContain('delete_property_list');

    await callTool('delete_property_list', { account, list_id: keptId });
    const created = await callTool('create_property_list', { account, name: 'Fits again' });
    expect(created.result.list).toMatchObject({ name: 'Fits again' });
  });

  it('refuses too many base_properties as a validation error without applying any update field', async () => {
    const account = testAccount('limit-properties');
    const tooMany = Array.from({ length: MAX_PROPERTIES_PER_LIST + 1 }, (_, index) => `site-${index}.example`);
    const expected = {
      code: 'VALIDATION_ERROR',
      field: 'base_properties',
      recovery: 'correctable',
      details: { limit: MAX_PROPERTIES_PER_LIST },
    };

    const createRefused = await callTool('create_property_list', { account, name: 'Too big', base_properties: tooMany });
    expect(createRefused.result).toMatchObject(expected);

    const created = await callTool('create_property_list', { account, name: 'Original name' });
    const listId = (created.result.list as { list_id: string }).list_id;
    const updateRefused = await callTool('update_property_list', {
      account,
      list_id: listId,
      name: 'Must not persist',
      base_properties: tooMany,
    });
    expect(updateRefused.result).toMatchObject(expected);
    const fetched = await callTool('get_property_list', { account, list_id: listId });
    expect(fetched.result.list).toMatchObject({ name: 'Original name' });
  });
});

describe('content standards and usage limits', () => {
  it('refuses a new content standards configuration with INVALID_STATE', async () => {
    const account = testAccount('limit-content-standards');
    await editSession(account, session => {
      const now = new Date().toISOString();
      for (let index = 0; index < MAX_CONTENT_STANDARDS_PER_SESSION; index++) {
        const standardsId = `cs_fill_${index}`;
        session.contentStandards.set(standardsId, {
          standardsId,
          scope: { languagesAny: ['en'] },
          policy: 'No violence.',
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const { result } = await callTool('create_content_standards', {
      account,
      scope: { languages_any: ['en'] },
      policy: 'No violence.',
    });

    expect(result).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'correctable',
      details: { limit: MAX_CONTENT_STANDARDS_PER_SESSION, current: MAX_CONTENT_STANDARDS_PER_SESSION },
    });
    expect(result.message).toContain('update_content_standards');
  });

  it('refuses usage for a full account as terminal, since no request change can fit it', async () => {
    const account = testAccount('limit-usage-full');
    await editSession(account, session => storeUsageRecords(session, account, MAX_USAGE_RECORDS_PER_SESSION));

    const { result } = await callTool('report_usage', {
      account,
      reporting_period: USAGE_PERIOD,
      usage: [usageRecord(account)],
    });

    expect(result).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'terminal',
      details: { limit: MAX_USAGE_RECORDS_PER_SESSION, current: MAX_USAGE_RECORDS_PER_SESSION },
    });
    expect(result.message).toContain('until its sandbox session expires');
  });

  it('refuses a usage report that does not fit the remaining room as correctable', async () => {
    const account = testAccount('limit-usage-partial');
    await editSession(account, session => storeUsageRecords(session, account, USAGE_RECORDS_NEARLY_FULL));

    const { result } = await callTool('report_usage', {
      account,
      reporting_period: USAGE_PERIOD,
      usage: [usageRecord(account), usageRecord(account)],
    });

    expect(result).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'correctable',
      details: { limit: MAX_USAGE_RECORDS_PER_SESSION, current: USAGE_RECORDS_NEARLY_FULL },
    });
    expect(result.message).toContain(`can accept ${MAX_USAGE_RECORDS_PER_SESSION - USAGE_RECORDS_NEARLY_FULL} more`);
  });
});

describe('public sales route', () => {
  let server: http.Server;
  let url: string;
  let rpcId = 0;

  async function rpc(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${PUBLIC_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: { adcp_version: PUBLIC_ADCP_VERSION, idempotency_key: `test-${randomUUID()}`, ...args } },
      }),
    });
    const body = await response.json() as { result?: ToolResponse; error?: unknown };
    if (!body.result) throw new Error(`JSON-RPC error: ${JSON.stringify(body)}`);
    return body.result;
  }

  beforeEach(async () => {
    await clearIdempotencyCache();
    clearAccountStore();
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({ verify: (req, _res, bytes) => {
      (req as unknown as { rawBody: string }).rawBody = bytes.toString('utf8');
    } }));
    app.use('/api/training-agent', createTrainingAgentRouter());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/training-agent/sales/mcp`;
  }, ROUTER_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await clearIdempotencyCache();
  });

  it('lets an API-key buyer with one sandbox account_id recover from the media buy limit', async () => {
    const synced = await rpc('sync_accounts', { accounts: [{ ...PUBLIC_ACCOUNT, billing: 'operator' }] });
    const accountId = (synced.structuredContent?.accounts as Array<{ account_id: string }> | undefined)?.[0]?.account_id;
    expect(accountId, JSON.stringify(synced)).toEqual(expect.any(String));
    const account = { account_id: accountId };
    const discovery = await rpc('get_products', {
      account,
      buying_mode: 'brief',
      brief: 'Outdoor lifestyle video inventory.',
    });
    const products = discovery.structuredContent?.products as Array<{
      product_id: string;
      pricing_options: Array<{ pricing_option_id: string; floor_price?: number; fixed_price?: number }>;
    }>;
    const product = products.find(row => row.pricing_options?.[0]?.pricing_option_id);
    expect(product, JSON.stringify(discovery)).toBeDefined();
    const pricing = product!.pricing_options[0];
    const createArgs = {
      account,
      total_budget: { amount: PACKAGE_BUDGET, currency: 'USD' },
      start_time: isoDaysFromNow(FLIGHT_START_DAYS_AHEAD),
      end_time: isoDaysFromNow(FLIGHT_END_DAYS_AHEAD),
      packages: [{
        product_id: product!.product_id,
        pricing_option_id: pricing.pricing_option_id,
        budget: PACKAGE_BUDGET,
        bid_price: Math.max(pricing.floor_price ?? pricing.fixed_price ?? 1, 1),
      }],
    };

    const first = await rpc('create_media_buy', createArgs);
    const firstId = first.structuredContent?.media_buy_id as string;
    expect(firstId, JSON.stringify(first)).toEqual(expect.any(String));
    await runWithSessionContext(async () => {
      const [session] = await findSessionsMatching(candidate => candidate.mediaBuys.has(firstId));
      const accountRef = session.mediaBuys.get(firstId)!.accountRef;
      fillWithLiveBuys(session, accountRef, MAX_MEDIA_BUYS_PER_SESSION - 1);
      await flushDirtySessions();
    });

    const refused = await rpc('create_media_buy', createArgs);
    expect(refused.isError, JSON.stringify(refused)).toBe(true);
    expect(refused.structuredContent?.adcp_error).toMatchObject({
      code: 'INVALID_STATE',
      recovery: 'correctable',
      details: FULL_MEDIA_BUY_LIMIT_DETAILS,
    });

    const canceled = await rpc('update_media_buy', {
      account,
      media_buy_id: firstId,
      revision: first.structuredContent?.revision,
      canceled: true,
    });
    expect(canceled.isError, JSON.stringify(canceled)).not.toBe(true);

    const retried = await rpc('create_media_buy', createArgs);
    expect(retried.isError, JSON.stringify(retried)).not.toBe(true);
    expect(retried.structuredContent?.media_buy_id).toEqual(expect.any(String));
  });
});
