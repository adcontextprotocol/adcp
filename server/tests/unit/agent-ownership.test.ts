import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import {
  findOwnerOrgForUser,
  isOrgOwnerOfAgent,
  resolveOwnerOrgForUser,
} from '../../src/services/agent-ownership.js';

const queryMock = vi.mocked(query);

describe('agent-ownership', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  describe('findOwnerOrgForUser', () => {
    it('returns the org_id when the user owns the agent through some org', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ workos_organization_id: 'org_abc' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never);

      const result = await findOwnerOrgForUser('user_123', 'https://agent.example.com/mcp');
      expect(result).toBe('org_abc');
      expect(queryMock).toHaveBeenCalledOnce();
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('member_profiles mp');
      expect(sql).toContain('organization_memberships om');
      expect(params).toEqual([
        JSON.stringify([{ url: 'https://agent.example.com/mcp' }]),
        'user_123',
      ]);
    });

    it('returns null when the user is not a member of any owning org', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never);
      const result = await findOwnerOrgForUser('user_123', 'https://agent.example.com/mcp');
      expect(result).toBeNull();
    });

    it('returns null when the query throws', async () => {
      queryMock.mockRejectedValueOnce(new Error('connection refused'));
      const result = await findOwnerOrgForUser('user_123', 'https://agent.example.com/mcp');
      expect(result).toBeNull();
    });

    it('canonicalizes the lookup URL before matching stored member profile agents', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ workos_organization_id: 'org_abc' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never);

      const result = await findOwnerOrgForUser('user_123', 'HTTPS://Agent.Example.com/MCP///');

      expect(result).toBe('org_abc');
      const [, params] = queryMock.mock.calls[0];
      expect(params).toEqual([
        JSON.stringify([{ url: 'https://agent.example.com/mcp' }]),
        'user_123',
      ]);
    });
  });

  describe('isOrgOwnerOfAgent', () => {
    it('returns true when the specific org owns the agent for the user', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ '?column?': 1 }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never);
      const result = await isOrgOwnerOfAgent('org_abc', 'user_123', 'https://agent.example.com/mcp');
      expect(result).toBe(true);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('mp.workos_organization_id = $1');
      expect(params).toEqual([
        'org_abc',
        JSON.stringify([{ url: 'https://agent.example.com/mcp' }]),
        'user_123',
      ]);
    });

    it('returns false when the resolved org is not the owning org', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never);
      const result = await isOrgOwnerOfAgent('org_wrong', 'user_123', 'https://agent.example.com/mcp');
      expect(result).toBe(false);
    });

    it('returns false when the query throws', async () => {
      queryMock.mockRejectedValueOnce(new Error('query failed'));
      const result = await isOrgOwnerOfAgent('org_abc', 'user_123', 'https://agent.example.com/mcp');
      expect(result).toBe(false);
    });

    it('canonicalizes the lookup URL before confirming a specific owning org', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ '?column?': 1 }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never);

      const result = await isOrgOwnerOfAgent('org_abc', 'user_123', 'HTTPS://Agent.Example.com/MCP///');

      expect(result).toBe(true);
      const [, params] = queryMock.mock.calls[0];
      expect(params).toEqual([
        'org_abc',
        JSON.stringify([{ url: 'https://agent.example.com/mcp' }]),
        'user_123',
      ]);
    });
  });

  describe('resolveOwnerOrgForUser', () => {
    it('uses the explicitly requested owning organization', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] } as never);

      await expect(resolveOwnerOrgForUser(
        'user_123',
        'https://agent.example.com/mcp',
        'org_selected',
      )).resolves.toBe('org_selected');

      expect(queryMock.mock.calls[0]?.[1]).toEqual([
        'org_selected',
        JSON.stringify([{ url: 'https://agent.example.com/mcp' }]),
        'user_123',
      ]);
    });

    it('fails closed when the requested organization does not own the agent', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] } as never);

      await expect(resolveOwnerOrgForUser(
        'user_123',
        'https://agent.example.com/mcp',
        'org_wrong',
      )).resolves.toBeNull();

      expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('resolves a sole owner when no organization is requested', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_discovered' }] } as never);

      await expect(resolveOwnerOrgForUser(
        'user_123',
        'https://agent.example.com/mcp',
      )).resolves.toBe('org_discovered');
    });

    it('fails closed when an omitted organization has multiple owners', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          { workos_organization_id: 'org_a' },
          { workos_organization_id: 'org_b' },
        ],
      } as never);

      await expect(resolveOwnerOrgForUser(
        'user_123',
        'https://agent.example.com/mcp',
      )).resolves.toBeNull();

      expect(queryMock.mock.calls[0]?.[0]).toContain('SELECT DISTINCT');
      expect(queryMock.mock.calls[0]?.[0]).toContain('LIMIT 2');
    });
  });

  describe('semantic distinction between the two helpers', () => {
    it('findOwnerOrgForUser discovers ownership; isOrgOwnerOfAgent confirms a specific org', async () => {
      // Two distinct queries: findOwnerOrgForUser returns ANY owning org for
      // the user; isOrgOwnerOfAgent requires the named org to BE the owner.
      // The SQL shapes differ — registry-api.ts and member-tools.ts had
      // distinct inline copies of these (drift surface) before extraction.
      queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_a' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);
      await findOwnerOrgForUser('user_1', 'https://x/mcp');
      const [findSql, findParams] = queryMock.mock.calls[0];
      expect(findParams).toHaveLength(2);
      expect(findSql).not.toContain('mp.workos_organization_id = $1');

      queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);
      await isOrgOwnerOfAgent('org_a', 'user_1', 'https://x/mcp');
      const [isSql, isParams] = queryMock.mock.calls[1];
      expect(isParams).toHaveLength(3);
      expect(isSql).toContain('mp.workos_organization_id = $1');
    });
  });
});
