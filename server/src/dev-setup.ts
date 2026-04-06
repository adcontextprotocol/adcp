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
  await seedDevMemberships();
  await seedDevMemberProfiles();
  await seedDevHierarchyData(orgDb);
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
    {
      id: 'org_dev_builder_001',
      name: 'Acme Ad Tech',
      is_personal: false,
      company_type: 'adtech' as const,
      revenue_tier: '5m_50m' as const,
      membership_tier: 'company_standard' as const,
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
          membership_tier: (devOrg as any).membership_tier || undefined,
        });
        logger.info({ orgId: devOrg.id, name: devOrg.name }, 'Created dev organization');
      } else if ((devOrg as any).membership_tier) {
        // Ensure tier and subscription status are set for paid dev orgs
        const pool = getPool();
        await pool.query(
          `UPDATE organizations SET membership_tier = $1, subscription_status = 'active'
           WHERE workos_organization_id = $2 AND (membership_tier IS DISTINCT FROM $1 OR subscription_status IS DISTINCT FROM 'active')`,
          [(devOrg as any).membership_tier, devOrg.id]
        );
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
    {
      orgId: 'org_dev_builder_001',
      displayName: 'Acme Ad Tech',
      slug: 'acme-ad-tech',
      tagline: 'Agentic media buying for mid-market brands',
      description: 'Acme builds buyer and seller agents for programmatic advertising. Builder-tier member with active team and compliance monitoring.',
      offerings: '{buyer_agent,seller_agent,consulting}',
      agents: JSON.stringify([
        { url: 'https://buyer.acme-adtech.dev', name: 'Acme Buyer Agent', type: 'buyer', is_public: true },
        { url: 'https://seller.acme-adtech.dev', name: 'Acme Seller Agent', type: 'seller', is_public: true },
      ]),
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

/**
 * Seed sample corporate hierarchy data for testing the hierarchy UI.
 * Creates a holding company (Omnicom Group) with subsidiaries connected
 * via the brand registry's house_domain field.
 */
async function seedDevHierarchyData(orgDb: OrganizationDatabase): Promise<void> {
  const pool = getPool();

  // Holding company + subsidiaries
  const hierarchyOrgs = [
    { id: 'org_dev_omnicom_parent', name: 'Omnicom Group', domain: 'omc.com', company_type: 'brand' as const },
    { id: 'org_dev_omnicom_ddb', name: 'DDB Worldwide', domain: 'ddb.com', company_type: 'agency' as const },
    { id: 'org_dev_omnicom_bbdo', name: 'BBDO', domain: 'bbdo.com', company_type: 'agency' as const },
    { id: 'org_dev_omnicom_assembly', name: 'Assembly (Omnicom)', domain: 'assemblymarketing.com', company_type: 'agency' as const },
    { id: 'org_dev_omnicom_hearts', name: 'Hearts & Science', domain: 'hearts-science.com', company_type: 'agency' as const },
    // Standalone org for merge testing
    { id: 'org_dev_omnicom_dupe', name: 'Omnicom', domain: 'omnicomgroup.com', company_type: 'brand' as const },
    // Second holding company
    { id: 'org_dev_ipg_parent', name: 'Interpublic Group (IPG)', domain: 'interpublic.com', company_type: 'brand' as const },
    { id: 'org_dev_ipg_mediabrands', name: 'IPG Mediabrands', domain: 'ipgmediabrands.com', company_type: 'agency' as const },
    { id: 'org_dev_ipg_um', name: 'UM Worldwide', domain: 'umww.com', company_type: 'agency' as const },
  ];

  for (const org of hierarchyOrgs) {
    try {
      const existing = await orgDb.getOrganization(org.id);
      if (!existing) {
        await orgDb.createOrganization({
          workos_organization_id: org.id,
          name: org.name,
          is_personal: false,
          company_type: org.company_type,
        });
        // Set email_domain so hierarchy JOINs work
        await pool.query(
          `UPDATE organizations SET email_domain = $1 WHERE workos_organization_id = $2`,
          [org.domain, org.id]
        );
        logger.info({ orgId: org.id, name: org.name }, 'Created hierarchy test org');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('duplicate key')) {
        logger.debug({ orgId: org.id }, 'Hierarchy org already exists');
      } else {
        logger.error({ err: error, orgId: org.id }, 'Failed to seed hierarchy org');
      }
    }
  }

  // Brand registry entries connecting subsidiaries to parent via house_domain
  const brandEntries = [
    // Parent brands (no house_domain = top-level)
    { domain: 'omc.com', brand_name: 'Omnicom Group', house_domain: null, keller_type: 'master' },
    { domain: 'interpublic.com', brand_name: 'Interpublic Group', house_domain: null, keller_type: 'master' },
    // Omnicom subsidiaries → omc.com
    { domain: 'ddb.com', brand_name: 'DDB Worldwide', house_domain: 'omc.com', keller_type: 'endorsed' },
    { domain: 'bbdo.com', brand_name: 'BBDO', house_domain: 'omc.com', keller_type: 'endorsed' },
    { domain: 'assemblymarketing.com', brand_name: 'Assembly', house_domain: 'omc.com', keller_type: 'sub-brand' },
    { domain: 'hearts-science.com', brand_name: 'Hearts & Science', house_domain: 'omc.com', keller_type: 'sub-brand' },
    // Duplicate Omnicom domain → also points to omc.com
    { domain: 'omnicomgroup.com', brand_name: 'Omnicom Group', house_domain: 'omc.com', keller_type: 'endorsed' },
    // IPG subsidiaries → interpublic.com
    { domain: 'ipgmediabrands.com', brand_name: 'IPG Mediabrands', house_domain: 'interpublic.com', keller_type: 'sub-brand' },
    { domain: 'umww.com', brand_name: 'UM Worldwide', house_domain: 'interpublic.com', keller_type: 'sub-brand' },
  ];

  for (const entry of brandEntries) {
    try {
      await pool.query(
        `INSERT INTO discovered_brands (domain, brand_name, house_domain, keller_type, source_type)
         VALUES ($1, $2, $3, $4, 'community')
         ON CONFLICT (domain) DO UPDATE SET
           house_domain = COALESCE(EXCLUDED.house_domain, discovered_brands.house_domain),
           keller_type = COALESCE(EXCLUDED.keller_type, discovered_brands.keller_type)`,
        [entry.domain, entry.brand_name, entry.house_domain, entry.keller_type]
      );
    } catch (error) {
      logger.debug({ domain: entry.domain }, 'Brand registry entry already exists');
    }
  }

  logger.info('Seeded hierarchy test data (Omnicom Group + IPG corporate families)');
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

async function seedDevMemberships(): Promise<void> {
  const pool = getPool();
  const memberships = [
    // Admin user in their default org
    { userId: 'user_dev_admin_001', orgId: 'org_dev_company_001', membershipId: 'mem_dev_admin_001', email: 'admin@test.local', firstName: 'Admin', lastName: 'Tester', role: 'owner' },
    // Admin user in IPG hierarchy org
    { userId: 'user_dev_admin_001', orgId: 'org_dev_ipg_um', membershipId: 'mem_dev_admin_ipg', email: 'admin@test.local', firstName: 'Admin', lastName: 'Tester', role: 'owner' },
    // Member user
    { userId: 'user_dev_member_001', orgId: 'org_dev_company_001', membershipId: 'mem_dev_member_001', email: 'member@test.local', firstName: 'Member', lastName: 'User', role: 'member' },
    // Builder user (paid tier org)
    { userId: 'user_dev_builder_001', orgId: 'org_dev_builder_001', membershipId: 'mem_dev_builder_001', email: 'builder@test.local', firstName: 'Builder', lastName: 'Member', role: 'owner' },
    // Extra team members for the builder org (to show team dynamics)
    { userId: 'user_dev_learner_001', orgId: 'org_dev_builder_001', membershipId: 'mem_dev_learner1_builder', email: 'learner1@test.local', firstName: 'Learner', lastName: 'One', role: 'member' },
    { userId: 'user_dev_learner_002', orgId: 'org_dev_builder_001', membershipId: 'mem_dev_learner2_builder', email: 'learner2@test.local', firstName: 'Learner', lastName: 'Two', role: 'member' },
  ];

  for (const m of memberships) {
    try {
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, first_name, last_name, role, seat_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'contributor')
         ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
        [m.userId, m.orgId, m.membershipId, m.email, m.firstName, m.lastName, m.role]
      );
    } catch (error) {
      logger.debug({ userId: m.userId, orgId: m.orgId }, 'Dev membership seed skipped');
    }
  }
  logger.info('Seeded dev organization memberships');
}
