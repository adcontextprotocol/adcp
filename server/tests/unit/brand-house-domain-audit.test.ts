import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getClient: mocks.getClient,
}));

import {
  BrandDatabase,
  recordBrandHouseDomainChange,
} from '../../src/db/brand-db.js';

function makeClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function brandRow(domain: string, houseDomain: string | null) {
  return {
    domain,
    house_domain: houseDomain,
    brand_names: '[]',
    brand_manifest: null,
    source_type: 'enriched',
    discovered_at: new Date(),
    last_validated: new Date(),
  };
}

describe('brand house-domain audit trail (#3419)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  it('records deterministic prior/new organization attribution without PII', async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({
        rows: [
          { domain: 'old-house.example', workos_organization_id: 'org-old' },
          { domain: 'new-house.example', workos_organization_id: 'org-new' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await recordBrandHouseDomainChange(client as never, {
      domain: 'brand.example',
      prior_house_domain: 'old-house.example',
      new_house_domain: 'new-house.example',
      audit: { actor_user_id: 'user-1', source: 'community_edit', revision_number: 7 },
    });

    const auditParams = client.query.mock.calls[1][1] as unknown[];
    expect(auditParams.slice(0, 3)).toEqual(['org-new', 'user-1', 'brand.example']);
    const details = JSON.parse(auditParams[3] as string);
    expect(details).toEqual({
      schema_version: 1,
      domain: 'brand.example',
      prior_house_domain: 'old-house.example',
      new_house_domain: 'new-house.example',
      prior_parent_org_id: 'org-old',
      new_parent_org_id: 'org-new',
      mutation_source: 'community_edit',
      revision_number: 7,
    });
    expect(JSON.stringify(details)).not.toContain('email');
  });

  it('does not write an audit event for an unchanged edge', async () => {
    const client = makeClient();
    await recordBrandHouseDomainChange(client as never, {
      domain: 'brand.example',
      prior_house_domain: 'house.example',
      new_house_domain: 'house.example',
      audit: { actor_user_id: 'user-1', source: 'community_edit' },
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('preserves an existing edge when an unrelated upsert omits house_domain', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT house_domain FROM brands')) {
        return { rows: [{ house_domain: 'house.example' }] };
      }
      if (sql.includes('INSERT INTO brands')) {
        return { rows: [brandRow('brand.example', 'house.example')] };
      }
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.upsertDiscoveredBrand({
      domain: 'brand.example',
      brand_name: 'Refreshed name',
      source_type: 'enriched',
    });

    const insert = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('INSERT INTO brands'),
    )!;
    expect((insert[1] as unknown[])[14]).toBe(false);
    expect(client.query.mock.calls.some(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    )).toBe(false);
  });

  it('audits an explicit clear and attributes it to the prior parent organization', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT house_domain FROM brands')) {
        return { rows: [{ house_domain: 'house.example' }] };
      }
      if (sql.includes('INSERT INTO brands')) {
        return { rows: [brandRow('brand.example', null)] };
      }
      if (sql.includes('FROM organization_domains')) {
        return { rows: [{ domain: 'house.example', workos_organization_id: 'org-house' }] };
      }
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.upsertDiscoveredBrand({
      domain: 'brand.example',
      house_domain: null,
      house_domain_audit: { actor_user_id: 'system:brand-classifier', source: 'classifier' },
      source_type: 'enriched',
    });

    const insert = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('INSERT INTO brands'),
    )!;
    expect((insert[1] as unknown[])[14]).toBe(true);
    const audit = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    )!;
    expect((audit[1] as unknown[]).slice(0, 3)).toEqual([
      'org-house',
      'system:brand-classifier',
      'brand.example',
    ]);
  });

  it('audits a non-null edge on first insert', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT house_domain FROM brands')) return { rows: [] };
      if (sql.includes('INSERT INTO brands')) {
        return { rows: [brandRow('brand.example', 'house.example')] };
      }
      if (sql.includes('FROM organization_domains')) return { rows: [] };
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.upsertDiscoveredBrand({
      domain: 'brand.example',
      house_domain: 'house.example',
      source_type: 'community',
    });

    const audit = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    );
    expect(audit).toBeDefined();
  });

  it('rolls back the brand write when the audit insert fails', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT house_domain FROM brands')) {
        return { rows: [{ house_domain: 'old-house.example' }] };
      }
      if (sql.includes('INSERT INTO brands')) {
        return { rows: [brandRow('brand.example', 'new-house.example')] };
      }
      if (sql.includes('FROM organization_domains')) return { rows: [] };
      if (sql.includes('registry_audit_log')) throw new Error('audit unavailable');
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await expect(db.upsertDiscoveredBrand({
      domain: 'brand.example',
      house_domain: 'new-house.example',
      source_type: 'enriched',
    })).rejects.toThrow('audit unavailable');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('attributes a community create to its editor and revision', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO brands')) {
        return { rows: [brandRow('brand.example', 'house.example')] };
      }
      if (sql.includes('FROM organization_domains')) return { rows: [] };
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.createDiscoveredBrand({
      domain: 'brand.example',
      house_domain: 'house.example',
      source_type: 'community',
    }, { user_id: 'community-editor' });

    const audit = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    )!;
    expect((audit[1] as unknown[])[1]).toBe('community-editor');
    expect(JSON.parse((audit[1] as unknown[])[3] as string)).toMatchObject({
      mutation_source: 'community_create',
      revision_number: 1,
    });
  });

  it('attributes a community edit and records its revision', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    const current = {
      ...brandRow('brand.example', 'old-house.example'),
      source_type: 'community',
      review_status: 'approved',
    };
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM brands')) return { rows: [current] };
      if (sql.includes('SELECT COALESCE(MAX(revision_number)')) return { rows: [{ next_rev: 3 }] };
      if (sql.startsWith('UPDATE brands SET')) {
        return { rows: [brandRow('brand.example', 'new-house.example')] };
      }
      if (sql.includes('FROM organization_domains')) return { rows: [] };
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.editDiscoveredBrand('brand.example', {
      house_domain: 'new-house.example',
      edit_summary: 'Correct parent',
      editor_user_id: 'community-editor',
    });

    const audit = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    )!;
    expect((audit[1] as unknown[])[1]).toBe('community-editor');
    expect(JSON.parse((audit[1] as unknown[])[3] as string)).toMatchObject({
      mutation_source: 'community_edit',
      revision_number: 3,
    });
  });

  it('records rollback provenance only when the restored edge changes', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    const current = {
      ...brandRow('brand.example', 'new-house.example'),
      source_type: 'community',
      review_status: 'approved',
    };
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT snapshot FROM brand_revisions')) {
        return { rows: [{ snapshot: { house_domain: 'old-house.example' } }] };
      }
      if (sql.includes('SELECT * FROM brands')) return { rows: [current] };
      if (sql.includes('SELECT COALESCE(MAX(revision_number)')) return { rows: [{ next_rev: 8 }] };
      if (sql.includes('UPDATE brands SET')) {
        return { rows: [brandRow('brand.example', 'old-house.example')] };
      }
      if (sql.includes('FROM organization_domains')) return { rows: [] };
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.rollbackBrand('brand.example', 4, { user_id: 'rollback-admin' });

    const audit = client.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    )!;
    expect((audit[1] as unknown[])[1]).toBe('rollback-admin');
    expect(JSON.parse((audit[1] as unknown[])[3] as string)).toMatchObject({
      mutation_source: 'rollback',
      revision_number: 8,
      rolled_back_to_revision: 4,
      prior_house_domain: 'new-house.example',
      new_house_domain: 'old-house.example',
    });
  });

  it('audits edge removal in the same transaction as a discovered-brand delete', async () => {
    const db = new BrandDatabase();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM brands')) {
        return { rows: [{ domain: 'brand.example', house_domain: 'house.example' }] };
      }
      if (sql.includes('FROM organization_domains')) return { rows: [] };
      return { rows: [] };
    });
    mocks.getClient.mockResolvedValueOnce(client);

    const deleted = await db.deleteDiscoveredBrand('brand.example', {
      actor_user_id: 'system:addie',
      source: 'addie_malicious_record_cleanup',
    });

    expect(deleted).toBe(true);
    const deleteIndex = client.query.mock.calls.findIndex(call =>
      typeof call[0] === 'string' && call[0].includes('DELETE FROM brands'),
    );
    const auditIndex = client.query.mock.calls.findIndex(call =>
      typeof call[0] === 'string' && call[0].includes('registry_audit_log'),
    );
    const commitIndex = client.query.mock.calls.findIndex(call => call[0] === 'COMMIT');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(deleteIndex);
    expect(commitIndex).toBeGreaterThan(auditIndex);
    const details = JSON.parse((client.query.mock.calls[auditIndex][1] as unknown[])[3] as string);
    expect(details).toMatchObject({
      prior_house_domain: 'house.example',
      new_house_domain: null,
      mutation_source: 'addie_malicious_record_cleanup',
    });
  });
});
