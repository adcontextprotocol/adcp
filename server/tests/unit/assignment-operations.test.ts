import { describe, it, expect, beforeEach, vi } from 'vitest';

// Assignment trackers and landing pages are 3.3 surfaces, served only through
// the candidate wire contract.
vi.hoisted(() => {
  process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE = '1';
  process.env.ADCP_TRAINING_CANDIDATE_VERSION = '3.3-beta.0';
});

import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import type { TrainingContext } from '../../src/training-agent/types.js';
import { trackerAllocationProblem } from '../../src/training-agent/assignment-operations.js';
import { fieldsAddedAfterRelease } from '../../src/training-agent/served-release-fields.js';

const CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'assign-ops.example' }, operator: 'assign-ops.example', sandbox: true };
const BRAND = { domain: 'assign-ops.example' };

type Server = ReturnType<typeof createTrainingAgentServer>;

// Task-level errors come back as the unwrapped adcp_error (code, field at the top).
async function call(server: Server, toolName: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const handler = ((server as any)._requestHandlers as Map<string, Function>).get('tools/call')!;
  const versioned = { adcp_version: '3.3-beta.0', ...args };
  const withKey = MUTATING_TOOLS.has(toolName) && versioned.idempotency_key === undefined
    ? { ...versioned, idempotency_key: `test-${crypto.randomUUID()}` }
    : versioned;
  const response = await handler({ method: 'tools/call', params: { name: toolName, arguments: withKey } }, {});
  const text = response.content?.[0]?.text;
  const parsed = response.structuredContent ?? (text ? JSON.parse(text) : {});
  return parsed.adcp_error ?? parsed;
}

function creative(creativeId: string, click = `https://assign-ops.example/${creativeId}`) {
  return {
    creative_id: creativeId,
    name: creativeId,
    format_kind: 'image',
    assets: {
      image: { asset_type: 'image', url: `https://cdn.assign-ops.example/${creativeId}.png`, width: 300, height: 250 },
      click_url: { asset_type: 'url', url_type: 'clickthrough', url: click },
    },
  };
}

const tracker = { event: 'impression', url: 'https://measure.assign-ops.example/imp?pkg=display' };

async function buyWithPackage(server: Server): Promise<{ mediaBuyId: string; packageId: string }> {
  const products = await call(server, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND });
  const product = products.products.find((p: any) => p.format_options?.[0]?.format_kind === 'image') ?? products.products[0];
  const buy = await call(server, 'create_media_buy', {
    account: ACCOUNT,
    brand: BRAND,
    start_time: 'asap',
    end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    packages: [{ product_id: product.product_id, pricing_option_id: product.pricing_options[0].pricing_option_id, budget: 10000 }],
  });
  expect(buy.media_buy_id, JSON.stringify(buy)).toBeTruthy();
  return { mediaBuyId: buy.media_buy_id, packageId: buy.packages[0].package_id };
}

async function approvals(server: Server, mediaBuyId: string): Promise<Array<Record<string, any>>> {
  const read = await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] });
  return read.media_buys[0].packages[0].creative_approvals ?? [];
}

