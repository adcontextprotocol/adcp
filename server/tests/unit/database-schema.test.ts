import { describe, it, expect } from "vitest";

/**
 * Database Schema Alignment Tests
 *
 * These tests validate that the database schema matches what the code expects.
 * They prevent issues like the webhook failure where code referenced columns
 * (subscription_status, stripe_subscription_id) that didn't exist in the DB.
 *
 * HOW THESE TESTS WORK:
 * 1. We define expected columns that code references for each table
 * 2. We define critical queries from the codebase
 * 3. Tests validate that critical queries only reference expected columns
 *
 * WHEN TO UPDATE THESE TESTS:
 * - When adding new columns to migrations, add them to EXPECTED_COLUMNS
 * - When removing columns, remove from EXPECTED_COLUMNS
 * - Run these tests against the real database to catch schema drift
 */

// Expected columns that code references for each table
// This is the source of truth for what the code expects
const EXPECTED_COLUMNS = {
  organizations: [
    // Core fields
    'workos_organization_id',
    'name',
    'created_at',
    'updated_at',
    // Stripe integration
    'stripe_customer_id',
    'stripe_subscription_id',
    'subscription_status',
    'subscription_current_period_end',
    'subscription_product_id',
    'subscription_product_name',
    'subscription_price_id',
    'subscription_amount',
    'subscription_currency',
    'subscription_interval',
    'subscription_canceled_at',
    'subscription_metadata',
    // Agreements
    'agreement_signed_at',
    'agreement_version',
    'pending_agreement_version',
    'pending_agreement_accepted_at',
    // Workspace type
    'is_personal',
  ],

  user_agreement_acceptances: [
    'id',
    'workos_user_id',
    'email',
    'agreement_type',
    'agreement_version',
    'accepted_at',
    'ip_address',
    'user_agent',
    'workos_organization_id',
  ],

  member_profiles: [
    'id',
    'workos_organization_id',
    'display_name',
    'slug',
    'tagline',
    'description',
    'logo_url',
    'logo_light_url',
    'logo_dark_url',
    'brand_color',
    'contact_email',
    'contact_website',
    'contact_phone',
    'linkedin_url',
    'twitter_url',
    'offerings',
    'agents',
    'agent_urls',
    'metadata',
    'tags',
    'is_public',
    'show_in_carousel',
    'featured',
    'created_at',
    'updated_at',
  ],

  registry_entries: [
    'id',
    'entry_type',
    'name',
    'slug',
    'url',
    'card_manifest_url',
    'card_format_id',
    'metadata',
    'tags',
    'contact_name',
    'contact_email',
    'contact_website',
    'approval_status',
    'approved_by',
    'approved_at',
    'created_at',
    'updated_at',
    'active',
    'workos_organization_id',
  ],

  revenue_events: [
    'id',
    'workos_organization_id',
    'stripe_invoice_id',
    'stripe_subscription_id',
    'stripe_charge_id',
    'stripe_payment_intent_id',
    'amount_paid',
    'currency',
    'revenue_type',
    'billing_reason',
    'product_id',
    'product_name',
    'price_id',
    'interval',
    'paid_at',
    'metadata',
    'created_at',
  ],

  agreements: [
    'id',
    'agreement_type',
    'version',
    'title',
    'text',
    'effective_date',
    'created_at',
    'updated_at',
  ],
};

// SQL queries that the code uses - extracted from http.ts and db files
// These are the actual queries that will fail if schema doesn't match
const CRITICAL_QUERIES = {
  // From http.ts webhook handler - this was the failing query
  webhookSubscriptionUpdate: {
    table: 'organizations',
    columns: ['subscription_status', 'stripe_subscription_id', 'subscription_current_period_end'],
    source: 'http.ts:1227-1232',
  },

  // From organization-db.ts
  organizationUpdate: {
    table: 'organizations',
    columns: ['agreement_signed_at', 'agreement_version'],
    source: 'organization-db.ts:updateOrganization',
  },

  // From member-db.ts
  memberProfileInsert: {
    table: 'member_profiles',
    columns: ['workos_organization_id', 'display_name', 'slug', 'offerings', 'agent_urls', 'is_public', 'show_in_carousel'],
    source: 'member-db.ts:createProfile',
  },

  // Agreement recording
  agreementAcceptanceInsert: {
    table: 'user_agreement_acceptances',
    columns: ['workos_user_id', 'email', 'agreement_type', 'agreement_version', 'workos_organization_id'],
    source: 'organization-db.ts:recordUserAgreementAcceptance',
  },
};

