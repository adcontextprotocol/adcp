import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CrawlerService } from '../../src/crawler.js';
import { FederatedIndexService } from '../../src/federated-index.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';
const DOMAIN = `revalidate-${Date.now()}.registry-test.example`;
const OTHER_DOMAIN = `other-${Date.now()}.registry-test.example`;
const AGENT = 'https://sales-agent.example/mcp/storefront';
const STALE_AGENT = 'https://stale-agent.example/mcp';
const HOSTED_AGENT = 'https://hosted-agent.example/mcp';

const TEST_AGENTS = [AGENT, STALE_AGENT, HOSTED_AGENT];

function makeCrawler(validation: unknown) {
  const proto = CrawlerService.prototype as unknown as Record<string, unknown>;
  const ctx = Object.create(proto) as CrawlerService & Record<string, unknown>;
  Object.assign(ctx, {
    adAgentsManager: {
      validateDomain: vi.fn().mockResolvedValue(validation),
    },
    federatedIndex: new FederatedIndexService(),
    publisherDb: new PublisherDatabase(),
    eventsDb: undefined,
    fanOutPublisherPropertiesAuthorizations: vi.fn().mockResolvedValue(undefined),
    scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
    buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
  });
  return ctx;
}

async function cleanup(pool: Pool) {
  await pool.query(
    `DELETE FROM agent_property_authorizations apa
      USING discovered_properties dp
     WHERE apa.property_id = dp.id
       AND (dp.publisher_domain = ANY($1::text[]) OR apa.agent_url = ANY($2::text[]))`,
    [[DOMAIN, OTHER_DOMAIN], TEST_AGENTS],
  );
  await pool.query(
    `DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])`,
    [[DOMAIN, OTHER_DOMAIN]],
  );
  await pool.query(
    `DELETE FROM catalog_agent_authorizations
      WHERE publisher_domain = $1 OR agent_url = ANY($2::text[])`,
    [DOMAIN, TEST_AGENTS],
  );
  await pool.query(
    `DELETE FROM agent_publisher_authorizations
      WHERE publisher_domain = $1 OR agent_url = ANY($2::text[])`,
    [DOMAIN, TEST_AGENTS],
  );
  await pool.query(
    `DELETE FROM discovered_publishers
      WHERE domain = $1 OR discovered_by_agent = ANY($2::text[])`,
    [DOMAIN, TEST_AGENTS],
  );
  await pool.query(
    `DELETE FROM discovered_agents WHERE agent_url = ANY($1::text[])`,
    [TEST_AGENTS],
  );
  await pool.query(
    `DELETE FROM catalog_identifiers
      WHERE property_rid IN (
        SELECT property_rid FROM catalog_properties WHERE created_by = $1
      )`,
    [`adagents_json:${DOMAIN}`],
  );
  await pool.query(
    `DELETE FROM catalog_properties WHERE created_by = $1`,
    [`adagents_json:${DOMAIN}`],
  );
  await pool.query(`DELETE FROM publishers WHERE domain = ANY($1::text[])`, [[DOMAIN, OTHER_DOMAIN]]);
}

function buildLookupApp(federatedIndex: FederatedIndexService) {
  const app = express();
  app.use(express.json());

  const requireAuth: import('express').RequestHandler = (req, _res, next) => {
    req.user = { id: 'admin_user', email: 'admin@example.com', isAdmin: true } as typeof req.user;
    next();
  };

  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      getHostedBrandByDomain: vi.fn().mockResolvedValue(null),
    } as unknown as RegistryApiConfig['brandDb'],
    propertyDb: {
      getHostedPropertyByDomain: vi.fn().mockResolvedValue(null),
    } as unknown as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {
      getFederatedIndex: () => federatedIndex,
      crawlSingleDomain: vi.fn().mockResolvedValue(undefined),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
    } as unknown as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth,
    optionalAuth: requireAuth,
  }));

  return app;
}

