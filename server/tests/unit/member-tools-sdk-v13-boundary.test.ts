import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeTask, getProducts } = vi.hoisted(() => ({
  executeTask: vi.fn(),
  getProducts: vi.fn(),
}));

vi.mock('@adcp/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adcp/sdk')>()),
  AdCPClient: class MockAdCPClient {
    agent() {
      return { executeTask, getProducts };
    }
  },
}));

import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';

const CANONICAL_PRODUCT_RESULT = {
  success: true as const,
  data: {
    products: [{
      product_id: 'product-1',
      name: 'Display placement',
      channels: ['display'],
      format_options: [{
        format_kind: 'image',
        format_option_id: 'homepage_image',
        params: { width: 300, height: 250 },
        v1_format_ref: [{ agent_url: 'https://seller.example.com', id: 'display_300x250' }],
      }, {
        format_kind: 'image_carousel',
        format_option_id: 'homepage_carousel',
        params: { min_items: 3, max_items: 10 },
        canonical_formats_only: true,
      }],
      pricing_options: [{
        pricing_option_id: 'cpm-1',
        pricing_model: 'cpm',
        fixed_price: 10,
        currency: 'USD',
      }],
      delivery_type: 'guaranteed',
    }],
    proposals: [],
  },
};

describe('member evaluation tools on the SDK v13 canonical boundary', () => {
  beforeEach(() => {
    executeTask.mockReset();
    getProducts.mockReset().mockResolvedValue(CANONICAL_PRODUCT_RESULT);
  });

  it('compare_media_kit consumes canonical and alias format labels without fabricating a brand', async () => {
    const handler = createMemberToolHandlers(null).get('compare_media_kit')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      media_kit_summary: 'Display inventory',
      verticals: ['sdk-v13-boundary-test'],
      channels: ['display'],
      formats: ['300x250'],
    });

    expect(getProducts).toHaveBeenCalledWith(expect.not.objectContaining({ brand: expect.anything() }));
    expect(output).toContain('display_300x250');
    expect(output).toContain('image_carousel');
  });

  it('test_rfp_response scores canonical and compatibility format labels', async () => {
    const handler = createMemberToolHandlers(null).get('test_rfp_response')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      rfp: {
        brief: 'Reach display audiences',
        formats: ['300x250'],
      },
    });

    expect(getProducts).toHaveBeenCalledWith(expect.not.objectContaining({ brand: expect.anything() }));
    expect(output).toContain('display_300x250');
    expect(output).toContain('**Formats:** 1/1 covered');
  });

  it('test_io_execution uses legacy format IDs when matching line items', async () => {
    const handler = createMemberToolHandlers(null).get('test_io_execution')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      advertiser_domain: 'advertiser.example.com',
      account_id: 'account-1',
      line_items: [{
        description: 'Display placement',
        channel: 'display',
        format: '300x250',
        pricing_model: 'cpm',
        budget: 1_000,
      }],
    });

    expect(getProducts).toHaveBeenCalledWith({
      buying_mode: 'wholesale',
      brand: { domain: 'advertiser.example.com' },
      account: { account_id: 'account-1' },
    });
    expect(output).toContain('| mapped |');
    expect(output).toContain('Display placement (exact)');
    expect(output).toContain('"domain": "advertiser.example.com"');
    expect(output).toContain('"product_id": "product-1"');
  });

  it('requires a real advertiser domain before executing a media buy', async () => {
    const handler = createMemberToolHandlers(null).get('test_io_execution')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      line_items: [{ description: 'Display placement' }],
      execute: true,
    });

    expect(output).toBe('**Error:** advertiser_domain is required when execute is true.');
    expect(getProducts).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('executes create_media_buy canonically with the supplied advertiser domain', async () => {
    executeTask.mockResolvedValue({
      success: true,
      data: { media_buy_id: 'media-buy-1', status: 'active', packages: [] },
    });
    const handler = createMemberToolHandlers(null).get('test_io_execution')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      advertiser: 'Advertiser account',
      advertiser_domain: 'https://www.advertiser.example.com/path',
      account_id: 'seller-account-1',
      line_items: [{
        description: 'Display placement',
        channel: 'display',
        format: '300x250',
        pricing_model: 'cpm',
        budget: 1_000,
      }],
      execute: true,
    });

    expect(getProducts).toHaveBeenCalledWith({
      buying_mode: 'wholesale',
      brand: { domain: 'advertiser.example.com' },
      account: { account_id: 'seller-account-1' },
    });
    expect(executeTask).toHaveBeenCalledWith('create_media_buy', expect.objectContaining({
      brand: { domain: 'advertiser.example.com' },
      account: { account_id: 'seller-account-1' },
      packages: [expect.objectContaining({ product_id: 'product-1', pricing_option_id: 'cpm-1' })],
    }));
    expect(output).toContain('**Success** — Media buy created: media-buy-1');
  });

  it('requires a seller-assigned account ID before executing a media buy', async () => {
    const handler = createMemberToolHandlers(null).get('test_io_execution')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      advertiser_domain: 'advertiser.example.com',
      line_items: [{ description: 'Display placement' }],
      execute: true,
    });

    expect(output).toBe('**Error:** account_id is required when execute is true.');
    expect(getProducts).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('rejects malformed advertiser domains before contacting the agent', async () => {
    const handler = createMemberToolHandlers(null).get('test_io_execution')!;

    const output = await handler({
      agent_url: 'https://seller.example.com/mcp',
      advertiser_domain: 'not-a-public-domain',
      account_id: 'account-1',
      line_items: [{ description: 'Display placement' }],
    });

    expect(output).toBe('**Error:** advertiser_domain must be a valid public brand domain.');
    expect(getProducts).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });
});
