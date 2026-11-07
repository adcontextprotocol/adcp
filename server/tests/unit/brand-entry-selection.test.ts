import { describe, expect, it } from 'vitest';
import { housePortfolioBrandDomains, selectBrandEntry } from '../../src/services/brand-entry-selection.js';

const spark = {
  id: 'spark',
  names: [{ 'en-GB': 'Spark' }, { fr: 'Étincelle' }],
  url: 'https://spark.example/about',
  properties: [{ type: 'website', identifier: 'spark.example', relationship: 'owned' }],
  tagline: [{ 'en-GB': 'A brighter day' }],
  fonts: { primary: { family: 'Example Sans' } },
  tone: { voice: [{ 'en-GB': 'Warm and direct' }] },
  colors: { primary: '#047857' },
};
const glow = { id: 'glow', names: [{ en: 'Glow' }] };
const portfolio = { house: { domain: 'nova-brands.example', name: 'Nova Brands' }, brands: [glow, spark] };

describe('selectBrandEntry', () => {
  it('preserves the complete matching entry and its localized field shapes', () => {
    expect(selectBrandEntry(portfolio, { domain: 'SPARK.EXAMPLE' })).toEqual(spark);
    expect(selectBrandEntry(spark, { domain: 'spark.example' })).toEqual(spark);
  });

  it('selects a known portfolio ID without matching a display name', () => {
    expect(selectBrandEntry(portfolio, { domain: 'nova-brands.example', brandId: 'spark' })).toEqual(spark);
    expect(selectBrandEntry(portfolio, { domain: 'spark.example', brandId: 'missing' })).toBeUndefined();
    expect(selectBrandEntry(spark, { domain: 'spark.example', brandId: 'glow' })).toBeUndefined();
  });

  it('can match the homepage URL independently of properties', () => {
    expect(selectBrandEntry({ ...portfolio, brands: [glow, { ...spark, properties: [] }] }, {
      domain: 'spark.example',
    })).toEqual({ ...spark, properties: [] });
  });

  it('only matches owned website properties and defaults omitted relationships to owned', () => {
    for (const relationship of ['direct', 'delegated', 'ad_network']) {
      const entry = { ...spark, url: undefined, properties: [{ type: 'website', identifier: 'spark.example', relationship }] };
      expect(selectBrandEntry({ ...portfolio, brands: [entry] }, { domain: 'spark.example' })).toBeUndefined();
    }
    const entry = { ...spark, url: undefined, properties: [{ type: 'website', identifier: 'SPARK.EXAMPLE' }] };
    expect(selectBrandEntry({ ...portfolio, brands: [entry] }, { domain: 'spark.example' })).toEqual(entry);
    expect(selectBrandEntry({ ...portfolio, brands: [{ ...entry, properties: [{ type: 'mobile_app', identifier: 'spark.example' }] }] }, {
      domain: 'spark.example',
    })).toBeUndefined();
  });

  it('does not infer ownership from a property carrying a compatibility delegation marker', () => {
    for (const delegation_type of ['direct', 'delegated', 'ad_network', 'unknown', null]) {
      for (const relationship of [undefined, 'owned']) {
        const property = { type: 'website', identifier: 'spark.example', relationship, delegation_type };
        const entry = { ...spark, url: undefined, properties: [property] };
        expect(selectBrandEntry({ ...portfolio, brands: [entry] }, { domain: 'spark.example' })).toBeUndefined();
      }
    }
  });

  it('requires a unique match even if the brands have different matching fields', () => {
    const other = { ...glow, properties: spark.properties };
    expect(selectBrandEntry({ ...portfolio, brands: [spark, other] }, { domain: 'spark.example' })).toBeUndefined();
    expect(selectBrandEntry({ ...portfolio, brands: [spark, { ...spark }] }, { domain: 'nova-brands.example', brandId: 'spark' })).toBeUndefined();
    expect(selectBrandEntry({ ...portfolio, brand_refs: [{ domain: 'spark.example', brand_id: 'pointed' }] }, {
      domain: 'spark.example',
    })).toBeUndefined();
  });

  it('uses a unique master only on the house hostname or a confirmed normalization hostname', () => {
    const master = { ...glow, keller_type: 'master' };
    expect(selectBrandEntry({ ...portfolio, brands: [spark, master] }, { domain: 'nova-brands.example' })).toEqual(master);
    expect(selectBrandEntry({ ...portfolio, brands: [spark, master] }, { domain: 'unrelated.example' })).toBeUndefined();
    const www = { ...portfolio, house: { domain: 'www.nova-brands.example' }, brands: [master] };
    expect(selectBrandEntry(www, { domain: 'nova-brands.example' })).toBeUndefined();
    expect(selectBrandEntry(www, { domain: 'nova-brands.example', houseDomains: ['www.nova-brands.example'] })).toEqual(master);
    expect(selectBrandEntry({ ...portfolio, brands: [master, { ...spark, keller_type: 'master' }] }, {
      domain: 'nova-brands.example',
    })).toBeUndefined();
  });

  it('uses a sole inline entry only at its own house and without additional pointer brands', () => {
    expect(selectBrandEntry({ ...portfolio, brands: [glow] }, { domain: 'nova-brands.example' })).toEqual(glow);
    expect(selectBrandEntry({ ...portfolio, brands: [glow] }, { domain: 'unrelated.example' })).toBeUndefined();
    expect(selectBrandEntry({ ...portfolio, brands: [glow], brand_refs: [{ domain: 'spark.example', brand_id: 'spark' }] }, {
      domain: 'nova-brands.example',
    })).toBeUndefined();
    expect(selectBrandEntry(portfolio, { domain: 'nova-brands.example' })).toBeUndefined();
  });

  it.each([
    { house: 'nova-brands.example' },
    { authoritative_location: 'https://registry.example/brand.json' },
    { agents: [{ type: 'brand', url: 'https://agent.example/mcp' }] },
    { ...portfolio, brands: [], brand_refs: [{ domain: 'spark.example', brand_id: 'spark' }] },
    { ...portfolio, brands: [glow, { name: 'Invalid sibling' }] },
    { name: 'Legacy enrichment without a canonical entry' },
    [], null,
  ])('omits entries for unresolved or incomplete documents: %j', document => {
    expect(selectBrandEntry(document, { domain: 'spark.example' })).toBeUndefined();
  });

  it('does not expose ephemeral context or mutate the source document', () => {
    const context = { private_notes: 'not public' };
    const document = { ...spark, brand_context: context };
    expect(selectBrandEntry(document, { domain: 'spark.example' })).toEqual(spark);
    expect(document.brand_context).toBe(context);
  });
});

