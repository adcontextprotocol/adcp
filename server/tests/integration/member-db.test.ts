import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import type { Pool } from 'pg';
import type { CreateMemberProfileInput, UpdateMemberProfileInput } from '../../src/types.js';

const TEST_ORG_PREFIX = 'org_member_db_test';

describe('MemberDatabase Integration Tests', () => {
  let pool: Pool;
  let memberDb: MemberDatabase;

  // Helper to create a unique org ID for each test
  const createTestOrgId = (suffix: string) => `${TEST_ORG_PREFIX}_${suffix}`;

  // Helper to create parent organization (required for FK constraint)
  const createTestOrg = async (orgId: string, name: string = 'Test Org') => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, name]
    );
  };

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });

    // Run migrations
    await runMigrations();

    memberDb = new MemberDatabase();
  });

  afterAll(async () => {
    // Clean up all test data (profiles first due to FK)
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean up test data before each test (profiles first due to FK)
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
  });

  describe('createProfile', () => {
    it('should create a profile with all fields', async () => {
      const orgId = createTestOrgId('full');
      await createTestOrg(orgId, 'Full Test Company');

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Test Company',
        slug: 'test-company',
        tagline: 'A test company',
        description: 'This is a test company for integration testing',
        logo_url: 'https://example.com/logo.png',
        logo_light_url: 'https://example.com/logo-light.png',
        logo_dark_url: 'https://example.com/logo-dark.png',
        brand_color: '#FF5733',
        contact_email: 'test@example.com',
        contact_website: 'https://example.com',
        contact_phone: '+1-555-555-5555',
        linkedin_url: 'https://linkedin.com/company/test',
        twitter_url: 'https://twitter.com/test',
        offerings: ['buyer_agent', 'creative_agent'],
        agents: [
          { url: 'https://agent1.example.com', is_public: true },
          { url: 'https://agent2.example.com', is_public: false },
        ],
        headquarters: 'New York, USA',
        markets: ['North America', 'Europe'],
        metadata: { custom_field: 'custom_value' },
        tags: ['adtech', 'ai'],
        is_public: true,
        show_in_carousel: true,
      };

      const profile = await memberDb.createProfile(input);

      expect(profile.id).toBeDefined();
      expect(profile.workos_organization_id).toBe(orgId);
      expect(profile.display_name).toBe('Test Company');
      expect(profile.slug).toBe('test-company');
      expect(profile.tagline).toBe('A test company');
      expect(profile.description).toBe('This is a test company for integration testing');
      expect(profile.logo_url).toBe('https://example.com/logo.png');
      expect(profile.logo_light_url).toBe('https://example.com/logo-light.png');
      expect(profile.logo_dark_url).toBe('https://example.com/logo-dark.png');
      expect(profile.brand_color).toBe('#FF5733');
      expect(profile.contact_email).toBe('test@example.com');
      expect(profile.contact_website).toBe('https://example.com');
      expect(profile.contact_phone).toBe('+1-555-555-5555');
      expect(profile.linkedin_url).toBe('https://linkedin.com/company/test');
      expect(profile.twitter_url).toBe('https://twitter.com/test');
      expect(profile.offerings).toEqual(['buyer_agent', 'creative_agent']);
      expect(profile.agents).toHaveLength(2);
      expect(profile.agents[0]).toEqual({ url: 'https://agent1.example.com', is_public: true });
      expect(profile.agents[1]).toEqual({ url: 'https://agent2.example.com', is_public: false });
      expect(profile.headquarters).toBe('New York, USA');
      expect(profile.markets).toEqual(['North America', 'Europe']);
      expect(profile.metadata).toEqual({ custom_field: 'custom_value' });
      expect(profile.tags).toEqual(['adtech', 'ai']);
      expect(profile.is_public).toBe(true);
      expect(profile.show_in_carousel).toBe(true);
    });

    it('should create a profile with minimal fields', async () => {
      const orgId = createTestOrgId('minimal');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Minimal Company',
        slug: 'minimal-company',
      };

      const profile = await memberDb.createProfile(input);

      expect(profile.id).toBeDefined();
      expect(profile.display_name).toBe('Minimal Company');
      expect(profile.slug).toBe('minimal-company');
      expect(profile.agents).toEqual([]);
      expect(profile.offerings).toEqual([]);
      expect(profile.markets).toEqual([]);
      expect(profile.tags).toEqual([]);
      expect(profile.is_public).toBe(false);
      expect(profile.show_in_carousel).toBe(false);
    });

    it('should create a profile with empty agents array', async () => {
      const orgId = createTestOrgId('empty_agents');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'No Agents Company',
        slug: 'no-agents-company',
        agents: [],
      };

      const profile = await memberDb.createProfile(input);

      expect(profile.agents).toEqual([]);
    });
  });

  describe('getProfileById', () => {
    it('should retrieve a profile by ID', async () => {
      const orgId = createTestOrgId('get_by_id');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Get By ID Company',
        slug: 'get-by-id-company',
        agents: [{ url: 'https://agent.example.com', is_public: true }],
      };

      const created = await memberDb.createProfile(input);
      const retrieved = await memberDb.getProfileById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.display_name).toBe('Get By ID Company');
      expect(retrieved!.agents).toEqual([{ url: 'https://agent.example.com', is_public: true }]);
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await memberDb.getProfileById('00000000-0000-0000-0000-000000000000');
      expect(retrieved).toBeNull();
    });
  });

  describe('getProfileBySlug', () => {
    it('should retrieve a profile by slug', async () => {
      const orgId = createTestOrgId('get_by_slug');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Get By Slug Company',
        slug: 'get-by-slug-company',
      };

      await memberDb.createProfile(input);
      const retrieved = await memberDb.getProfileBySlug('get-by-slug-company');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.display_name).toBe('Get By Slug Company');
    });

    it('should return null for non-existent slug', async () => {
      const retrieved = await memberDb.getProfileBySlug('non-existent-slug');
      expect(retrieved).toBeNull();
    });
  });

  describe('getProfileByOrgId', () => {
    it('should retrieve a profile by organization ID', async () => {
      const orgId = createTestOrgId('get_by_org');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Get By Org Company',
        slug: 'get-by-org-company',
      };

      await memberDb.createProfile(input);
      const retrieved = await memberDb.getProfileByOrgId(orgId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.display_name).toBe('Get By Org Company');
    });
  });

  describe('updateProfile', () => {
    it('should update profile fields', async () => {
      const orgId = createTestOrgId('update');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Original Name',
        slug: 'update-company',
        agents: [{ url: 'https://old-agent.example.com', is_public: true }],
      };

      const created = await memberDb.createProfile(input);

      const updates: UpdateMemberProfileInput = {
        display_name: 'Updated Name',
        tagline: 'New tagline',
        agents: [
          { url: 'https://new-agent.example.com', is_public: false },
          { url: 'https://another-agent.example.com', is_public: true },
        ],
      };

      const updated = await memberDb.updateProfile(created.id, updates);

      expect(updated).not.toBeNull();
      expect(updated!.display_name).toBe('Updated Name');
      expect(updated!.tagline).toBe('New tagline');
      expect(updated!.agents).toHaveLength(2);
      expect(updated!.agents[0]).toEqual({ url: 'https://new-agent.example.com', is_public: false });
    });

    it('should update metadata correctly', async () => {
      const orgId = createTestOrgId('update_metadata');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Metadata Company',
        slug: 'metadata-company',
        metadata: { original: 'value' },
      };

      const created = await memberDb.createProfile(input);

      const updates: UpdateMemberProfileInput = {
        metadata: { new_field: 'new_value', another: 123 },
      };

      const updated = await memberDb.updateProfile(created.id, updates);

      expect(updated!.metadata).toEqual({ new_field: 'new_value', another: 123 });
    });

    it('should return null for non-existent profile', async () => {
      const updated = await memberDb.updateProfile('00000000-0000-0000-0000-000000000000', {
        display_name: 'New Name',
      });
      expect(updated).toBeNull();
    });
  });

  describe('updateProfileByOrgId', () => {
    it('should update profile by organization ID', async () => {
      const orgId = createTestOrgId('update_by_org');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Original Org Name',
        slug: 'update-by-org-company',
      };

      await memberDb.createProfile(input);

      const updated = await memberDb.updateProfileByOrgId(orgId, {
        display_name: 'Updated Org Name',
      });

      expect(updated).not.toBeNull();
      expect(updated!.display_name).toBe('Updated Org Name');
    });
  });

  describe('deleteProfile', () => {
    it('should delete a profile', async () => {
      const orgId = createTestOrgId('delete');
      await createTestOrg(orgId);

      const input: CreateMemberProfileInput = {
        workos_organization_id: orgId,
        display_name: 'Delete Company',
        slug: 'delete-company',
      };

      const created = await memberDb.createProfile(input);
      const deleted = await memberDb.deleteProfile(created.id);

      expect(deleted).toBe(true);

      const retrieved = await memberDb.getProfileById(created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for non-existent profile', async () => {
      const deleted = await memberDb.deleteProfile('00000000-0000-0000-0000-000000000000');
      expect(deleted).toBe(false);
    });
  });

  describe('listProfiles', () => {
    beforeEach(async () => {
      // Create parent organizations for test profiles
      const org1 = createTestOrgId('list_1');
      const org2 = createTestOrgId('list_2');
      const org3 = createTestOrgId('list_3');
      await createTestOrg(org1, 'Alpha Parent');
      await createTestOrg(org2, 'Beta Parent');
      await createTestOrg(org3, 'Gamma Parent');

      // Create multiple test profiles
      await memberDb.createProfile({
        workos_organization_id: org1,
        display_name: 'Alpha Company',
        slug: 'alpha-company',
        is_public: true,
        show_in_carousel: true,
        offerings: ['buyer_agent'],
        markets: ['North America'],
      });

      await memberDb.createProfile({
        workos_organization_id: org2,
        display_name: 'Beta Company',
        slug: 'beta-company',
        is_public: true,
        show_in_carousel: false,
        offerings: ['creative_agent'],
        markets: ['Europe'],
      });

      await memberDb.createProfile({
        workos_organization_id: org3,
        display_name: 'Gamma Company',
        slug: 'gamma-company',
        is_public: false,
        show_in_carousel: false,
        offerings: ['buyer_agent', 'creative_agent'],
        markets: ['North America', 'Europe'],
      });
    });

    it('should list all profiles', async () => {
      const profiles = await memberDb.listProfiles();
      expect(profiles.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by is_public', async () => {
      const publicProfiles = await memberDb.listProfiles({ is_public: true });
      expect(publicProfiles.every(p => p.is_public)).toBe(true);
    });

    it('should filter by show_in_carousel', async () => {
      const carouselProfiles = await memberDb.listProfiles({ show_in_carousel: true });
      expect(carouselProfiles.every(p => p.show_in_carousel)).toBe(true);
    });

    it('should filter by offerings', async () => {
      const buyerProfiles = await memberDb.listProfiles({ offerings: ['buyer_agent'] });
      expect(buyerProfiles.every(p => p.offerings.includes('buyer_agent'))).toBe(true);
    });

    it('should filter by markets', async () => {
      const europeProfiles = await memberDb.listProfiles({ markets: ['Europe'] });
      expect(europeProfiles.every(p => p.markets.includes('Europe'))).toBe(true);
    });

    it('should support search', async () => {
      const results = await memberDb.listProfiles({ search: 'Alpha' });
      expect(results.some(p => p.display_name === 'Alpha Company')).toBe(true);
    });

    it('should support limit', async () => {
      const limited = await memberDb.listProfiles({ limit: 1 });
      expect(limited.length).toBe(1);
    });
  });

  describe('isSlugAvailable', () => {
    it('should return true for available slug', async () => {
      const available = await memberDb.isSlugAvailable('unique-new-slug');
      expect(available).toBe(true);
    });

    it('should return false for taken slug', async () => {
      const orgId = createTestOrgId('slug_check');
      await createTestOrg(orgId);

      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'Slug Check Company',
        slug: 'taken-slug',
      });

      const available = await memberDb.isSlugAvailable('taken-slug');
      expect(available).toBe(false);
    });

    it('should exclude specific ID when checking', async () => {
      const orgId = createTestOrgId('slug_exclude');
      await createTestOrg(orgId);

      const created = await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'Exclude Check Company',
        slug: 'exclude-check-slug',
      });

      // Slug should be available when excluding the profile that has it
      const available = await memberDb.isSlugAvailable('exclude-check-slug', created.id);
      expect(available).toBe(true);

      // But not available when not excluding
      const notAvailable = await memberDb.isSlugAvailable('exclude-check-slug');
      expect(notAvailable).toBe(false);
    });
  });
});