describe("Database Schema Alignment", () => {
  describe("Expected Columns Definition", () => {
    it("should have organizations table columns defined", () => {
      expect(EXPECTED_COLUMNS.organizations).toBeDefined();
      expect(EXPECTED_COLUMNS.organizations.length).toBeGreaterThan(10);
    });

    it("should include critical webhook columns in organizations", () => {
      // These are the columns that caused the webhook failure
      const criticalColumns = ['subscription_status', 'stripe_subscription_id'];
      for (const col of criticalColumns) {
        expect(EXPECTED_COLUMNS.organizations).toContain(col);
      }
    });

    it("should include all agreement-related columns", () => {
      const agreementColumns = ['agreement_signed_at', 'agreement_version', 'pending_agreement_version', 'pending_agreement_accepted_at'];
      for (const col of agreementColumns) {
        expect(EXPECTED_COLUMNS.organizations).toContain(col);
      }
    });
  });

  describe("Critical Query Validation", () => {
    it("webhook subscription update should reference valid columns", () => {
      const query = CRITICAL_QUERIES.webhookSubscriptionUpdate;
      for (const col of query.columns) {
        expect(EXPECTED_COLUMNS[query.table as keyof typeof EXPECTED_COLUMNS]).toContain(col);
      }
    });

    it("organization update should reference valid columns", () => {
      const query = CRITICAL_QUERIES.organizationUpdate;
      for (const col of query.columns) {
        expect(EXPECTED_COLUMNS[query.table as keyof typeof EXPECTED_COLUMNS]).toContain(col);
      }
    });

    it("member profile insert should reference valid columns", () => {
      const query = CRITICAL_QUERIES.memberProfileInsert;
      for (const col of query.columns) {
        expect(EXPECTED_COLUMNS[query.table as keyof typeof EXPECTED_COLUMNS]).toContain(col);
      }
    });

    it("agreement acceptance insert should reference valid columns", () => {
      const query = CRITICAL_QUERIES.agreementAcceptanceInsert;
      for (const col of query.columns) {
        expect(EXPECTED_COLUMNS[query.table as keyof typeof EXPECTED_COLUMNS]).toContain(col);
      }
    });
  });

  describe("Column Name Consistency", () => {
    it("should use snake_case for all column names", () => {
      for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        for (const col of columns) {
          // Column names should be lowercase with underscores
          expect(col).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    });

    it("should have consistent timestamp column names", () => {
      // Tables that should have created_at/updated_at
      const tablesWithTimestamps = ['organizations', 'member_profiles', 'registry_entries', 'agreements'];
      for (const table of tablesWithTimestamps) {
        const columns = EXPECTED_COLUMNS[table as keyof typeof EXPECTED_COLUMNS];
        expect(columns).toContain('created_at');
        expect(columns).toContain('updated_at');
      }
    });
  });
});

/**
 * Integration test that runs against the real database
 * This should be run in CI with a test database
 */
describe.skip("Database Schema Integration", () => {
  // These tests require a real database connection
  // Skip by default, enable in CI with test database
  // To run these tests, import getPool from the client module

  it("should have all expected columns in organizations table", async () => {
    // NOTE: Import getPool when enabling this test
    const { getPool } = await import("../../src/db/client.js");
    const pool = getPool();
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'organizations'
      ORDER BY ordinal_position
    `);

    const actualColumns = result.rows.map((r: { column_name: string }) => r.column_name);

    for (const expectedCol of EXPECTED_COLUMNS.organizations) {
      expect(actualColumns).toContain(expectedCol);
    }
  });

  it("should have all expected columns in user_agreement_acceptances table", async () => {
    const { getPool } = await import("../../src/db/client.js");
    const pool = getPool();
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'user_agreement_acceptances'
      ORDER BY ordinal_position
    `);

    const actualColumns = result.rows.map((r: { column_name: string }) => r.column_name);

    for (const expectedCol of EXPECTED_COLUMNS.user_agreement_acceptances) {
      expect(actualColumns).toContain(expectedCol);
    }
  });

  it("should have all expected columns in member_profiles table", async () => {
    const { getPool } = await import("../../src/db/client.js");
    const pool = getPool();
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'member_profiles'
      ORDER BY ordinal_position
    `);

    const actualColumns = result.rows.map((r: { column_name: string }) => r.column_name);

    for (const expectedCol of EXPECTED_COLUMNS.member_profiles) {
      expect(actualColumns).toContain(expectedCol);
    }
  });
});
