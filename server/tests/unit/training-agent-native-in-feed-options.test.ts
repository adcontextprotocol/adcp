import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTaskStore,
  createTrainingAgentServer,
  handleCreateMediaBuy,
  handleGetAdcpCapabilities,
  handleSyncCreatives,
  handleValidateInput,
  invalidateCache,
} from '../../src/training-agent/task-handlers.js';
import {
  clearSessions,
  flushDirtySessions,
  runWithSessionContext,
  stopSessionCleanup,
} from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { ToolArgs, TrainingContext } from '../../src/training-agent/types.js';

// #8917: sync_creatives must hold a native_in_feed creative to the format
// option it targets, not to a fixed profile. These cases build creatives
// straight from the training agent's own declarations.

const ACCOUNT = { brand: { domain: 'acme-native.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const BRAND = { domain: 'acme-native.example' };
const CTX: TrainingContext = { mode: 'open' };
type Result = Record<string, any>;
type Handler = (args: ToolArgs, ctx: TrainingContext) => Promise<unknown>;

async function direct(handler: Handler, args: Result): Promise<Result> {
  return runWithSessionContext(async () => {
    const result = await handler({
      account: ACCOUNT,
      brand: BRAND,
      idempotency_key: `native-options-${crypto.randomUUID()}`,
      ...args,
    } as ToolArgs, CTX);
    await flushDirtySessions();
    return result as Result;
  });
}

function nativeCreative(
  creativeId: string,
  overrides: { image?: { width: number; height: number }; title?: string; cta?: string; icon?: boolean } = {},
  formatOptionId?: string,
): Result {
  const image = overrides.image ?? { width: 1200, height: 627 };
  return {
    creative_id: creativeId,
    name: `Native ${creativeId}`,
    format_kind: 'native_in_feed',
    ...(formatOptionId && { format_option_ref: { scope: 'product', format_option_id: formatOptionId } }),
    assets: {
      title: { asset_type: 'text', content: overrides.title ?? 'Trail Pro 3000' },
      main_image: {
        asset_type: 'image',
        url: `https://cdn.acme-native.example/hero-${image.width}x${image.height}.jpg`,
        width: image.width,
        height: image.height,
      },
      ...(overrides.icon && {
        icon: { asset_type: 'image', url: 'https://cdn.acme-native.example/icon.png', width: 80, height: 80 },
      }),
      ...(overrides.cta !== undefined && { cta: { asset_type: 'text', content: overrides.cta } }),
      advertiser_name: { asset_type: 'text', content: 'Acme Outdoor' },
      landing_page_url: { asset_type: 'url', url: 'https://acme-native.example/trail-pro' },
    },
  };
}

async function sync(creatives: Result[], extra: Result = {}): Promise<Result> {
  return direct(handleSyncCreatives, { creatives, ...extra });
}

function expectAccepted(result: Result): void {
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  for (const creative of result.creatives as Result[]) {
    expect(creative.action, JSON.stringify(creative)).not.toBe('failed');
  }
}

async function seed(scenario: string, params: Result): Promise<void> {
  const server = createTrainingAgentServer({ mode: 'open' });
  const call = (server as unknown as { _requestHandlers: Map<string, Function> })
    ._requestHandlers.get('tools/call')!;
  const response = await call({ method: 'tools/call', params: {
    name: 'comply_test_controller',
    arguments: { adcp_version: '3.2', account: ACCOUNT, brand: BRAND, scenario, params },
  } }, {});
  const result = response.structuredContent ?? JSON.parse(response.content[0].text);
  expect(result.success, JSON.stringify(result)).toBe(true);
  await server.close();
}

describe('training agent sync_creatives honors declared native_in_feed options (#8917)', () => {
  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
  });

  afterAll(stopSessionCleanup);

  describe('creative targeting a catalog option by format_option_ref', () => {
    it('accepts a 600x400 main_image with no icon for native_content_card (case 1)', async () => {
      // native_content_card declares main_image_sizes [600x400], title_max_chars 90.
      const result = await sync([
        nativeCreative('content_card_600x400', { image: { width: 600, height: 400 } }, 'native_content_card_native_in_feed'),
      ]);
      expectAccepted(result);
    });

    it('accepts a title within the option title_max_chars even above the capability limit', async () => {
      const title = 'T'.repeat(90);
      const result = await sync([
        nativeCreative('content_card_title_90', { image: { width: 600, height: 400 }, title }, 'native_content_card_native_in_feed'),
      ]);
      expectAccepted(result);
    });

    it.each([
      'social_feed_card_native_in_feed',
      'native_feed_native_in_feed',
      'native_post_native_in_feed',
    ])('accepts a free-text cta for %s, which declares no cta_values (case 2)', async optionId => {
      const result = await sync([
        nativeCreative(`influencer_${optionId}`, { image: { width: 1080, height: 1080 }, cta: 'Shop now' }, optionId),
      ]);
      expectAccepted(result);
    });

    it('refuses a main_image outside the option main_image_sizes with VALIDATION_ERROR naming the constraint', async () => {
      const result = await sync([
        nativeCreative('content_card_wrong_size', { image: { width: 1200, height: 627 } }, 'native_content_card_native_in_feed'),
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: 'VALIDATION_ERROR',
        field: 'creatives[0].assets.main_image',
        recovery: 'correctable',
        details: {
          constraint: 'main_image_sizes',
          declared: [{ width: 600, height: 400 }],
          format_option_id: 'native_content_card_native_in_feed',
        },
      });
    });

    it('refuses a title over the option title_max_chars', async () => {
      const result = await sync([
        nativeCreative('content_card_title_91', { image: { width: 600, height: 400 }, title: 'T'.repeat(91) }, 'native_content_card_native_in_feed'),
      ]);
      expect(result.errors?.[0]).toMatchObject({
        code: 'VALIDATION_ERROR',
        field: 'creatives[0].assets.title.content',
        details: { constraint: 'title_max_chars', declared: 90 },
      });
    });
  });

  describe('option-declared cta_values and icon_size (seeded product)', () => {
    const PRODUCT_ID = 'native_cta_enum_product';
    const OPTION_ID = 'native_cta_enum_option';

    beforeEach(async () => {
      await seed('seed_product', {
        product_id: PRODUCT_ID,
        fixture: {
          delivery_type: 'non_guaranteed',
          channels: ['display'],
          format_options: [{
            format_kind: 'native_in_feed',
            format_option_id: OPTION_ID,
            canonical_formats_only: true,
            params: {
              title_max_chars: 60,
              cta_values: ['Get offer', 'Visit site'],
              main_image_sizes: [{ width: 627, height: 627 }],
              icon_size: { width: 80, height: 80 },
            },
          }],
        },
      });
    });

    it('accepts a creative built exactly to the declared option, with and without the optional icon', async () => {
      const result = await sync([
        nativeCreative('cta_enum_exact', { image: { width: 627, height: 627 }, cta: 'Get offer', icon: true }, OPTION_ID),
        nativeCreative('cta_enum_no_icon', { image: { width: 627, height: 627 }, cta: 'Visit site' }, OPTION_ID),
      ]);
      expectAccepted(result);
    });

    it('refuses a cta outside the declared cta_values with CREATIVE_VALUE_NOT_ALLOWED and the declared list', async () => {
      const result = await sync([
        nativeCreative('cta_enum_bad', { image: { width: 627, height: 627 }, cta: 'LEARN_MORE' }, OPTION_ID),
      ]);
      expect(result.errors?.[0]).toMatchObject({
        code: 'CREATIVE_VALUE_NOT_ALLOWED',
        field: 'creatives[0].assets.cta.content',
        details: {
          constraint: 'cta_values',
          accepted_values: ['Get offer', 'Visit site'],
          format_option_id: OPTION_ID,
        },
      });
    });

    it('refuses an icon that is present but not the declared icon_size', async () => {
      const creative = nativeCreative('cta_enum_bad_icon', { image: { width: 627, height: 627 }, cta: 'Get offer' }, OPTION_ID);
      creative.assets.icon = { asset_type: 'image', url: 'https://cdn.acme-native.example/icon.png', width: 64, height: 64 };
      const result = await sync([creative]);
      expect(result.errors?.[0]).toMatchObject({
        code: 'VALIDATION_ERROR',
        field: 'creatives[0].assets.icon',
        details: { constraint: 'icon_size' },
      });
    });
  });

  describe('creative assigned to a package', () => {
    const PRODUCT_ID = 'native_assignment_product';

    beforeEach(async () => {
      await seed('seed_product', {
        product_id: PRODUCT_ID,
        fixture: {
          delivery_type: 'non_guaranteed',
          channels: ['display'],
          format_options: [{
            format_kind: 'native_in_feed',
            format_option_id: 'native_assignment_card',
            canonical_formats_only: true,
            params: { title_max_chars: 90, main_image_sizes: [{ width: 600, height: 400 }] },
          }],
        },
      });
      await seed('seed_pricing_option', {
        product_id: PRODUCT_ID,
        pricing_option_id: 'fixed_cpm',
        fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price: 9 },
      });
    });

    async function createBuy(): Promise<{ mediaBuyId: string; packageId: string }> {
      const created = await direct(handleCreateMediaBuy, {
        name: 'Native assignment',
        start_time: 'asap',
        end_time: '2099-07-01T00:00:00Z',
        packages: [{ product_id: PRODUCT_ID, pricing_option_id: 'fixed_cpm', budget: 5_000 }],
      });
      expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
      return { mediaBuyId: created.media_buy_id, packageId: created.packages[0].package_id };
    }

    it('holds an unreferenced creative to the assigned package option, not the agent capability', async () => {
      const { mediaBuyId, packageId } = await createBuy();
      const creative = nativeCreative('assigned_600x400', { image: { width: 600, height: 400 }, cta: 'Shop now' });
      const result = await sync([creative], {
        assignments: [{ creative_id: creative.creative_id, media_buy_id: mediaBuyId, package_id: packageId }],
      });
      expectAccepted(result);
      expect(result.assignments ?? []).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    });

    it('refuses an unreferenced creative that breaks the assigned package option', async () => {
      const { mediaBuyId, packageId } = await createBuy();
      const creative = nativeCreative('assigned_wrong_size', { image: { width: 1080, height: 1080 } });
      const result = await sync([creative], {
        assignments: [{ creative_id: creative.creative_id, media_buy_id: mediaBuyId, package_id: packageId }],
      });
      expect(result.errors?.[0]).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { constraint: 'main_image_sizes', format_option_id: 'native_assignment_card' },
      });
    });
  });

  describe('creative with no product context', () => {
    it('publishes the native_in_feed capability constraints it enforces', async () => {
      const capabilities = await direct(handleGetAdcpCapabilities, {});
      const native = (capabilities.creative?.supported_formats as Result[] | undefined)
        ?.find(entry => entry.capability_id === 'native_in_feed');
      expect(native?.format.params).toMatchObject({
        title_max_chars: 80,
        main_image_sizes: [{ width: 1200, height: 627 }, { width: 1080, height: 1080 }],
        cta_values: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'DOWNLOAD', 'APPLY_NOW'],
      });
    });

    it.each([
      { width: 1200, height: 627 },
      { width: 1080, height: 1080 },
    ])('accepts each capability main_image size %o', async image => {
      const result = await sync([nativeCreative(`bare_${image.width}`, { image, cta: 'LEARN_MORE' })]);
      expectAccepted(result);
    });

    it('refuses an undeclared size and an undeclared cta against the capability', async () => {
      const size = await sync([nativeCreative('bare_640', { image: { width: 640, height: 480 } })]);
      expect(size.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR', details: { constraint: 'main_image_sizes' } });

      const cta = await sync([nativeCreative('bare_cta', { cta: 'EXPLORE_MORE' })]);
      expect(cta.errors?.[0]).toMatchObject({
        code: 'CREATIVE_VALUE_NOT_ALLOWED',
        details: { accepted_values: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'DOWNLOAD', 'APPLY_NOW'] },
      });
    });

    it('applies the same capability constraints in validate_input', async () => {
      const result = await direct(handleValidateInput, {
        manifest: nativeCreative('validate_cta', { cta: 'EXPLORE_MORE' }),
        targets: [{ kind: 'capability', id: 'native_in_feed' }],
      });
      expect(result.results[0]).toMatchObject({
        result_kind: 'validated_fail',
        violations: [expect.objectContaining({ rule: 'cta_values', field: 'manifest.assets.cta.content' })],
      });
    });
  });
});
