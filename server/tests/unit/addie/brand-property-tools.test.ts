/**
 * Unit tests for parse_brand_properties / import_brand_properties Addie tools.
 *
 * The tools are thin wrappers over the brand-property-parse service. These
 * tests pin the contract Addie depends on:
 *
 *   1. Both tools refuse if there's no signed-in member context.
 *   2. The tools normalize domain inputs (strip protocol/path, lowercase).
 *   3. Successful parse returns a `preview: true` payload with `next_step`
 *      pointing the model at import_brand_properties.
 *   4. Errors from the service propagate with the original status + message
 *      (so 403 ownership failures look the same here as on the HTTP route).
 *   5. Schemas advertise the property-type and relationship enums (the
 *      load-bearing output filter still applies inside the service, but the
 *      schema gives Addie a typed surface to call against).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const mocks = vi.hoisted(() => ({
  parsePropertyInputForBrand: vi.fn(),
  mergeBrandProperties: vi.fn(),
}));

// Mock the shared service so the tests don't need a DB / Anthropic. We're
// pinning the tool surface, not the service — the service has its own
// integration coverage in brand-properties-parse.test.ts.
vi.mock('../../../src/services/brand-property-parse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/brand-property-parse.js')>();
  return {
    ...actual,
    parsePropertyInputForBrand: mocks.parsePropertyInputForBrand,
    mergeBrandProperties: mocks.mergeBrandProperties,
  };
});

const {
  BRAND_PROPERTY_TOOLS,
  createBrandPropertyToolHandlers,
} = await import('../../../src/addie/mcp/brand-property-tools.js');

import type { MemberContext } from '../../../src/addie/member-context.js';

function getTool(name: string) {
  const tool = BRAND_PROPERTY_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

const SIGNED_IN_CTX = {
  is_mapped: true,
  is_member: true,
  slack_linked: false,
  workos_user: { workos_user_id: 'user_owner_123', email: 'owner@example.com' },
} as unknown as MemberContext;

beforeEach(() => {
  mocks.parsePropertyInputForBrand.mockReset();
  mocks.mergeBrandProperties.mockReset();
});

describe('parse_brand_properties tool schema', () => {
  it('declares the property-type and relationship enums on the schema', () => {
    const schema = getTool('parse_brand_properties').input_schema;
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.input_type.enum).toEqual(['text', 'url']);
    expect(props.relationship.enum).toEqual(
      expect.arrayContaining(['owned', 'direct', 'delegated', 'ad_network']),
    );
    expect(schema.required).toEqual(expect.arrayContaining(['domain', 'input']));
  });
});

describe('parse_brand_properties handler', () => {
  it('refuses when there is no signed-in member context', async () => {
    const handlers = createBrandPropertyToolHandlers(null);
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: 'paste-demo.example',
        input: 'cnn.com\nbbc.co.uk',
        input_type: 'text',
      }),
    );
    expect(result.error).toMatch(/sign(?:ed)? in/i);
    expect(mocks.parsePropertyInputForBrand).not.toHaveBeenCalled();
  });

  it('refuses when domain is empty', async () => {
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: '',
        input: 'cnn.com',
      }),
    );
    expect(result.error).toMatch(/domain/i);
    expect(mocks.parsePropertyInputForBrand).not.toHaveBeenCalled();
  });

  it('refuses when input is empty', async () => {
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: 'paste-demo.example',
        input: '   ',
      }),
    );
    expect(result.error).toMatch(/input/i);
    expect(mocks.parsePropertyInputForBrand).not.toHaveBeenCalled();
  });

  it('normalizes the domain (strips protocol + path, lowercases) before calling the service', async () => {
    mocks.parsePropertyInputForBrand.mockResolvedValueOnce({
      ok: true,
      properties: [{ identifier: 'cnn.com', type: 'website', relationship: 'delegated' }],
      count: 1,
      truncated: false,
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    await handlers.get('parse_brand_properties')!({
      domain: 'HTTPS://Paste-Demo.Example/path?q=1',
      input: 'cnn.com',
    });
    expect(mocks.parsePropertyInputForBrand).toHaveBeenCalledOnce();
    const callArgs = mocks.parsePropertyInputForBrand.mock.calls[0][0];
    expect(callArgs.domain).toBe('paste-demo.example');
    expect(callArgs.userId).toBe('user_owner_123');
    expect(callArgs.inputType).toBe('text');
  });

  it('returns a preview-only payload with a next_step pointing at the import tool', async () => {
    mocks.parsePropertyInputForBrand.mockResolvedValueOnce({
      ok: true,
      properties: [
        { identifier: 'cnn.com', type: 'website', relationship: 'delegated' },
        { identifier: 'bbc.co.uk', type: 'website', relationship: 'delegated' },
      ],
      count: 2,
      truncated: false,
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: 'paste-demo.example',
        input: 'cnn.com\nbbc.co.uk',
        input_type: 'text',
      }),
    );
    expect(result.preview).toBe(true);
    expect(result.count).toBe(2);
    expect(result.properties).toHaveLength(2);
    expect(result.next_step).toMatch(/import_brand_properties/);
  });

  it('propagates service errors with the original status + message', async () => {
    mocks.parsePropertyInputForBrand.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'You do not own this brand domain',
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: 'someone-elses.example',
        input: 'cnn.com',
        input_type: 'text',
      }),
    );
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/do not own/i);
  });

  it('forwards the relationship override when provided', async () => {
    mocks.parsePropertyInputForBrand.mockResolvedValueOnce({
      ok: true,
      properties: [],
      count: 0,
      truncated: false,
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    await handlers.get('parse_brand_properties')!({
      domain: 'paste-demo.example',
      input: 'cnn.com',
      input_type: 'text',
      relationship: 'owned',
    });
    const callArgs = mocks.parsePropertyInputForBrand.mock.calls[0][0];
    expect(callArgs.relationship).toBe('owned');
  });

  it('signals "no properties" with a hint instead of a fake import next_step', async () => {
    mocks.parsePropertyInputForBrand.mockResolvedValueOnce({
      ok: true,
      properties: [],
      count: 0,
      truncated: false,
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: 'paste-demo.example',
        input: 'no-real-domains-here',
        input_type: 'text',
      }),
    );
    expect(result.count).toBe(0);
    // next_step should not point at import — there's nothing to import.
    expect(result.next_step).not.toMatch(/import_brand_properties/);
  });
});

describe('import_brand_properties handler', () => {
  it('refuses when there is no signed-in member context', async () => {
    const handlers = createBrandPropertyToolHandlers(null);
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: 'paste-demo.example',
        properties: [{ identifier: 'cnn.com', type: 'website' }],
      }),
    );
    expect(result.error).toMatch(/sign(?:ed)? in/i);
    expect(mocks.mergeBrandProperties).not.toHaveBeenCalled();
  });

  it('refuses when properties is not an array', async () => {
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: 'paste-demo.example',
        properties: 'not an array',
      }),
    );
    expect(result.error).toMatch(/array/i);
    expect(mocks.mergeBrandProperties).not.toHaveBeenCalled();
  });

  it('passes the property list straight through to the merge service', async () => {
    mocks.mergeBrandProperties.mockResolvedValueOnce({
      ok: true,
      report: { added: 2, updated: 0, skipped: 0, total: 2 },
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: 'paste-demo.example',
        properties: [
          { identifier: 'cnn.com', type: 'website', relationship: 'delegated' },
          { identifier: 'bbc.co.uk', type: 'website', relationship: 'delegated' },
        ],
      }),
    );
    expect(result.added).toBe(2);
    expect(mocks.mergeBrandProperties).toHaveBeenCalledOnce();
    const callArgs = mocks.mergeBrandProperties.mock.calls[0][0];
    expect(callArgs.userId).toBe('user_owner_123');
    expect(callArgs.domain).toBe('paste-demo.example');
    expect(callArgs.properties).toHaveLength(2);
  });

  it('propagates service errors with the original status + message', async () => {
    mocks.mergeBrandProperties.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'Brand not found',
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: 'unknown.example',
        properties: [{ identifier: 'cnn.com', type: 'website' }],
      }),
    );
    expect(result.status).toBe(404);
    expect(result.error).toBe('Brand not found');
  });

  it('normalizes domain on the import call too', async () => {
    mocks.mergeBrandProperties.mockResolvedValueOnce({
      ok: true,
      report: { added: 1, updated: 0, skipped: 0, total: 1 },
    });
    const handlers = createBrandPropertyToolHandlers(SIGNED_IN_CTX);
    await handlers.get('import_brand_properties')!({
      domain: 'HTTPS://Paste-Demo.Example/foo',
      properties: [{ identifier: 'cnn.com', type: 'website' }],
    });
    const callArgs = mocks.mergeBrandProperties.mock.calls[0][0];
    expect(callArgs.domain).toBe('paste-demo.example');
  });
});

describe('import_brand_properties tool schema', () => {
  it('declares the property-type and relationship enums on each item', () => {
    const schema = getTool('import_brand_properties').input_schema;
    const props = schema.properties as Record<string, unknown>;
    const propsArr = props.properties as { items: { properties: Record<string, { enum?: string[] }> } };
    const itemProps = propsArr.items.properties;
    expect(itemProps.type.enum).toEqual(
      expect.arrayContaining(['website', 'mobile_app', 'ctv_app', 'desktop_app', 'dooh', 'podcast', 'radio', 'streaming_audio']),
    );
    expect(itemProps.relationship.enum).toEqual(
      expect.arrayContaining(['owned', 'direct', 'delegated', 'ad_network']),
    );
    expect(schema.required).toEqual(expect.arrayContaining(['domain', 'properties']));
  });
});