describe('housePortfolioBrandDomains', () => {
  it('lists inline brands by url and owned website, and pointers by domain', () => {
    const document = {
      house: { domain: 'nova-brands.example', name: 'Nova Brands' },
      brands: [
        { id: 'spark', names: [{ en: 'Spark' }], url: 'https://www.spark.example/about' },
        { id: 'glow', names: [{ en: 'Glow' }], properties: [{ type: 'website', identifier: 'Glow.example' }] },
      ],
      brand_refs: [{ domain: 'beam.example', brand_id: 'beam' }],
    };
    expect(housePortfolioBrandDomains(document, 'nova-brands.example').sort())
      .toEqual(['beam.example', 'glow.example', 'spark.example']);
  });

  it('ignores websites the house does not own', () => {
    const document = {
      house: { domain: 'nova-brands.example' },
      brands: [{
        id: 'spark',
        names: [{ en: 'Spark' }],
        properties: [
          { type: 'website', identifier: 'partner.example', relationship: 'delegated' },
          { type: 'website', identifier: 'network.example', delegation_type: 'ad_network' },
          { type: 'mobile_app', identifier: 'com.spark.app' },
        ],
      }],
    };
    expect(housePortfolioBrandDomains(document, 'nova-brands.example')).toEqual([]);
  });

  it('leaves out the house itself', () => {
    const document = {
      house: { domain: 'nova-brands.example' },
      brands: [{ id: 'nova', names: [{ en: 'Nova' }], url: 'https://nova-brands.example' }],
    };
    expect(housePortfolioBrandDomains(document, 'nova-brands.example')).toEqual([]);
  });

  it('lists nothing when the document is not this house\'s portfolio', () => {
    const document = {
      house: { domain: 'other-house.example' },
      brand_refs: [{ domain: 'beam.example', brand_id: 'beam' }],
    };
    expect(housePortfolioBrandDomains(document, 'nova-brands.example')).toEqual([]);
    expect(housePortfolioBrandDomains({ id: 'beam', names: [{ en: 'Beam' }] }, 'beam.example')).toEqual([]);
    expect(housePortfolioBrandDomains(null, 'nova-brands.example')).toEqual([]);
  });
});
