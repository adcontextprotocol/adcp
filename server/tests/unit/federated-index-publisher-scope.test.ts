import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  queryWithTimeout: vi.fn(),
}));

import { query, queryWithTimeout } from '../../src/db/client.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';

const mockedQuery = vi.mocked(queryWithTimeout);
// The spec-exact resolver runs first on its own connection: it reads the raw
// agent_url spellings under the identity key so the directory answers
// authorization questions exactly (#7829/#7830).
const mockedSpecExact = vi.mocked(query);
const result = <T>(rows: T[]) => ({
  rows,
  rowCount: rows.length,
  command: '',
  oid: 0,
  fields: [],
});

describe('FederatedIndexDatabase publisher-scoped agent properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpecExact.mockResolvedValue(
      result([{ agent_url: 'https://network-agent.example' },
              { agent_url: 'https://sales-agent.example' }]) as never);
  });

  it('pushes both the high-fanout agent and publisher into every query arm', async () => {
    mockedQuery.mockResolvedValueOnce(result([{
      id: 'property-rid',
      property_id: 'site',
      publisher_domain: 'publisher.example',
      property_type: 'website',
      name: 'Example Publisher',
      identifiers: [{ type: 'domain', value: 'publisher.example' }],
      tags: ['all'],
    }]));

    const db = new FederatedIndexDatabase();
    const properties = await db.getPropertiesForAgentDomain(
      'https://network-agent.example',
      'HTTPS://PUBLISHER.EXAMPLE/',
    );

    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({
      publisher_domain: 'publisher.example',
      property_id: 'site',
    });

    const [sql, params, timeoutMs] = mockedQuery.mock.calls[0];
    expect(sql).toContain('p.publisher_domain = $2');
    expect(sql).toContain('pub.domain = $2');
    expect(sql).toContain('v.publisher_domain = $2');
    // $3 is the app-computed registry key for the agent; SQL no longer
    // canonicalizes agent URLs (#7830). $4 narrows to the raw spellings
    // that are spec-exactly this agent (#7829).
    expect(sql).toContain('v.agent_url_canonical = $3');
    expect(sql).toContain('v.agent_url = ANY($4::text[])');
    expect(params).toEqual([
      'https://network-agent.example',
      'publisher.example',
      'https://network-agent.example',
      ['https://network-agent.example'],
    ]);
    expect(timeoutMs).toBe(5_000);
  });

  it('returns an unaffected publisher without expanding unrelated agent data', async () => {
    mockedQuery.mockResolvedValueOnce(result([]));

    const db = new FederatedIndexDatabase();
    await expect(db.getPropertiesForAgentDomain(
      'https://sales-agent.example',
      'control-publisher.example',
    )).resolves.toEqual([]);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    expect(mockedQuery.mock.calls[0][1]).toEqual([
      'https://sales-agent.example',
      'control-publisher.example',
      'https://sales-agent.example',
      ['https://sales-agent.example'],
    ]);
  });
});
