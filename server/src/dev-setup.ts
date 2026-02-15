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
          devUser.isMember ? 'org_dev_company_001' : null,
        ]
      );
    } catch (error) {
      logger.debug({ userId: devUser.id, key }, 'Dev user seed skipped');
    }
  }
}
