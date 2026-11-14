import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTaskStore,
  createTrainingAgentServer,
  handleSyncCreatives,
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

// #8960: image_carousel declares cta_values for each card's cta. The training
// agent refuses a card cta outside a declared set with
// CREATIVE_VALUE_NOT_ALLOWED at that card, and leaves cta free text otherwise.

const ACCOUNT = { brand: { domain: 'acme-carousel.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const BRAND = { domain: 'acme-carousel.example' };
const CTX: TrainingContext = { mode: 'open' };
const PRODUCT_ID = 'carousel_cta_values_product';
const DECLARED_OPTION = 'carousel_declared_cta';
const FREE_TEXT_OPTION = 'carousel_free_text_cta';
type Result = Record<string, any>;

async function sync(creatives: Result[]): Promise<Result> {
  return runWithSessionContext(async () => {
    const result = await handleSyncCreatives({
      account: ACCOUNT,
      brand: BRAND,
      idempotency_key: `carousel-cta-${crypto.randomUUID()}`,
      creatives,
    } as unknown as ToolArgs, CTX);
    await flushDirtySessions();
    return result as Result;
  });
}

async function seed(scenario: string, params: Result): Promise<void> {
  const server = createTrainingAgentServer({ mode: 'open' });
  const call = (server as unknown as { _requestHandlers: Map<string, Function> })
    ._requestHandlers.get('tools/call')!;
  const response = await call({ method: 'tools/call', params: {
    name: 'comply_test_controller',
    arguments: { adcp_version: '3.3', account: ACCOUNT, brand: BRAND, scenario, params },
  } }, {});
  const result = response.structuredContent ?? JSON.parse(response.content[0].text);
  expect(result.success, JSON.stringify(result)).toBe(true);
  await server.close();
}

function carousel(creativeId: string, ctas: Array<string | undefined>, formatOptionId?: string): Result {
  return {
    creative_id: creativeId,
    name: `Carousel ${creativeId}`,
    format_kind: 'image_carousel',
    ...(formatOptionId && { format_option_ref: { scope: 'product', format_option_id: formatOptionId } }),
    assets: {
      cards: ctas.map((cta, index) => ({
        asset_type: 'card',
        headline: `Card ${index + 1}`,
        ...(cta !== undefined && { cta }),
        media: {
          asset_type: 'image',
          url: `https://cdn.acme-carousel.example/card-${index + 1}.jpg`,
          width: 1080,
          height: 1080,
        },
      })),
    },
  };
}

function expectAccepted(result: Result): void {
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  for (const creative of result.creatives as Result[]) {
    expect(creative.action, JSON.stringify(creative)).not.toBe('failed');
  }
}

describe('training agent holds image_carousel card cta to declared cta_values (#8960)', () => {
  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    await seed('seed_product', {
      product_id: PRODUCT_ID,
      fixture: {
        delivery_type: 'non_guaranteed',
        channels: ['social'],
        format_options: [
          {
            format_kind: 'image_carousel',
            format_option_id: DECLARED_OPTION,
            canonical_formats_only: true,
            params: { card_aspect_ratio: '1:1', cta_values: ['SHOP_NOW', 'LEARN_MORE'] },
          },
          {
            format_kind: 'image_carousel',
            format_option_id: FREE_TEXT_OPTION,
            canonical_formats_only: true,
            params: { card_aspect_ratio: '1:1' },
          },
        ],
      },
    });
  });

  afterAll(stopSessionCleanup);

  it('refuses a card cta outside the declared cta_values at that card', async () => {
    const result = await sync([carousel('carousel_bad_cta', ['SHOP_NOW', 'SHOP_NOW', 'EXPLORE_MORE'], DECLARED_OPTION)]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'CREATIVE_VALUE_NOT_ALLOWED',
      field: 'creatives[0].assets.cards[2].cta',
      recovery: 'correctable',
      details: {
        constraint: 'cta_values',
        allowed_values: ['SHOP_NOW', 'LEARN_MORE'],
        format_option_id: DECLARED_OPTION,
      },
    });
  });

  it('refuses the same card cta when the creative uses the legacy format_id identity', async () => {
    const { format_kind: _formatKind, ...rest } = carousel('carousel_legacy_bad_cta', ['SHOP_NOW', 'EXPLORE_MORE'], DECLARED_OPTION);
    const legacy = { ...rest, format_id: { agent_url: 'https://creatives.adcontextprotocol.org', id: 'image_carousel' } };
    const result = await sync([legacy]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'CREATIVE_VALUE_NOT_ALLOWED',
      field: 'creatives[0].assets.cards[1].cta',
    });
  });

  it('accepts the same creative once every card cta is a declared value', async () => {
    const result = await sync([carousel('carousel_bad_cta', ['SHOP_NOW', 'SHOP_NOW', 'LEARN_MORE'], DECLARED_OPTION)]);
    expectAccepted(result);
  });

  it('accepts cards that omit cta under a declared cta_values', async () => {
    const result = await sync([carousel('carousel_no_cta', [undefined, 'SHOP_NOW', undefined], DECLARED_OPTION)]);
    expectAccepted(result);
  });

  it('accepts a free-text card cta when the option declares no cta_values', async () => {
    const result = await sync([carousel('carousel_free_text', ['Shop the sale', 'Read our story'], FREE_TEXT_OPTION)]);
    expectAccepted(result);
  });

  it('accepts a free-text card cta when no declaration governs the creative', async () => {
    const result = await sync([carousel('carousel_unbound', ['Shop the sale', 'Read our story'])]);
    expectAccepted(result);
  });
});
