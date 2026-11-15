import { beforeAll, describe, expect, it } from 'vitest';
import { getSchemaDocumentByRef } from '@adcp/sdk/schemas';
import { ensureCreative33SchemaBundle } from '../../src/training-agent/creative33/schema.js';
import {
  fieldsAddedAfterRelease,
  omitFieldsAddedAfterRelease,
  propertiesAddedAfterRelease,
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
