import { createLogger } from "./logger.js";
import { getPool } from "./db/client.js";
import { OrganizationDatabase } from "./db/organization-db.js";
import { DEV_USERS } from "./middleware/auth.js";

const logger = createLogger("dev-setup");

/**
 * Seed dev organizations and users for local development.
 * Called during server startup when dev mode is enabled.
 */
export async function seedDevData(orgDb: OrganizationDatabase): Promise<void> {
  await seedDevOrganizations(orgDb);
  await seedDevUsers();
  await seedDevMemberProfiles();
}

async function seedDevOrganizations(orgDb: OrganizationDatabase): Promise<void> {
  const devOrgs = [
    {
      id: 'org_dev_company_001',
      name: 'Dev Company (Member)',
      is_personal: false,
      company_type: 'brand' as const,
      revenue_tier: '5m_50m' as const,
    },
    {
      id: 'org_dev_personal_001',
      name: 'Dev Personal Workspace',
      is_personal: true,
      company_type: null,
      revenue_tier: null,
    },
  ];

  for (const devOrg of devOrgs) {
    try {
      const existing = await orgDb.getOrganization(devOrg.id);
      if (!existing) {
        await orgDb.createOrganization({
          workos_organization_id: devOrg.id,
          name: devOrg.name,
          is_personal: devOrg.is_personal,
          company_type: devOrg.company_type || undefined,
          revenue_tier: devOrg.revenue_tier || undefined,
        });
        logger.info({ orgId: devOrg.id, name: devOrg.name }, 'Created dev organization');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('duplicate key')) {
        logger.debug({ orgId: devOrg.id }, 'Dev organization already exists');
      } else {
        throw error;
      }
    }
  }
}

async function seedDevMemberProfiles(): Promise<void> {
  const pool = getPool();
  const profiles = [
    {
      orgId: 'org_dev_company_001',
      displayName: 'Dev Company',
      slug: 'dev-company',
      tagline: 'Dev company for testing member features',
      description: 'A company account for testing agents, publishers, and member dashboard features.',
      offerings: '{buyer_agent,sales_agent}',
      agents: JSON.stringify([{ url: 'https://test-agent.adcontextprotocol.org', name: 'Training Agent', type: 'sales', is_public: true }]),
      isPublic: true,
    },
    {
      orgId: 'org_dev_personal_001',
      displayName: 'Personal Account',
      slug: 'dev-personal',
      tagline: 'Dev personal account for testing',
      description: 'A personal account for testing portrait generation and offerings.',
      offerings: '{consulting}',
      agents: JSON.stringify([]),
      isPublic: true,
    },
  ];

  for (const p of profiles) {
    try {
      await pool.query(
        `INSERT INTO member_profiles (
          workos_organization_id, display_name, slug, tagline, description,
          offerings, agents, is_public
        ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8)
        ON CONFLICT (workos_organization_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          tagline = EXCLUDED.tagline,
          description = EXCLUDED.description,
          offerings = EXCLUDED.offerings,
          agents = EXCLUDED.agents,
          is_public = EXCLUDED.is_public`,
        [p.orgId, p.displayName, p.slug, p.tagline, p.description, p.offerings, p.agents, p.isPublic],
      );
      logger.info({ orgId: p.orgId }, 'Seeded dev member profile');
    } catch (error) {
      logger.error({ err: error, orgId: p.orgId }, 'Failed to seed dev member profile');
    }
  }
}

async function seedDevUsers(): Promise<void> {
  const pool = getPool();
  for (const [key, devUser] of Object.entries(DEV_USERS)) {
    try {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, primary_organization_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workos_user_id) DO NOTHING`,
        [
          devUser.id,
          devUser.email,
          devUser.firstName,
          devUser.lastName,
          devUser.isMember ? (devUser.organizationId || 'org_dev_company_001') : null,
        ]
      );
    } catch (error) {
      logger.debug({ userId: devUser.id, key }, 'Dev user seed skipped');
    }
  }
}
