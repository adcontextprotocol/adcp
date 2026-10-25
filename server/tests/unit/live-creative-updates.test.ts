import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { classifyCreativeChange, decideLiveUpdate } from '../../src/training-agent/live-creative-updates.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'live-updates.example' }, operator: 'live-updates.example', sandbox: true };
const BRAND = { domain: 'live-updates.example' };
const AGENT_URL = 'http://localhost:3000/api/training-agent';

type Server = ReturnType<typeof createTrainingAgentServer>;

async function call(server: Server, toolName: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const handler = ((server as any)._requestHandlers as Map<string, Function>).get('tools/call')!;
  // Live creative updates ship on the 3.2+ wire; pin the served release.
  const versioned = { adcp_version: '3.2', ...args };
  const withKey = MUTATING_TOOLS.has(toolName) && versioned.idempotency_key === undefined
    ? { ...versioned, idempotency_key: `test-${crypto.randomUUID()}` }
    : versioned;
  const response = await handler({ method: 'tools/call', params: { name: toolName, arguments: withKey } }, {});
  const text = response.content?.[0]?.text;
  const parsed = response.structuredContent ?? (text ? JSON.parse(text) : {});
  return parsed.adcp_error ?? parsed;
}

function creative(overrides: { image?: string; click?: string; tracker?: string; format?: string } = {}) {
  return {
    creative_id: 'live_hero',
    name: 'Live hero',
    format_id: { agent_url: AGENT_URL, id: overrides.format ?? 'display_300x250' },
    assets: {
      image: { asset_type: 'image', url: overrides.image ?? 'https://cdn.live-updates.example/hero-v1.png', width: 300, height: 250 },
      click_url: { asset_type: 'url', url_type: 'clickthrough', url: overrides.click ?? 'https://live-updates.example/landing' },
      impression_tracker: { asset_type: 'url', url_type: 'tracker_pixel', url: overrides.tracker ?? 'https://measure.live-updates.example/i1' },
    },
  };
}

async function liveCreative(server: Server): Promise<string> {
  const products = await call(server, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND });
  const product = products.products.find((p: any) => (p.format_ids ?? []).some((f: any) => f.id === 'display_300x250'))
    ?? products.products[0];
  const buy = await call(server, 'create_media_buy', {
    account: ACCOUNT,
    brand: BRAND,
    start_time: 'asap',
    end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    packages: [{ product_id: product.product_id, pricing_option_id: product.pricing_options[0].pricing_option_id, budget: 10000 }],
  });
  expect(buy.media_buy_id, JSON.stringify(buy)).toBeTruthy();
  const packageId = buy.packages[0].package_id as string;
  const synced = await call(server, 'sync_creatives', {
    account: ACCOUNT,
    creatives: [creative()],
    assignments: [{ media_buy_id: buy.media_buy_id, package_id: packageId, creative_id: 'live_hero' }],
  });
  expect(synced.assignments?.[0]?.status, JSON.stringify(synced)).toBe('assigned');
  return packageId;
}

async function listOne(server: Server): Promise<Record<string, any>> {
  const listed = await call(server, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['live_hero'] } });
  return listed.creatives[0];
}