describe('sync_creatives assignment_operations', () => {
  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
    clearAccountStore();
  });

  it('declares assignment trackers and landing pages', async () => {
    const caps = await call(createTrainingAgentServer(CTX), 'get_adcp_capabilities', {});
    expect(caps.creative.supports_assignment_trackers).toBe(true);
    expect(caps.creative.supports_assignment_landing_page).toBe(true);
  });

  it('lists exactly the assignment operations it accepts, including replace for live updates', async () => {
    const caps = await call(createTrainingAgentServer(CTX), 'get_adcp_capabilities', {});
    expect(caps.creative.assignment_operations).toEqual(['assign', 'unassign', 'replace']);
    expect(caps.creative.live_updates).toBeDefined();
    expect(caps.creative.supports_assignment_merge).toBeUndefined();
  });

  it('withholds the list from a 3.2 caller, where the field does not exist', () => {
    const caps = { creative: { has_creative_library: true, assignment_operations: ['assign', 'unassign', 'replace'] } };
    const schemaFile = 'protocol/get-adcp-capabilities-response.json';
    expect(fieldsAddedAfterRelease(caps, schemaFile, '3.2')).toEqual(['/creative/assignment_operations']);
    expect(fieldsAddedAfterRelease(caps, schemaFile, '3.3-beta.0')).toEqual([]);
  });

  it('refuses every operation on a creative-only route, which lists none', async () => {
    const server = createTrainingAgentServer({ ...CTX, tenantId: 'creative' } as TrainingContext);
    const caps = await call(server, 'get_adcp_capabilities', {});
    expect(caps.creative?.assignment_operations).toBeUndefined();
    const { packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId }],
    });
    expect(result).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'assignment_operations[0].operation' });
  });

  it('assigns with trackers and a landing page and reads them back', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignment_operations: [{
        operation: 'assign', creative_id: 'hero_v1', package_id: packageId,
        trackers: [tracker], landing_page_url: 'https://assign-ops.example/spring',
      }],
    });
    expect(result.errors, JSON.stringify(result)).toBeUndefined();
    expect(await approvals(server, mediaBuyId)).toEqual([expect.objectContaining({
      creative_id: 'hero_v1', trackers: [tracker], landing_page_url: 'https://assign-ops.example/spring',
    })]);
    const listed = await call(server, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['hero_v1'] } });
    expect(listed.creatives[0].assignments.assigned_packages[0]).toMatchObject({
      package_id: packageId, media_buy_id: mediaBuyId, trackers: [tracker], landing_page_url: 'https://assign-ops.example/spring',
    });
  });

  it.each([
    ['trackers', { trackers: [tracker] }],
    ['landing_page_url', { landing_page_url: 'https://assign-ops.example/spring' }],
  ])('rejects %s on a deprecated assignments[] row with INVALID_REQUEST (adcp#8501)', async (field, extra) => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignments: [{ creative_id: 'hero_v1', package_id: packageId, ...extra }],
    });
    const error = result.errors?.[0] ?? result;
    expect(error, JSON.stringify(result)).toMatchObject({ code: 'INVALID_REQUEST', field: `assignments[0].${field}` });
    // Nothing was assigned.
    expect(await approvals(server, mediaBuyId)).toEqual([]);
  });

  it('replace transfers trackers and the landing page, and advances the buy revision once', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1'), creative('hero_v2')],
      assignment_operations: [{
        operation: 'assign', creative_id: 'hero_v1', package_id: packageId,
        trackers: [tracker], landing_page_url: 'https://assign-ops.example/spring',
      }],
    });
    const before = (await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] })).media_buys[0].revision;
    const swapped = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'replace', creative_id: 'hero_v2', replaces_creative_id: 'hero_v1', package_id: packageId }],
    });
    expect(swapped.errors, JSON.stringify(swapped)).toBeUndefined();
    expect(swapped.creatives).toEqual([]);
    const rows = await approvals(server, mediaBuyId);
    expect(rows).toEqual([expect.objectContaining({
      creative_id: 'hero_v2', trackers: [tracker], landing_page_url: 'https://assign-ops.example/spring',
    })]);
    const after = (await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] })).media_buys[0].revision;
    expect(after).toBe(before + 1);
  });

  it('unassigns, and an unassign/assign reset restores the creative destination', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1', 'https://assign-ops.example/own')],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, landing_page_url: 'https://assign-ops.example/override' }],
    });
    await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [
        { operation: 'unassign', creative_id: 'hero_v1', package_id: packageId },
        { operation: 'assign', creative_id: 'hero_v1', package_id: packageId },
      ],
    });
    expect(await approvals(server, mediaBuyId)).toEqual([expect.objectContaining({
      creative_id: 'hero_v1', trackers: [], landing_page_url: 'https://assign-ops.example/own',
    })]);
  });

  it('is atomic: a failing operation leaves creatives and assignments unchanged', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignment_operations: [
        { operation: 'assign', creative_id: 'hero_v1', package_id: packageId },
        { operation: 'replace', creative_id: 'hero_v1', replaces_creative_id: 'not_assigned', package_id: packageId },
      ],
    });
    expect(result).toMatchObject({ code: 'INVALID_STATE', field: 'assignment_operations[1].replaces_creative_id' });
    expect(await approvals(server, mediaBuyId)).toEqual([]);
    const listed = await call(server, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['hero_v1'] } });
    expect(listed.creatives ?? []).toHaveLength(0);
  });

  it('rejects merge, unknown packages, and unknown creatives with precise codes', async () => {
    const server = createTrainingAgentServer(CTX);
    const { packageId } = await buyWithPackage(server);
    const merge = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'merge', creative_id: 'a', package_id: packageId, merged_creative_id: 'b' }],
    });
    expect(merge).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'assignment_operations[0].operation' });
    expect(merge.message).toContain('does not accept the merge assignment operation');
    const missingPackage = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'unassign', creative_id: 'a', package_id: 'pkg_nowhere' }],
    });
    expect(missingPackage.code).toBe('PACKAGE_NOT_FOUND');
    const missingCreative = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'assign', creative_id: 'ghost', package_id: packageId }],
    });
    expect(missingCreative.code).toBe('CREATIVE_NOT_FOUND');
  });

  it('treats a canceled buy\'s package as closed to assignment changes', async () => {
    const server = createTrainingAgentServer(CTX);
    const first = await buyWithPackage(server);
    await call(server, 'update_media_buy', { account: ACCOUNT, media_buy_id: first.mediaBuyId, canceled: true, cancellation_reason: 'test' });
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: first.packageId }],
    });
    expect(result.code).toBe('PACKAGE_NOT_FOUND');
  });

  it('assigns a rejected creative, since review status alone never blocks an assignment', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    await call(server, 'comply_test_controller', {
      account: ACCOUNT, scenario: 'force_creative_status',
      params: { creative_id: 'hero_v1', status: 'rejected', rejection_reason: 'Policy' },
    });
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId }],
    });
    expect(result.code, JSON.stringify(result)).toBeUndefined();
    expect((await approvals(server, mediaBuyId)).map(row => row.creative_id)).toEqual(['hero_v1']);
  });

  it('keeps legacy assignments atomic with assignment_operations', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignments: [{ creative_id: 'hero_v1', package_id: packageId, media_buy_id: mediaBuyId }],
      assignment_operations: [{ operation: 'assign', creative_id: 'ghost', package_id: packageId }],
    });
    expect(result.code).toBe('CREATIVE_NOT_FOUND');
    expect(await approvals(server, mediaBuyId)).toEqual([]);
  });

  it('applies overrides when a creative replaces itself', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', {
      account: ACCOUNT, creatives: [creative('hero_v1')],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, weight: 50 }],
    });
    const before = (await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] })).media_buys[0].revision;
    await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'replace', creative_id: 'hero_v1', replaces_creative_id: 'hero_v1', package_id: packageId, weight: 10 }],
    });
    const after = (await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] })).media_buys[0].revision;
    expect(after).toBe(before + 1);
  });

  it('mints package IDs unique across buys, so a package_id names one package', async () => {
    const server = createTrainingAgentServer(CTX);
    const first = await buyWithPackage(server);
    const second = await buyWithPackage(server);
    // Numbered across the account: the first buy keeps pkg-0, the next gets pkg-1.
    expect(first.packageId).toBe('pkg-0');
    expect(second.packageId).toBe('pkg-1');
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: second.packageId }],
    });
    expect(result.code, JSON.stringify(result)).toBeUndefined();
    expect(await approvals(server, first.mediaBuyId)).toEqual([]);
    expect((await approvals(server, second.mediaBuyId)).map(row => row.creative_id)).toEqual(['hero_v1']);
  });

  it('applies nothing on dry_run', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      dry_run: true,
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId }],
    });
    expect(result.errors, JSON.stringify(result)).toBeUndefined();
    expect(await approvals(server, mediaBuyId)).toEqual([]);
  });
});

