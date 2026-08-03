import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedQuery } = vi.hoisted(() => ({
  mockedQuery: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mockedQuery,
}));

import { observeBrandRelationshipDeclaration } from '../../src/db/brand-relationship-db.js';

describe('brand relationship declaration persistence', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it('atomically retains first observation when effective_at is absent', async () => {
    const firstObserved = new Date('2026-01-01T00:00:00Z');
    mockedQuery.mockResolvedValue({ rows: [{ declared_at: firstObserved }] });

    await expect(observeBrandRelationshipDeclaration({
      houseDomain: 'House.Example',
      leafDomain: 'Leaf.Example',
      brandId: 'leaf',
    })).resolves.toBe(firstObserved.getTime());

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (house_domain, leaf_domain, brand_id) DO UPDATE'),
      ['house.example', 'leaf.example', 'leaf', null],
    );
    expect(mockedQuery.mock.calls[0][0]).toContain(
      'THEN brand_relationship_declarations.declared_at',
    );
  });

  it('passes an explicit publisher declaration to shared storage', async () => {
    const effectiveAt = '2026-02-01T00:00:00Z';
    mockedQuery.mockResolvedValue({ rows: [{ declared_at: effectiveAt }] });

    await observeBrandRelationshipDeclaration({
      houseDomain: 'house.example',
      leafDomain: 'leaf.example',
      brandId: 'leaf',
      effectiveAt,
    });

    expect(mockedQuery.mock.calls[0][1]).toEqual([
      'house.example',
      'leaf.example',
      'leaf',
      effectiveAt,
    ]);
  });
});
