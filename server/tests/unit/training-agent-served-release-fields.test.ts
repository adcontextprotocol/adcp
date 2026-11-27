import { beforeAll, describe, expect, it } from 'vitest';
import { getSchemaDocumentByRef } from '@adcp/sdk/schemas';
import { TRAINING_AGENT_PREVIEW_ADCP_VERSION } from '../../src/training-agent/candidate-version.js';
import { ensureCreative33SchemaBundle } from '../../src/training-agent/creative33/schema.js';
import {
  fieldsAddedAfterRelease,
  omitFieldsAddedAfterRelease,
  propertiesAddedAfterRelease,
  servedLifecycleTools,
  servedReleaseEnum,
  undeclaredMembers,
} from '../../src/training-agent/served-release-fields.js';

const CAPABILITIES = 'protocol/get-adcp-capabilities-response.json';

describe('served-release field gate (#8487)', () => {
  beforeAll(() => ensureCreative33SchemaBundle());

  it('withholds the 3.3 canonical-product fields from 3.2, and only fields 3.2 lacks', () => {
    const withheld = propertiesAddedAfterRelease('core/canonical-product.json', '3.2');
    expect(withheld).toContain('installments');
    const bundled = getSchemaDocumentByRef('core/canonical-product.json', '3.2');
    expect(bundled?.resolvedVersion).toBe('3.2.8');
    const threeTwo = bundled?.schema as
      { properties?: Record<string, unknown>; additionalProperties?: unknown } | undefined;
    expect(threeTwo?.additionalProperties).toBe(true);
    for (const field of withheld) expect(threeTwo?.properties, field).not.toHaveProperty(field);
    expect(propertiesAddedAfterRelease('core/canonical-product.json', '3.3-beta.1')).toEqual(new Set());
  });

  it('finds 3.3 fields under objects 3.2 leaves open, and leaves undeclared keys alone', () => {
    const capabilities = {
      adcp_version: '3.2',
      account: { sandbox: true, stable_account_id: true },
      media_buy: {
        features: { inline_creative_management: true, supports_property_breakdown: true },
        vendor_metric_optimization: { supported_targets: ['cost_per'], supported_metrics: [] },
      },
      ext: { stable_account_id: true },
    };
    expect(fieldsAddedAfterRelease(capabilities, CAPABILITIES, '3.2')).toEqual([
      '/account/stable_account_id',
      '/media_buy/features/supports_property_breakdown',
      '/media_buy/vendor_metric_optimization/supported_metrics',
    ]);
    // Same release line, whatever the prerelease checkpoint.
    expect(fieldsAddedAfterRelease(capabilities, CAPABILITIES, '3.3-beta.1')).toEqual([]);
    // A 3.2 field is newer than 3.1.
    expect(fieldsAddedAfterRelease({ media_buy: { anonymous_discovery: true } }, CAPABILITIES, '3.1'))
      .toEqual(['/media_buy/anonymous_discovery']);
    expect(fieldsAddedAfterRelease({ media_buy: { anonymous_discovery: true } }, CAPABILITIES, '3.2')).toEqual([]);
  });

  it('copies only when it withholds something', () => {
    const current = { account: { sandbox: true } };
    expect(omitFieldsAddedAfterRelease(current, CAPABILITIES, '3.2')).toBe(current);
    const leaking = { account: { sandbox: true, stable_account_id: true } };
    expect(omitFieldsAddedAfterRelease(leaking, CAPABILITIES, '3.2')).toEqual({ account: { sandbox: true } });
    expect(leaking.account.stable_account_id).toBe(true);
  });

  it("reads a closed enum from the served release's bundle", () => {
    expect(servedReleaseEnum('enums/specialism.json', '3.1')).not.toContain('sales-dooh');
    expect(servedReleaseEnum('enums/specialism.json', '3.2')).toContain('sales-dooh');
    expect(servedReleaseEnum('enums/specialism.json', '3.2')).not.toContain('sales-fixed-rate');
    expect(servedReleaseEnum('enums/specialism.json', '3.3-beta.1')).toContain('sales-fixed-rate');
    // A prerelease pin the SDK ships no bundle for reads its release line.
    expect(servedReleaseEnum('enums/specialism.json', '3.1-rc.15')).toEqual(servedReleaseEnum('enums/specialism.json', '3.1'));
    expect(servedReleaseEnum('enums/specialism.json', '3.2-rc.0')).not.toContain('sales-fixed-rate');
    // No bundle at all leaves the caller's list as is.
    expect(servedReleaseEnum('enums/specialism.json', '4.0')).toBeNull();
  });
});