describe('assignment tracker slots', () => {
  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
    clearAccountStore();
  });

  it('allocates trackers to compatible declared slots after the creative keeps its own', () => {
    const slots = [
      { asset_group_id: 'image_main', asset_type: 'image' },
      { asset_group_id: 'impression_tracker', asset_type: 'pixel_tracker', max: 2 },
      { asset_group_id: 'click_tracker', asset_type: 'pixel_tracker', max: 1 },
    ];
    expect(trackerAllocationProblem(slots, {}, [{ event: 'impression' }, { event: 'impression' }, { event: 'click' }])).toBeUndefined();
    expect(trackerAllocationProblem(slots, { impression_tracker: 1 }, [{ event: 'impression' }, { event: 'impression' }])).toMatch(/impression/);
    expect(trackerAllocationProblem(slots, {}, [{ event: 'viewable_mrc_50' }])).toMatch(/viewable_mrc_50/);
    expect(trackerAllocationProblem([{ asset_group_id: 'pixels', asset_type: 'pixel_tracker', max: 1 }], {}, [{ event: 'viewable_mrc_50' }])).toBeUndefined();
    expect(trackerAllocationProblem([{ asset_group_id: 'image_main', asset_type: 'image' }], {}, [{ event: 'impression' }]))
      .toBeUndefined();
  });

  async function slotLimitedBuy(server: Server): Promise<{ mediaBuyId: string; packageId: string }> {
    const productId = 'tracker_slot_product';
    const seeded = await call(server, 'comply_test_controller', {
      account: ACCOUNT, brand: BRAND, scenario: 'seed_product',
      params: {
        product_id: productId,
        fixture: {
          channels: ['display'],
          delivery_type: 'non_guaranteed',
          format_options: [{
            format_kind: 'image',
            format_option_id: 'image_one_impression_tracker',
            params: {
              slots: [
                { asset_group_id: 'image_main', asset_type: 'image', required: true },
                { asset_group_id: 'landing_page_url', asset_type: 'url' },
                { asset_group_id: 'impression_tracker', asset_type: 'pixel_tracker', max: 1 },
              ],
            },
          }],
        },
      },
    });
    expect(seeded.success, JSON.stringify(seeded)).toBe(true);
    await call(server, 'comply_test_controller', {
      account: ACCOUNT, brand: BRAND, scenario: 'seed_pricing_option',
      params: { product_id: productId, pricing_option_id: 'tracker_slot_cpm', fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price: 10 } },
    });
    const buy = await call(server, 'create_media_buy', {
      account: ACCOUNT, brand: BRAND, start_time: 'asap',
      end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      packages: [{ product_id: productId, pricing_option_id: 'tracker_slot_cpm', budget: 10000 }],
    });
    expect(buy.media_buy_id, JSON.stringify(buy)).toBeTruthy();
    return { mediaBuyId: buy.media_buy_id, packageId: buy.packages[0].package_id };
  }

  const pixel = (n: number) => ({ event: 'impression', url: `https://measure.assign-ops.example/imp${n}` });

  it('rejects an assignment whose trackers overflow the format slot, and accepts one that fits', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await slotLimitedBuy(server);
    const overflow = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, trackers: [pixel(1), pixel(2)] }],
    });
    expect(overflow).toMatchObject({ code: 'VALIDATION_ERROR', field: 'assignment_operations[0].trackers' });
    expect(await approvals(server, mediaBuyId)).toEqual([]);
    const fits = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1')],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, trackers: [pixel(1)] }],
    });
    expect(fits.code, JSON.stringify(fits)).toBeUndefined();
  });

  it('counts the replacement creative\'s own trackers when a replace transfers assignment trackers', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await slotLimitedBuy(server);
    const withOwnTracker = {
      ...creative('hero_v2'),
      assets: { ...creative('hero_v2').assets, impression_tracker: { asset_type: 'pixel_tracker', event: 'impression', method: 'img', url: 'https://own.example/imp' } },
    };
    await call(server, 'sync_creatives', {
      account: ACCOUNT,
      creatives: [creative('hero_v1'), withOwnTracker],
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, trackers: [pixel(1)] }],
    });
    const swapped = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'replace', creative_id: 'hero_v2', replaces_creative_id: 'hero_v1', package_id: packageId }],
    });
    expect(swapped).toMatchObject({ code: 'VALIDATION_ERROR', field: 'assignment_operations[0].creative_id' });
    expect((await approvals(server, mediaBuyId)).map(row => row.creative_id)).toEqual(['hero_v1']);
  });

  it('ignores assignment trackers and landing pages on create_media_buy rows', async () => {
    const server = createTrainingAgentServer(CTX);
    await slotLimitedBuy(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    // Two trackers would overflow the one-slot format if the row were checked; the row is not.
    const buy = await call(server, 'create_media_buy', {
      account: ACCOUNT, brand: BRAND, start_time: 'asap',
      end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      packages: [{
        product_id: 'tracker_slot_product', pricing_option_id: 'tracker_slot_cpm', budget: 10000,
        creative_assignments: [{ creative_id: 'hero_v1', trackers: [pixel(1), pixel(2)], landing_page_url: 'https://assign-ops.example/x' }],
      }],
    });
    expect(buy.errors, JSON.stringify(buy)).toBeUndefined();
    expect(buy.media_buy_id).toBeTruthy();
    const rows = await approvals(server, buy.media_buy_id);
    expect(rows.map(row => row.creative_id)).toEqual(['hero_v1']);
    expect(rows[0].trackers ?? []).toEqual([]);
    // The effective destination is the creative's own click-through, not the ignored request value.
    expect(rows[0].landing_page_url).toBe('https://assign-ops.example/hero_v1');
  });

  it('ignores trackers in an update_media_buy creative_assignments replacement', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await slotLimitedBuy(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1'), creative('hero_v2')] });
    const read = await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] });
    const result = await call(server, 'update_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision: read.media_buys[0].revision,
      packages: [{
        package_id: packageId,
        creative_assignments: [{ creative_id: 'hero_v2', trackers: [pixel(1), pixel(2)], landing_page_url: 'https://assign-ops.example/x' }],
      }],
    });
    expect(result.errors, JSON.stringify(result)).toBeUndefined();
    const rows = await approvals(server, mediaBuyId);
    expect(rows.map(row => row.creative_id)).toEqual(['hero_v2']);
    expect(rows[0].trackers ?? []).toEqual([]);
    expect(rows[0].landing_page_url).toBe('https://assign-ops.example/hero_v2');
  });

  it('keeps trackers stored through sync_creatives assign across an update that changes only the budget', async () => {
    const server = createTrainingAgentServer(CTX);
    const { mediaBuyId, packageId } = await slotLimitedBuy(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    const assigned = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, trackers: [pixel(1)] }],
    });
    expect(assigned.code).toBeUndefined();
    expect((await approvals(server, mediaBuyId))[0]).toMatchObject({ creative_id: 'hero_v1', trackers: [pixel(1)] });
    const read = await call(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] });
    const result = await call(server, 'update_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision: read.media_buys[0].revision,
      packages: [{ package_id: packageId, budget: 8000 }],
    });
    expect(result.errors, JSON.stringify(result)).toBeUndefined();
    // The deprecated update_media_buy response does not echo assign-set settings (adcp#8501).
    const echoed = result.affected_packages[0].creative_assignments[0];
    expect(echoed.creative_id).toBe('hero_v1');
    expect(echoed).not.toHaveProperty('trackers');
    expect(echoed).not.toHaveProperty('landing_page_url');
    expect((await approvals(server, mediaBuyId))[0]).toMatchObject({ creative_id: 'hero_v1', trackers: [pixel(1)] });
  });

  it('refuses assignment trackers where the capability is not declared', async () => {
    const server = createTrainingAgentServer({ ...CTX, tenantId: 'creative' } as TrainingContext);
    const { packageId } = await buyWithPackage(server);
    await call(server, 'sync_creatives', { account: ACCOUNT, creatives: [creative('hero_v1')] });
    const result = await call(server, 'sync_creatives', {
      account: ACCOUNT,
      assignment_operations: [{ operation: 'assign', creative_id: 'hero_v1', package_id: packageId, trackers: [pixel(1)] }],
    });
    expect(result.code).toBe('UNSUPPORTED_FEATURE');
  });
});