describe('live creative updates', () => {
  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
    clearAccountStore();
  });

  it('classifies change kinds by the assets that changed', () => {
    const before = { assets: creative().assets as any };
    expect(classifyCreativeChange(before, { assets: creative({ tracker: 'https://m.example/i2' }).assets as any }, false)).toEqual(['trackers']);
    expect(classifyCreativeChange(before, { assets: creative({ click: 'https://x.example' }).assets as any }, false)).toEqual(['click_through']);
    expect(classifyCreativeChange(before, { assets: creative({ image: 'https://x.example/v2.png' }).assets as any }, false)).toEqual(['asset_content']);
    expect(classifyCreativeChange(before, { assets: creative().assets as any }, true)).toEqual(['format']);
    expect(decideLiveUpdate(['trackers', 'asset_content'])).toEqual({ outcome: 'apply', mode: 'staged' });
    expect(decideLiveUpdate(['format', 'trackers'])).toEqual({ outcome: 'refuse', refusedChanges: ['format'] });
  });

  it('declares the capability and the experimental feature', async () => {
    const caps = await call(createTrainingAgentServer(CTX), 'get_adcp_capabilities', {});
    expect(caps.creative.live_updates.in_place).toContainEqual({ change: 'asset_content', serving: 'staged', on_rejection: 'keeps_prior' });
    expect(caps.experimental_features).toContain('creative.live_updates');
  });

  it('applies tracker changes to a live creative immediately', async () => {
    const server = createTrainingAgentServer(CTX);
    await liveCreative(server);
    const before = await listOne(server);
    expect(before.live_updates.in_place.map((e: any) => e.change)).toContain('trackers');

    const result = await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ tracker: 'https://measure.live-updates.example/i2' })] });
    expect(result.creatives[0]).toMatchObject({ action: 'updated', status: 'approved' });
    expect(result.creatives[0].staged_update).toBeUndefined();
    const after = await listOne(server);
    expect(after.assets.impression_tracker.url).toBe('https://measure.live-updates.example/i2');
  });

  it('stages an asset change, keeps the prior version serving, and promotes on approval', async () => {
    const server = createTrainingAgentServer(CTX);
    await liveCreative(server);
    const v2 = 'https://cdn.live-updates.example/hero-v2.png';

    const result = await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ image: v2 })] });
    expect(result.creatives[0]).toMatchObject({ action: 'updated', status: 'approved' });
    expect(result.creatives[0].staged_update).toMatchObject({ status: 'pending_review', change_kinds: ['asset_content'] });

    const staged = await listOne(server);
    expect(staged.status).toBe('approved');
    expect(staged.assets.image.url).toBe('https://cdn.live-updates.example/hero-v1.png');
    expect(staged.staged_update.status).toBe('pending_review');

    const forced = await call(server, 'comply_test_controller', {
      account: ACCOUNT,
      scenario: 'force_creative_status',
      params: { creative_id: 'live_hero', status: 'approved' },
    });
    expect(forced.success, JSON.stringify(forced)).toBe(true);

    const promoted = await listOne(server);
    expect(promoted.status).toBe('approved');
    expect(promoted.assets.image.url).toBe(v2);
    expect(promoted.staged_update).toBeUndefined();
  });

  it('keeps the prior version when review rejects the staged update', async () => {
    const server = createTrainingAgentServer(CTX);
    await liveCreative(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ image: 'https://cdn.live-updates.example/hero-v2.png' })] });

    const forced = await call(server, 'comply_test_controller', {
      account: ACCOUNT,
      scenario: 'force_creative_status',
      params: { creative_id: 'live_hero', status: 'rejected', rejection_reason: 'Prohibited claim in new artwork' },
    });
    expect(forced.success, JSON.stringify(forced)).toBe(true);

    const after = await listOne(server);
    expect(after.status).toBe('approved');
    expect(after.assets.image.url).toBe('https://cdn.live-updates.example/hero-v1.png');
    expect(after.staged_update).toMatchObject({ status: 'rejected', rejection_reason: 'Prohibited claim in new artwork' });
  });

  it('withdraws a staged update when the serving content is synced again', async () => {
    const server = createTrainingAgentServer(CTX);
    await liveCreative(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ image: 'https://cdn.live-updates.example/hero-v2.png' })] });
    const result = await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative()] });
    expect(result.creatives[0].staged_update).toBeUndefined();
    expect((await listOne(server)).staged_update).toBeUndefined();
  });

  it('refuses a format change on a live creative and leaves it unchanged, including on dry run', async () => {
    const server = createTrainingAgentServer(CTX);
    const packageId = await liveCreative(server);
    for (const dryRun of [true, false]) {
      const result = await call(server, 'sync_creatives', {
        account: ACCOUNT,
        dry_run: dryRun,
        creatives: [creative({ format: 'display_728x90' })],
      });
      expect(result.creatives[0].action).toBe('failed');
      expect(result.creatives[0].errors[0]).toMatchObject({
        code: 'CREATIVE_LIVE_UPDATE_UNSUPPORTED',
        details: { refused_changes: ['format'], live_package_ids: [packageId] },
      });
    }
    const after = await listOne(server);
    expect(after.format_id.id).toBe('display_300x250');
  });

  it('treats an assigned creative that is not approved as an ordinary upsert', async () => {
    const server = createTrainingAgentServer(CTX);
    await liveCreative(server);
    await call(server, 'comply_test_controller', {
      account: ACCOUNT,
      scenario: 'force_creative_status',
      params: { creative_id: 'live_hero', status: 'rejected', rejection_reason: 'Policy' },
    });
    const result = await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ tracker: 'https://m.example/i9', image: 'https://cdn.live-updates.example/fixed.png' })] });
    expect(result.creatives[0]).toMatchObject({ action: 'updated', status: 'rejected' });
    expect(result.creatives[0].staged_update).toBeUndefined();
    const after = await listOne(server);
    expect(after.live_updates).toBeUndefined();
    expect(after.assets.image.url).toBe('https://cdn.live-updates.example/fixed.png');
  });

  it('discards a staged update when the creative leaves approved', async () => {
    const server = createTrainingAgentServer(CTX);
    await liveCreative(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ image: 'https://cdn.live-updates.example/hero-v2.png' })] });
    await call(server, 'comply_test_controller', {
      account: ACCOUNT,
      scenario: 'force_creative_status',
      params: { creative_id: 'live_hero', status: 'rejected', rejection_reason: 'Staged artwork' },
    });
    // A rejected staged update is no longer under review: rejecting again revokes the serving version.
    const revoked = await call(server, 'comply_test_controller', {
      account: ACCOUNT,
      scenario: 'force_creative_status',
      params: { creative_id: 'live_hero', status: 'rejected', rejection_reason: 'Serving artwork revoked' },
    });
    expect(revoked.success, JSON.stringify(revoked)).toBe(true);
    const after = await listOne(server);
    expect(after.status).toBe('rejected');
    expect(after.staged_update).toBeUndefined();
  });

  it('leaves non-declaring tenants on ordinary upserts', async () => {
    const sales = createTrainingAgentServer(CTX);
    await liveCreative(sales);
    const creativeTenant = createTrainingAgentServer({ ...CTX, tenantId: 'creative' } as TrainingContext);
    const caps = await call(creativeTenant, 'get_adcp_capabilities', {});
    expect(caps.creative?.live_updates).toBeUndefined();
    const result = await call(creativeTenant, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ image: 'https://cdn.live-updates.example/hero-v2.png' })] });
    expect(result.creatives[0].staged_update).toBeUndefined();
  });

  it('treats a creative with no live assignment as an ordinary upsert', async () => {
    const server = createTrainingAgentServer(CTX);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative()] });
    const result = await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative({ format: 'display_728x90' })] });
    expect(result.creatives[0].action).toBe('updated');
    const after = await listOne(server);
    expect(after.live_updates).toBeUndefined();
    expect(after.format_id.id).toBe('display_728x90');
  });
});
