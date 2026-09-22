import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  PublisherDatabase,
  type AdagentsAuthorizedAgent,
} from '../../src/db/publisher-db.js';

const PUBLISHER_DOMAIN = 'publisher-index.example';

interface AuthorizationProjector {
  projectAuthorizationToCatalog(
    client: PoolClient,
    publisherDomain: string,
    entry: AdagentsAuthorizedAgent,
  ): Promise<void>;
  projectPropertyToCatalog(
    client: PoolClient,
    publisherDomain: string,
    property: unknown,
  ): Promise<void>;
}

async function catalogResolverQueries(entry: AdagentsAuthorizedAgent): Promise<string[]> {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes('FROM catalog_properties')) {
        return {
          rows: [{ property_rid: '00000000-0000-0000-0000-000000000001', property_id: 'site' }],
        };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  const database = new PublisherDatabase() as unknown as AuthorizationProjector;
  database.projectPropertyToCatalog = vi.fn().mockResolvedValue(undefined);

  await database.projectAuthorizationToCatalog(client, PUBLISHER_DOMAIN, entry);
  return queries.filter((query) => query.includes('FROM catalog_properties'));
}

describe('PublisherDatabase adagents catalog resolver indexes', () => {
  it.each<[string, AdagentsAuthorizedAgent]>([
    ['property_ids', {
      url: 'https://agent.publisher-index.example',
      authorization_type: 'property_ids',
      property_ids: ['site'],
    }],
    ['inline_properties', {
      url: 'https://agent.publisher-index.example',
      authorization_type: 'inline_properties',
      properties: [{ property_id: 'site' }],
    }],
    ['publisher_properties all', {
      url: 'https://agent.publisher-index.example',
      authorization_type: 'publisher_properties',
      publisher_properties: [{
        publisher_domain: PUBLISHER_DOMAIN,
        selection_type: 'all',
      }],
    }],
    ['publisher_properties by_id', {
      url: 'https://agent.publisher-index.example',
      authorization_type: 'publisher_properties',
      publisher_properties: [{
        publisher_domain: PUBLISHER_DOMAIN,
        selection_type: 'by_id',
        property_ids: ['site'],
      }],
    }],
    ['publisher_properties by_tag', {
      url: 'https://agent.publisher-index.example',
      authorization_type: 'publisher_properties',
      publisher_properties: [{
        publisher_domain: PUBLISHER_DOMAIN,
        selection_type: 'by_tag',
        property_tags: ['news'],
      }],
    }],
  ])('keeps the partial-index predicate on the %s resolver', async (_name, entry) => {
    const queries = await catalogResolverQueries(entry);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(
      /(?:cp\.)?created_by LIKE 'adagents_json:%'/,
    );
  });
});