describe('servedReleaseEnum with a pointer', () => {
  const ITEMS = '/properties/media_buy/properties/lifecycle_tools/items';

  it('reads an inline enum and leaves the no-pointer behaviour unchanged', () => {
    const threeTwo = servedReleaseEnum(CAPABILITIES, '3.2', ITEMS);
    expect(threeTwo).toContain('buy_products');
    expect(threeTwo).not.toContain('list_proposals');
    expect(servedReleaseEnum(CAPABILITIES, '3.2-rc.7', ITEMS)).toEqual(threeTwo);
    // The document root has no enum, with or without a pointer.
    expect(servedReleaseEnum(CAPABILITIES, '3.2')).toBeNull();
    expect(servedReleaseEnum('enums/specialism.json', '3.2')).toContain('sales-dooh');
    expect(servedReleaseEnum(CAPABILITIES, '3.2', '/properties/nope')).toBeNull();
    expect(servedReleaseEnum(CAPABILITIES, '4.0', ITEMS)).toBeNull();
  });
});

describe('servedLifecycleTools (#8981)', () => {
  const PREVIEW = TRAINING_AGENT_PREVIEW_ADCP_VERSION ?? '3.3-rc.3';
  const SERVED = [
    'control_media_buy', 'list_proposals', 'get_products', 'accept_proposal', 'buy_products',
    'decline_proposals', 'create_media_buy', 'refine_proposals', 'request_proposals', 'list_products',
  ];
  const ENUM_ORDER = [...servedReleaseEnum(CAPABILITIES, '3.2', '/properties/media_buy/properties/lifecycle_tools/items')!];

  beforeAll(() => ensureCreative33SchemaBundle());

  it('drops list_proposals at 3.2 even when served, and drops non-lifecycle tools', () => {
    const tools = servedLifecycleTools(SERVED, '3.2');
    expect(tools).not.toContain('list_proposals');
    expect(tools).not.toContain('get_products');
    expect(tools).not.toContain('create_media_buy');
    expect(tools).toEqual(ENUM_ORDER.filter(tool => SERVED.includes(tool)));
    expect(tools.length).toBeGreaterThan(0);
  });

  it('keeps list_proposals at the 3.3 preview', () => {
    expect(servedLifecycleTools(SERVED, PREVIEW)).toContain('list_proposals');
    expect(servedLifecycleTools(['list_proposals'], PREVIEW)).toEqual(['list_proposals']);
  });

  it('follows the enum order whatever the input order is', () => {
    const forward = servedLifecycleTools(SERVED, '3.2');
    expect(servedLifecycleTools([...SERVED].reverse(), '3.2')).toEqual(forward);
    expect(servedLifecycleTools(new Set(SERVED), '3.2')).toEqual(forward);
  });

  it('resolves a prerelease pin to its release line', () => {
    expect(servedLifecycleTools(SERVED, '3.2-rc.7')).toEqual(servedLifecycleTools(SERVED, '3.2'));
  });

  it('falls back to the source vocabulary when no bundle is available', () => {
    // 3.3-beta.5 has no bundle and no 3.3 line bundle in the SDK, so the
    // source schema's enum (which includes the 3.3 value) applies.
    const tools = servedLifecycleTools(SERVED, '3.3-beta.5');
    expect(tools).toContain('list_proposals');
    expect(tools).toContain('buy_products');
    expect(tools).not.toContain('get_products');
  });

  it('returns nothing when no lifecycle tool is served', () => {
    expect(servedLifecycleTools(['get_products', 'create_media_buy'], '3.2')).toEqual([]);
  });
});

describe('undeclared members in commercial terms', () => {
  const PURCHASE = 'media-buy/product-purchase-input.json';
  const purchase = {
    product_id: 'p1',
    pricing_option_id: 'cpm',
    format_option_refs: [{ scope: 'product', format_option_id: 'f1' }],
    budget: 1000,
  };

  it('finds a member no declaration covers under an open schema', () => {
    expect(undeclaredMembers(purchase, PURCHASE)).toEqual([]);
    const withMember = {
      ...purchase,
      format_option_refs: [{ scope: 'product', format_option_id: 'f1', adcp_compliance_undefined_member: 0.6 }],
    };
    expect(undeclaredMembers(withMember, PURCHASE)).toEqual([['format_option_refs', '0', 'adcp_compliance_undefined_member']]);
  });

  it('counts ext members as uninterpreted and context members as opaque', () => {
    expect(undeclaredMembers({ ...purchase, ext: { acme: { weight: 2 } } }, PURCHASE)).toEqual([['ext', 'acme']]);
    expect(undeclaredMembers({ ...purchase, context: { trace_id: 't1' } }, PURCHASE)).toEqual([]);
  });
});