describe('publisher adagents manual revalidation DB path', () => {
  let pool: Pool;
  let federatedIndex: FederatedIndexService;
  let lookupApp: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = initializeDatabase({ connectionString: TEST_DATABASE_URL });
    await runMigrations();
    federatedIndex = new FederatedIndexService();
    lookupApp = buildLookupApp(federatedIndex);
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  it('updates the lookupPublisher verdict from stale invalid to live valid', async () => {
    await federatedIndex.recordPublisherFromAgent(DOMAIN, STALE_AGENT, false);
    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(false);

    const crawler = makeCrawler({
      valid: true,
      errors: [],
      warnings: [],
      domain: DOMAIN,
      url: `https://${DOMAIN}/.well-known/adagents.json`,
      status_code: 200,
      response_bytes: 512,
      resolved_url: `https://${DOMAIN}/.well-known/adagents.json`,
      discovery_method: 'direct',
      raw_data: {
        authorized_agents: [{ url: AGENT, authorized_for: 'Direct storefront sales' }],
        properties: [
          {
            property_id: 'talpa-site',
            property_type: 'website',
            name: 'Example site',
            identifiers: [{ type: 'domain', value: DOMAIN }],
          },
        ],
      },
    });

    const result = await crawler.revalidatePublisherAdagents(DOMAIN, { force: true });

    expect(result).toMatchObject({
      domain: DOMAIN,
      adagents_valid: true,
      status_code: 200,
      properties_count: 1,
      authorized_agents_count: 1,
    });
    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(true);
    const authorizations = await federatedIndex.getAuthorizationsForDomain(DOMAIN);
    expect(authorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_url: AGENT,
        publisher_domain: DOMAIN,
        source: 'adagents_json',
      }),
    ]));
    const lookup = await request(lookupApp)
      .get('/api/registry/publisher')
      .query({ domain: DOMAIN });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({
      domain: DOMAIN,
      adagents_valid: true,
      files: {
        adagents_json: {
          status: 'valid',
        },
      },
    });
  });

  it('persists ads.txt managerdomain delegation with compact by_tag publisher_properties as authorized', async () => {
    const managerDomain = `manager.${DOMAIN}`;
    const crawler = makeCrawler({
      valid: true,
      errors: [],
      warnings: [
        {
          field: 'managerdomain',
          message: `No directly usable adagents.json at https://${DOMAIN}/.well-known/adagents.json; used ads.txt managerdomain ${managerDomain}`,
        },
      ],
      domain: DOMAIN,
      url: `https://${DOMAIN}/.well-known/adagents.json`,
      status_code: 200,
      response_bytes: 2048,
      resolved_url: `https://${managerDomain}/.well-known/adagents.json`,
      discovery_method: 'ads_txt_managerdomain',
      manager_domain: managerDomain,
      raw_data: {
        properties: [
          {
            property_id: 'managed-site',
            property_type: 'website',
            name: 'Managed site',
            identifiers: [{ type: 'domain', value: DOMAIN }],
            publisher_domain: DOMAIN,
            tags: ['raptive_managed'],
          },
          {
            property_id: 'other-site',
            property_type: 'website',
            name: 'Other site',
            identifiers: [{ type: 'subdomain', value: `other.${DOMAIN}` }],
            publisher_domain: DOMAIN,
            tags: ['other'],
          },
          {
            property_id: 'elsewhere-site',
            property_type: 'website',
            name: 'Elsewhere site',
            identifiers: [{ type: 'domain', value: OTHER_DOMAIN }],
            publisher_domain: OTHER_DOMAIN,
            tags: ['raptive_managed'],
          },
        ],
        authorized_agents: [
          {
            url: AGENT,
            authorized_for: 'Official sales agent for managed display inventory',
            authorization_type: 'publisher_properties',
            publisher_properties: [
              {
                publisher_domains: ['elsewhere.example', DOMAIN],
                selection_type: 'by_tag',
                property_tags: ['raptive_managed'],
              },
            ],
          },
        ],
      },
    });

    const result = await crawler.revalidatePublisherAdagents(DOMAIN, { force: true });

    expect(result).toMatchObject({
      domain: DOMAIN,
      adagents_valid: true,
      discovery_method: 'ads_txt_managerdomain',
      manager_domain: managerDomain,
      properties_count: 3,
      authorized_agents_count: 1,
    });

    const productAuth = await federatedIndex.validateAgentForProduct(AGENT, [
      {
        publisher_domain: DOMAIN,
        selection_type: 'by_tag',
        property_tags: ['raptive_managed'],
      },
    ]);
    expect(productAuth.authorized).toBe(true);
    expect(productAuth.total_requested).toBe(1);
    expect(productAuth.total_authorized).toBe(1);

    const otherDomainAuth = await federatedIndex.validateAgentForProduct(AGENT, [
      {
        publisher_domain: OTHER_DOMAIN,
        selection_type: 'by_tag',
        property_tags: ['raptive_managed'],
      },
    ]);
    expect(otherDomainAuth.authorized).toBe(false);
    expect(otherDomainAuth.total_requested).toBe(0);
    expect(otherDomainAuth.total_authorized).toBe(0);

    const lookup = await request(lookupApp)
      .get('/api/registry/publisher')
      .query({ domain: DOMAIN });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({
      domain: DOMAIN,
      adagents_valid: true,
      discovery_method: 'ads_txt_managerdomain',
      manager_domain: managerDomain,
      files: {
        adagents_json: {
          status: 'valid',
        },
      },
    });
    expect(lookup.body.properties.map((property: { id: string }) => property.id).sort()).toEqual([
      'managed-site',
      'other-site',
    ]);
    expect(lookup.body.authorized_agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: AGENT,
        source: 'adagents_json',
        properties_authorized: 1,
        properties_total: 2,
      }),
    ]));
  });

  it('persists invalid revalidation and retires stale adagents authorizations', async () => {
    const validCrawler = makeCrawler({
      valid: true,
      errors: [],
      warnings: [],
      domain: DOMAIN,
      url: `https://${DOMAIN}/.well-known/adagents.json`,
      status_code: 200,
      response_bytes: 512,
      resolved_url: `https://${DOMAIN}/.well-known/adagents.json`,
      discovery_method: 'direct',
      raw_data: {
        authorized_agents: [{ url: AGENT, authorized_for: 'Direct storefront sales' }],
        properties: [],
      },
    });
    await validCrawler.revalidatePublisherAdagents(DOMAIN);
    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(true);
    await federatedIndex.recordProperty({
      property_id: 'stale-site',
      publisher_domain: DOMAIN,
      property_type: 'website',
      name: 'Stale site',
      identifiers: [{ type: 'domain', value: DOMAIN }],
      tags: ['stale'],
    }, STALE_AGENT, 'Legacy stale authorization');
    const hostedProperty = await pool.query<{ id: string }>(
      `INSERT INTO discovered_properties
         (property_id, publisher_domain, property_type, name, identifiers, tags, source_type)
       VALUES ($1, $2, 'website', 'Hosted site', $3::jsonb, ARRAY['hosted']::text[], 'aao_hosted')
       RETURNING id`,
      [
        'hosted-site',
        DOMAIN,
        JSON.stringify([{ type: 'domain', value: `hosted.${DOMAIN}` }]),
      ],
    );
    await pool.query(
      `INSERT INTO agent_property_authorizations (agent_url, property_id, authorized_for)
       VALUES ($1, $2, 'Hosted authorization')`,
      [HOSTED_AGENT, hostedProperty.rows[0].id],
    );

    const staleLookup = await request(lookupApp)
      .get('/api/registry/publisher')
      .query({ domain: DOMAIN });
    expect(staleLookup.status).toBe(200);
    expect(staleLookup.body.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'stale-site',
        source: 'adagents_json',
      }),
    ]));
    expect(staleLookup.body.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'hosted-site',
        source: 'adagents_json',
      }),
    ]));

    const invalidCrawler = makeCrawler({
      valid: false,
      errors: [{ field: 'http_status', message: 'File not found', severity: 'error' }],
      warnings: [],
      domain: DOMAIN,
      url: `https://${DOMAIN}/.well-known/adagents.json`,
      status_code: 404,
      response_bytes: 32,
      resolved_url: `https://${DOMAIN}/.well-known/adagents.json`,
      discovery_method: 'direct',
    });

    const result = await invalidCrawler.revalidatePublisherAdagents(DOMAIN);

    expect(result).toMatchObject({
      domain: DOMAIN,
      adagents_valid: false,
      error: 'File not found',
      status_code: 404,
    });
    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(false);
    const lookup = await request(lookupApp)
      .get('/api/registry/publisher')
      .query({ domain: DOMAIN });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({
      domain: DOMAIN,
      adagents_valid: false,
      files: {
        adagents_json: {
          status: 'invalid',
        },
      },
    });
    expect(lookup.body.properties).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'stale-site',
        source: 'adagents_json',
      }),
    ]));
    expect(lookup.body.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'hosted-site',
        source: 'adagents_json',
      }),
    ]));
    const staleAgentProperties = await federatedIndex.getPropertiesForAgent(STALE_AGENT);
    expect(staleAgentProperties.filter((property) => property.publisher_domain === DOMAIN)).toHaveLength(0);
    const hostedAgentProperties = await federatedIndex.getPropertiesForAgent(HOSTED_AGENT);
    expect(hostedAgentProperties).toEqual(expect.arrayContaining([
      expect.objectContaining({
        publisher_domain: DOMAIN,
        property_id: 'hosted-site',
      }),
    ]));
    const authorizations = await federatedIndex.getAuthorizationsForDomain(DOMAIN);
    expect(authorizations.filter((auth) => auth.source === 'adagents_json')).toHaveLength(0);
    const publisher = await pool.query<{
      source_type: string;
      adagents_json: unknown;
      last_validation_error: string | null;
      last_http_status: number | null;
    }>(
      `SELECT source_type, adagents_json, last_validation_error, last_http_status
         FROM publishers WHERE domain = $1`,
      [DOMAIN],
    );
    expect(publisher.rows[0]).toMatchObject({
      source_type: 'community',
      adagents_json: null,
      last_validation_error: 'File not found',
      last_http_status: 404,
    });
  });

  it('records transient revalidation failures without retiring the cached authorization graph', async () => {
    const validCrawler = makeCrawler({
      valid: true,
      errors: [],
      warnings: [],
      domain: DOMAIN,
      url: `https://${DOMAIN}/.well-known/adagents.json`,
      status_code: 200,
      response_bytes: 512,
      resolved_url: `https://${DOMAIN}/.well-known/adagents.json`,
      discovery_method: 'direct',
      raw_data: {
        authorized_agents: [{ url: AGENT, authorized_for: 'Direct storefront sales' }],
        properties: [],
      },
    });
    await validCrawler.revalidatePublisherAdagents(DOMAIN);
    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(true);

    const transientCrawler = makeCrawler({
      valid: false,
      errors: [{ field: 'http_status', message: 'HTTP 503 error fetching adagents.json', severity: 'error' }],
      warnings: [],
      domain: DOMAIN,
      url: `https://${DOMAIN}/.well-known/adagents.json`,
      status_code: 503,
      response_bytes: 24,
      resolved_url: `https://${DOMAIN}/.well-known/adagents.json`,
      discovery_method: 'direct',
    });

    const result = await transientCrawler.revalidatePublisherAdagents(DOMAIN);

    expect(result).toMatchObject({
      domain: DOMAIN,
      adagents_valid: false,
      error: 'HTTP 503 error fetching adagents.json',
      status_code: 503,
    });
    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(true);
    const authorizations = await federatedIndex.getAuthorizationsForDomain(DOMAIN);
    expect(authorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_url: AGENT,
        publisher_domain: DOMAIN,
        source: 'adagents_json',
      }),
    ]));
    const lookup = await request(lookupApp)
      .get('/api/registry/publisher')
      .query({ domain: DOMAIN });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({
      domain: DOMAIN,
      adagents_valid: true,
      files: {
        adagents_json: {
          status: 'valid',
        },
      },
      hosting: {
        last_http_status: 503,
      },
    });
  });

  it('does not let routine failed-fetch metadata override legacy valid adagents state', async () => {
    await federatedIndex.recordPublisherFromAgent(DOMAIN, STALE_AGENT, true);
    await new PublisherDatabase().recordFailedAdagentsFetch({
      domain: DOMAIN,
      statusCode: 503,
      responseBytes: 24,
      resolvedUrl: `https://${DOMAIN}/.well-known/adagents.json`,
    });

    expect(await federatedIndex.hasValidAdagents(DOMAIN)).toBe(true);
  });
});
