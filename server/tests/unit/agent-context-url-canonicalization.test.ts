import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';

const queryMock = vi.mocked(query);
const ORG = 'org_loopme';
const VARIANT = ' HTTPS://PLATFORM.LOOPME.AI/MCP/SELLER/// ';
const CANONICAL = 'https://platform.loopme.ai/mcp/seller';

describe('AgentContextDatabase URL canonicalization', () => {
  const db = new AgentContextDatabase();

  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('canonicalizes every organization-and-URL read at the database boundary', async () => {
    await db.getByOrgAndUrl(ORG, VARIANT);
    await db.getAuthInfoByOrgAndUrl(ORG, VARIANT);
    await db.getOAuthTokensByOrgAndUrl(ORG, VARIANT);
    await db.getOAuthClientCredentialsByOrgAndUrl(ORG, VARIANT);
    await db.findOrgWithSavedAuth(VARIANT);

    expect(queryMock).toHaveBeenCalledTimes(5);
    for (const call of queryMock.mock.calls.slice(0, 4)) {
      expect(call[1]).toEqual([ORG, CANONICAL]);
    }
    expect(queryMock.mock.calls[4][1]).toEqual([CANONICAL]);
  });

  it('canonicalizes create and URL updates', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'ctx_created', agent_url: CANONICAL }] } as never);
    await db.create({ organization_id: ORG, agent_url: VARIANT });
    expect(queryMock.mock.calls[0][1]?.[1]).toBe(CANONICAL);

    queryMock.mockResolvedValueOnce({ rows: [{ id: 'ctx_created', agent_url: CANONICAL }] } as never);
    await db.update('ctx_created', { agent_url: VARIANT });
    expect(queryMock.mock.calls[1][1]).toEqual([CANONICAL, 'ctx_created']);
  });

  it('rejects an invalid URL key instead of writing an unmatchable context', async () => {
    await expect(db.create({ organization_id: ORG, agent_url: '   ' })).rejects.toThrow('Invalid agent URL');
    expect(queryMock).not.toHaveBeenCalled();
  });
});
