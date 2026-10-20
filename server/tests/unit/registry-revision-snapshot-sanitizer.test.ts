import { describe, expect, it } from 'vitest';
import { sanitizePropertySnapshot } from '../../src/db/registry-revision-snapshot.js';
import { sanitizeBrandSnapshot } from '../../src/db/brand-db.js';
import { publicEditorName } from '../../src/routes/registry-revision-access.js';

/** Every `hosted_properties` column a snapshot must never carry. */
const PROPERTY_SECRETS = {
  claim_token: 'claim_tok_live',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  claimant_org_id: 'org_01CLAIMANT',
  created_by_user_id: 'user_01CREATOR',
  created_by_email: 'owner@example.com',
};

/** Every `brands` column a snapshot must never carry. */
const BRAND_SECRETS = {
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  prior_owner_org_id: 'org_01PRIOR',
  created_by_user_id: 'user_01CREATOR',
  created_by_email: 'owner@example.com',
};

describe('sanitizePropertySnapshot', () => {
  const row = {
    id: 'prop_01',
    publisher_domain: 'news.example',
    adagents_json: { authorized_agents: [{ url: 'https://agent.example' }] },
    source_type: 'community',
    is_public: true,
    review_status: 'approved',
    domain_verified: false,
    origin_verified_at: null,
    origin_last_checked_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
    ...PROPERTY_SECRETS,
  };

  it('drops every credential, org id and contact field', () => {
    const sanitized = sanitizePropertySnapshot(row);
    for (const field of Object.keys(PROPERTY_SECRETS)) {
      expect(sanitized).not.toHaveProperty(field);
    }
    expect(JSON.stringify(sanitized)).not.toContain('claim_tok_live');
    expect(JSON.stringify(sanitized)).not.toContain('verify_tok_live');
    expect(JSON.stringify(sanitized)).not.toContain('owner@example.com');
  });

  it('keeps the record content a revision exists to preserve', () => {
    expect(sanitizePropertySnapshot(row)).toEqual({
      publisher_domain: 'news.example',
      adagents_json: { authorized_agents: [{ url: 'https://agent.example' }] },
      source_type: 'community',
      is_public: true,
      review_status: 'approved',
      domain_verified: false,
      origin_verified_at: null,
      origin_last_checked_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    });
  });

  it('drops a column nobody allowlisted, so a new one cannot leak by default', () => {
    expect(sanitizePropertySnapshot({ ...row, some_future_secret: 'nope' }))
      .not.toHaveProperty('some_future_secret');
  });

  it('leaves non-object snapshots alone', () => {
    expect(sanitizePropertySnapshot(null as never)).toBeNull();
    expect(sanitizePropertySnapshot(['a'] as never)).toEqual(['a']);
  });
});

describe('sanitizeBrandSnapshot', () => {
  const row = {
    id: 'brand_01',
    domain: 'acme.example',
    brand_name: 'Acme',
    brand_manifest: { name: 'Acme', classification: { confidence: 0.9 }, brand_context: { voice: 'private' } },
    source_type: 'community',
    has_brand_manifest: true,
    ...BRAND_SECRETS,
  };

  it('drops every credential, org id and contact field', () => {
    const sanitized = sanitizeBrandSnapshot(row);
    for (const field of Object.keys(BRAND_SECRETS)) {
      expect(sanitized).not.toHaveProperty(field);
    }
    expect(JSON.stringify(sanitized)).not.toContain('verify_tok_live');
    expect(JSON.stringify(sanitized)).not.toContain('owner@example.com');
  });

  it('still strips the private manifest blocks it stripped before', () => {
    const sanitized = sanitizeBrandSnapshot(row) as { brand_manifest: Record<string, unknown> };
    expect(sanitized.brand_manifest).toEqual({ name: 'Acme' });
  });

  it('keeps the brand content a rollback restores', () => {
    const sanitized = sanitizeBrandSnapshot({
      ...row,
      canonical_domain: 'acme.example',
      house_domain: 'acmeholdings.example',
      brand_names: [{ name: 'Acme' }],
      keller_type: 'master',
      parent_brand: null,
      brand_agent_url: 'https://agent.acme.example',
      brand_agent_capabilities: ['get_products'],
    }) as Record<string, unknown>;
    expect(sanitized).toMatchObject({
      canonical_domain: 'acme.example',
      house_domain: 'acmeholdings.example',
      brand_names: [{ name: 'Acme' }],
      keller_type: 'master',
      brand_agent_url: 'https://agent.acme.example',
      brand_agent_capabilities: ['get_products'],
      has_brand_manifest: true,
    });
  });

  it('drops a column nobody allowlisted', () => {
    expect(sanitizeBrandSnapshot({ ...row, some_future_secret: 'nope' }))
      .not.toHaveProperty('some_future_secret');
  });
});

describe('publicEditorName', () => {
  it('publishes a display name', () => {
    expect(publicEditorName('Sam Adeyemi')).toBe('Sam Adeyemi');
  });

  it('withholds an address-shaped name, which is how nameless editors were recorded', () => {
    expect(publicEditorName('editor@example.com')).toBeUndefined();
    expect(publicEditorName('  editor@example.com  ')).toBeUndefined();
  });

  it('withholds empty and non-string values', () => {
    expect(publicEditorName('')).toBeUndefined();
    expect(publicEditorName('   ')).toBeUndefined();
    expect(publicEditorName(null)).toBeUndefined();
    expect(publicEditorName(undefined)).toBeUndefined();
    expect(publicEditorName(42)).toBeUndefined();
  });
});
