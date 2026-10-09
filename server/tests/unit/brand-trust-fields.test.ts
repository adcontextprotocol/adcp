import { describe, it, expect } from 'vitest';
import {
  isDomainControlVerified,
  stripBrandTrustFields,
  stripUnattestedTrustFields,
  publicBrandJsonManifest,
  preserveBrandTrustFields,
} from '../../src/services/brand-trust-fields.js';

const portfolio = () => ({
  house: {
    domain: 'acme.example',
    name: 'Acme',
    agents: [{ type: 'sales', id: 's', url: 'https://acme.example/mcp', jwks_uri: 'https://acme.example/jwks.json' }],
    identity_relying_parties: [{ relying_party_id: 'rp' }],
  },
  brands: [
    {
      id: 'acme_main',
      names: [{ en: 'Acme' }],
      logos: [{ url: 'https://cdn.acme.example/logo.svg' }],
      agents: [{ type: 'brand', id: 'b', url: 'https://acme.example/brand', jwks_uri: 'https://acme.example/b.json' }],
      brand_agent: { url: 'https://acme.example/brand' },
    },
  ],
  authorized_operators: [{ domain: 'attacker.example', brands: ['*'] }],
  brand_refs: [{ domain: 'sub.example', brand_id: 'sub' }],
  identity_relying_parties: [{ relying_party_id: 'rp2' }],
});

describe('isDomainControlVerified', () => {
  it('trusts crawled brand.json rows and verified owner-hosted rows only', () => {
    expect(isDomainControlVerified({ source_type: 'brand_json' })).toBe(true);
    expect(isDomainControlVerified({ source_type: 'community', domain_verified: true, workos_organization_id: 'org_1' })).toBe(true);
    expect(isDomainControlVerified({ source_type: 'community', domain_verified: false, workos_organization_id: 'org_1' })).toBe(false);
    expect(isDomainControlVerified({ source_type: 'community', domain_verified: true })).toBe(false);
    expect(isDomainControlVerified({ source_type: 'enriched' })).toBe(false);
  });
});

describe('stripUnattestedTrustFields', () => {
  it('removes operator delegation, keys, relying parties, and portfolio claims at every level', () => {
    const out = stripUnattestedTrustFields(portfolio()) as any;
    expect(out.authorized_operators).toBeUndefined();
    expect(out.brand_refs).toBeUndefined();
    expect(out.identity_relying_parties).toBeUndefined();
    expect(out.house.identity_relying_parties).toBeUndefined();
    expect(out.house.agents[0].jwks_uri).toBeUndefined();
    expect(out.brands[0].agents[0].jwks_uri).toBeUndefined();
  });

  it('keeps URL-only agent listings and identity content', () => {
    const out = stripUnattestedTrustFields(portfolio()) as any;
    expect(out.house.agents[0]).toEqual({ type: 'sales', id: 's', url: 'https://acme.example/mcp' });
    expect(out.brands[0].logos).toEqual([{ url: 'https://cdn.acme.example/logo.svg' }]);
    expect(out.house.name).toBe('Acme');
  });

  it('drops deprecated brand_agent / rights_agent pointers at every level', () => {
    const out = stripUnattestedTrustFields({
      brand_agent: { url: 'https://attacker.example/mcp', id: 'a', jwks_uri: 'https://attacker.example/jwks.json' },
      rights_agent: { url: 'https://attacker.example/rights', id: 'r' },
      house: { domain: 'acme.example', brand_agent: { url: 'https://attacker.example/mcp' } },
      brands: [{ id: 'acme_main', rights_agent: { url: 'https://attacker.example/rights' } }],
    }) as any;
    expect(out.brand_agent).toBeUndefined();
    expect(out.rights_agent).toBeUndefined();
    expect(out.house.brand_agent).toBeUndefined();
    expect(out.brands[0].rights_agent).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input = portfolio();
    stripUnattestedTrustFields(input);
    expect(input.authorized_operators).toHaveLength(1);
    expect(input.house.agents[0].jwks_uri).toBeDefined();
  });

  it('scrubs top-level agents on brand-agent and canonical documents', () => {
    const out = stripUnattestedTrustFields({
      agents: [{ type: 'governance', id: 'g', url: 'https://gov.example/mcp', jwks_uri: 'https://evil.example/jwks.json' }],
    }) as any;
    expect(out.agents[0].jwks_uri).toBeUndefined();
  });
});

describe('publicBrandJsonManifest', () => {
  it('serves attested rows unchanged', () => {
    const manifest = portfolio();
    expect(publicBrandJsonManifest({ source_type: 'brand_json' }, manifest)).toBe(manifest);
  });

  it('strips trust fields from community rows', () => {
    const out = publicBrandJsonManifest({ source_type: 'community' }, portfolio()) as any;
    expect(out.authorized_operators).toBeUndefined();
  });
});

describe('preserveBrandTrustFields', () => {
  it('ignores trust fields in a content edit and keeps the prior ones', () => {
    const prior = portfolio();
    const submitted = {
      ...portfolio(),
      authorized_operators: [{ domain: 'other-attacker.example', brands: ['*'] }],
      house: { domain: 'acme.example', name: 'Acme Renamed', agents: [{ type: 'sales', id: 'x', url: 'https://evil.example/mcp' }] },
    };
    const out = preserveBrandTrustFields(submitted, prior) as any;
    expect(out.authorized_operators).toEqual(prior.authorized_operators);
    expect(out.house.agents).toEqual(prior.house.agents);
    expect(out.house.name).toBe('Acme Renamed');
  });

  it('keeps prior agents when a builder save omits them', () => {
    const prior = portfolio();
    const submitted = {
      house: { domain: 'acme.example', name: 'Acme' },
      brands: [{ id: 'acme_main', names: [{ en: 'Acme' }], colors: { primary: '#000000' } }],
    };
    const out = preserveBrandTrustFields(submitted, prior) as any;
    expect(out.house.agents).toEqual(prior.house.agents);
    expect(out.brands[0].agents).toEqual(prior.brands[0].agents);
    expect(out.brands[0].colors).toEqual({ primary: '#000000' });
  });

  it('cannot introduce trust fields when the prior manifest had none', () => {
    const out = preserveBrandTrustFields(portfolio(), { house: { domain: 'acme.example' } }) as any;
    expect(out.authorized_operators).toBeUndefined();
    expect(out.house.agents).toBeUndefined();
    expect(out.brands[0].agents).toBeUndefined();
    expect(out.brands[0].brand_agent).toBeUndefined();
  });

  it('strips everything when there is no prior manifest', () => {
    expect(preserveBrandTrustFields(portfolio(), null)).toEqual(stripBrandTrustFields(portfolio()));
  });
});
