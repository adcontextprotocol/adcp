/**
 * Tests for Addie admin tools
 *
 * Covers tool definition shape and log_conversation handler behaviour
 * introduced / changed as part of issue #4745.
 *
 * Run with: npx vitest run tests/addie/admin-tools.test.ts
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoist mock refs before any import ─────────────────────────────────────────
const {
  mockPoolQuery,
  mockPoolConnect,
  mockGetPool,
  mockEscapeLikePattern,
  mockProcessInteraction,
  mockGetOrganization,
  mockCustomersRetrieve,
  mockCustomersUpdate,
  mockSubscriptionsList,
  mockSubscriptionsUpdate,
  mockInvoicesList,
  mockProductsRetrieve,
  mockInvalidateMembershipCache,
  mockPickMembershipSubWithProductFetch,
  mockBuildSubscriptionUpdate,
} = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockPoolConnect = vi.fn();
  const mockPool = { query: mockPoolQuery, connect: mockPoolConnect };
  const mockGetPool = vi.fn().mockReturnValue(mockPool);
  const mockEscapeLikePattern = vi.fn((s: string) => s);
  const mockProcessInteraction = vi.fn().mockResolvedValue({ analyzed: false });
  const mockGetOrganization = vi.fn();
  const mockCustomersRetrieve = vi.fn();
  const mockCustomersUpdate = vi.fn();
  const mockSubscriptionsList = vi.fn();
  const mockSubscriptionsUpdate = vi.fn();
  const mockInvoicesList = vi.fn();
  const mockProductsRetrieve = vi.fn();
  const mockInvalidateMembershipCache = vi.fn();
  const mockPickMembershipSubWithProductFetch = vi.fn();
  const mockBuildSubscriptionUpdate = vi.fn();
  return {
    mockPoolQuery,
    mockPoolConnect,
    mockGetPool,
    mockEscapeLikePattern,
    mockProcessInteraction,
    mockGetOrganization,
    mockCustomersRetrieve,
    mockCustomersUpdate,
    mockSubscriptionsList,
    mockSubscriptionsUpdate,
    mockInvoicesList,
    mockProductsRetrieve,
    mockInvalidateMembershipCache,
    mockPickMembershipSubWithProductFetch,
    mockBuildSubscriptionUpdate,
  };
});

// ── db / client ───────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/client.js", () => ({
  getPool: mockGetPool,
  query: vi.fn(),
  escapeLikePattern: mockEscapeLikePattern,
  getClient: vi.fn(),
}));

// ── interaction analyzer ──────────────────────────────────────────────────────
vi.mock("../../server/src/addie/services/interaction-analyzer.js", () => ({
  processInteraction: mockProcessInteraction,
}));

// ── organization db ───────────────────────────────────────────────────────────
vi.mock("../../server/src/db/organization-db.js", () => ({
  OrganizationDatabase: class {
    getOrganization = mockGetOrganization;
    getEngagementSignals = vi.fn().mockResolvedValue({
      interest_level: null,
      interest_level_set_by: null,
      login_count_30d: 0,
    });
    searchOrganizations = vi.fn().mockResolvedValue([]);
  },
  resolveMembershipTier: vi.fn().mockReturnValue(null),
  TIER_PRESERVING_STATUSES: ["active", "trialing", "past_due"],
  buildSubscriptionUpdate: mockBuildSubscriptionUpdate,
}));

// ── slack db ──────────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/slack-db.js", () => ({
  SlackDatabase: class {
    getUsersByOrg = vi.fn().mockResolvedValue([]);
  },
}));

// ── working group db ──────────────────────────────────────────────────────────
vi.mock("../../server/src/db/working-group-db.js", () => ({
  WorkingGroupDatabase: class {},
}));

// ── member db ─────────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/member-db.js", () => ({
  MemberDatabase: class {
    getProfileByOrgId = vi.fn().mockResolvedValue(null);
    getProfileById = vi.fn().mockResolvedValue(null);
  },
}));

// ── member search analytics db ────────────────────────────────────────────────
vi.mock("../../server/src/db/member-search-analytics-db.js", () => ({
  MemberSearchAnalyticsDatabase: class {
    getGlobalAnalytics = vi.fn().mockResolvedValue({ top_members: [] });
    getRecentIntroductionsGlobal = vi.fn().mockResolvedValue([]);
  },
}));

// ── brand db ──────────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/brand-db.js", () => ({
  BrandDatabase: class {},
}));

// ── brand logo db ─────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/brand-logo-db.js", () => ({
  BrandLogoDatabase: class {},
}));

// ── billing / stripe ──────────────────────────────────────────────────────────
vi.mock("../../server/src/billing/stripe-client.js", () => ({
  stripe: {
    customers: {
      retrieve: mockCustomersRetrieve,
      update: mockCustomersUpdate,
    },
    subscriptions: {
      list: mockSubscriptionsList,
      update: mockSubscriptionsUpdate,
    },
    invoices: {
      list: mockInvoicesList,
    },
    products: {
      retrieve: mockProductsRetrieve,
    },
  },
  getPendingInvoices: vi.fn().mockResolvedValue([]),
  getAllOpenInvoices: vi.fn().mockResolvedValue([]),
  createOrgDiscount: vi.fn(),
  createCoupon: vi.fn(),
  createPromotionCode: vi.fn(),
  resendInvoice: vi.fn(),
  updateCustomerEmail: vi.fn(),
  getProductsForCustomer: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../server/src/db/org-filters.js", () => ({
  MEMBER_FILTER_ALIASED:
    "o.subscription_status = 'active' AND o.subscription_canceled_at IS NULL",
  ENGAGED_FILTER_ALIASED:
    "(o.subscription_status IS DISTINCT FROM 'active' OR o.subscription_canceled_at IS NOT NULL) AND TRUE",
  REGISTERED_FILTER_ALIASED:
    "(o.subscription_status IS DISTINCT FROM 'active' OR o.subscription_canceled_at IS NOT NULL) AND NOT FALSE AND TRUE",
  invalidateMembershipCache: mockInvalidateMembershipCache,
}));

vi.mock("../../server/src/billing/membership-prices.js", () => ({
  pickMembershipSubWithProductFetch: mockPickMembershipSubWithProductFetch,
}));

// ── enrichment ────────────────────────────────────────────────────────────────
vi.mock("../../server/src/services/enrichment.js", () => ({
  enrichOrganization: vi.fn(),
  enrichDomain: vi.fn(),
}));

// ── brand enrichment ──────────────────────────────────────────────────────────
vi.mock("../../server/src/services/brand-enrichment.js", () => ({
  researchDomain: vi.fn(),
}));

// ── lusha ─────────────────────────────────────────────────────────────────────
vi.mock("../../server/src/services/lusha.js", () => ({
  getLushaClient: vi.fn(),
  isLushaConfigured: vi.fn().mockReturnValue(false),
  mapIndustryToCompanyType: vi.fn(),
}));

// ── prospect ──────────────────────────────────────────────────────────────────
vi.mock("../../server/src/services/prospect.js", () => ({
  createProspect: vi.fn(),
  updateProspect: vi.fn(),
}));

// ── industry feeds db ─────────────────────────────────────────────────────────
vi.mock("../../server/src/db/industry-feeds-db.js", () => ({
  getAllFeedsWithStats: vi.fn().mockResolvedValue([]),
  addFeed: vi.fn(),
  getFeedStats: vi.fn(),
  findSimilarFeeds: vi.fn(),
  getPendingProposals: vi.fn().mockResolvedValue([]),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  getProposalStats: vi.fn(),
}));

// ── insights db ───────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/insights-db.js", () => ({
  InsightsDatabase: class {},
}));

// ── resolve user role ─────────────────────────────────────────────────────────
vi.mock("../../server/src/utils/resolve-user-role.js", () => ({
  resolveUserRole: vi.fn(),
}));

// ── slack client ──────────────────────────────────────────────────────────────
vi.mock("../../server/src/slack/client.js", () => ({
  createChannel: vi.fn(),
  getSlackChannels: vi.fn(),
  setChannelPurpose: vi.fn(),
  inviteToChannel: vi.fn(),
  sendDirectMessage: vi.fn(),
}));

// ── membership invites db ─────────────────────────────────────────────────────
vi.mock("../../server/src/db/membership-invites-db.js", () => ({
  createMembershipInvite: vi.fn(),
  getMembershipInviteByToken: vi.fn(),
  inviteStatus: vi.fn(),
  listMembershipInvitesForOrg: vi.fn(),
  revokeMembershipInvite: vi.fn(),
}));

// ── email notifications ───────────────────────────────────────────────────────
vi.mock("../../server/src/notifications/email.js", () => ({
  sendMembershipInviteEmail: vi.fn(),
  sendEscalationResolutionEmail: vi.fn(),
}));

// ── org merge db ──────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/org-merge-db.js", () => ({
  mergeOrganizations: vi.fn(),
  previewMerge: vi.fn(),
}));

// ── workos client ─────────────────────────────────────────────────────────────
vi.mock("../../server/src/auth/workos-client.js", () => ({
  getWorkos: vi.fn().mockReturnValue({
    organizations: { getOrganization: vi.fn(), updateOrganization: vi.fn() },
    userManagement: { getUser: vi.fn() },
  }),
}));

// ── admin status cache ────────────────────────────────────────────────────────
vi.mock("../../server/src/addie/admin-status-cache.js", () => ({
  getSlackAdminStatusCache: vi
    .fn()
    .mockReturnValue({ get: vi.fn(), set: vi.fn() }),
  getWebAdminStatusCache: vi
    .fn()
    .mockReturnValue({ get: vi.fn(), set: vi.fn() }),
  invalidateSlackAdminStatusCache: vi.fn(),
  invalidateWebAdminStatusCache: vi.fn(),
}));

// ── admin status lookup (re-exported from admin-tools) ────────────────────────
vi.mock("../../server/src/addie/admin-status-lookup.js", () => ({
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));

// ── workos node sdk ───────────────────────────────────────────────────────────
vi.mock("@workos-inc/node", () => ({
  DomainDataState: { Verified: "verified", Pending: "pending" },
}));

// ── escalation db ─────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/escalation-db.js", () => ({
  listEscalations: vi.fn(),
  getEscalation: vi.fn(),
  updateEscalationStatus: vi.fn(),
  buildResolutionNotificationMessage: vi.fn().mockReturnValue(""),
}));

// ── account lifecycle ─────────────────────────────────────────────────────────
vi.mock("../../server/src/services/account-lifecycle.js", () => ({
  computePipelineStage: vi.fn().mockReturnValue("prospect"),
  PIPELINE_STAGE_EMOJI: {
    prospect: "🔵",
    member: "🟢",
    churned: "⚫",
    negotiating: "🟡",
    invited: "🟠",
  },
  computeEngagementLevel: vi.fn().mockReturnValue(1),
  ENGAGEMENT_LABELS: {
    0: "None",
    1: "Low",
    2: "Medium",
    3: "High",
    4: "Very High",
    5: "Champion",
  },
}));

// ── relationship orchestrator ─────────────────────────────────────────────────
vi.mock("../../server/src/addie/services/relationship-orchestrator.js", () => ({
  sendRelationshipMessage: vi.fn(),
  canEngageSlackUser: vi.fn(),
}));

// ── engagement planner ────────────────────────────────────────────────────────
vi.mock("../../server/src/addie/services/engagement-planner.js", () => ({
  shouldContact: vi.fn(),
  computeEngagementOpportunities: vi.fn(),
  buildComposePrompt: vi.fn(),
  MAX_TOTAL_UNREPLIED: 5,
}));

// ── relationship context ──────────────────────────────────────────────────────
vi.mock("../../server/src/addie/services/relationship-context.js", () => ({
  loadRelationshipContext: vi.fn(),
}));

// ── outreach simulator ────────────────────────────────────────────────────────
vi.mock("../../server/src/addie/services/outreach-simulator.js", () => ({
  assessHistoricalBehavior: vi.fn(),
}));

// ── outbound db ───────────────────────────────────────────────────────────────
vi.mock("../../server/src/db/outbound-db.js", () => ({
  getMemberCapabilities: vi.fn(),
}));

// ── account management db ─────────────────────────────────────────────────────
vi.mock("../../server/src/db/account-management-db.js", () => ({
  getActionItems: vi.fn(),
}));

// ── posthog ───────────────────────────────────────────────────────────────────
vi.mock("../../server/src/utils/posthog.js", () => ({
  captureEvent: vi.fn(),
}));

// ── brand logo service ────────────────────────────────────────────────────────
vi.mock("../../server/src/services/brand-logo-service.js", () => ({
  rebuildManifestLogos: vi.fn(),
}));

// ── brand identity ────────────────────────────────────────────────────────────
vi.mock("../../server/src/services/brand-identity.js", () => ({
  updateBrandIdentity: vi.fn(),
  BrandIdentityError: class extends Error {},
}));

// ── founding member grant ─────────────────────────────────────────────────────
vi.mock("../../server/src/services/founding-member-grant.js", () => ({
  normalizeFoundingMemberGrant: vi.fn(),
  foundingMemberFieldsTouched: vi.fn().mockReturnValue(false),
}));

// ── contacts db ───────────────────────────────────────────────────────────────
const { mockUpsertEmailContact, mockResolvePersonId } = vi.hoisted(() => ({
  mockUpsertEmailContact: vi.fn(),
  mockResolvePersonId: vi.fn(),
}));

vi.mock("../../server/src/db/contacts-db.js", () => ({
  upsertEmailContact: mockUpsertEmailContact,
  extractDomain: vi.fn((e: string) => e.split("@")[1] ?? ""),
  FREE_EMAIL_PROVIDER_DOMAINS: new Set<string>(),
}));

// override the relationship-db mock to expose resolvePersonId for assertions
vi.mock("../../server/src/db/relationship-db.js", () => ({
  resolvePersonId: mockResolvePersonId,
  getRelationship: vi.fn(),
  recordAddieMessage: vi.fn(),
  updateStage: vi.fn(),
  rowToRelationship: vi.fn(),
  getRelationshipBySlackId: vi.fn(),
  getRelationshipByWorkosId: vi.fn(),
}));

// ── imports (after all mocks are registered) ──────────────────────────────────
import {
  ADMIN_TOOLS,
  createAdminToolHandlers,
} from "../../server/src/addie/mcp/admin-tools.js";
import type { MemberContext } from "../../server/src/addie/member-context.js";

// ── shared test fixtures ──────────────────────────────────────────────────────
const adminMemberContext = {
  is_mapped: true,
  is_member: false,
  slack_linked: true,
  organization: null,
  workos_user: {
    workos_user_id: "user_admin_123",
    email: "admin@aao.org",
    first_name: "Admin",
    last_name: "User",
  },
} as unknown as MemberContext;

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    workos_organization_id: "org_test_123",
    name: "Test Corp",
    is_personal: false,
    stripe_customer_id: null,
    subscription_status: null,
    stripe_subscription_id: null,
    subscription_amount: null,
    subscription_currency: null,
    subscription_interval: null,
    subscription_current_period_end: null,
    subscription_canceled_at: null,
    subscription_product_id: null,
    subscription_product_name: null,
    subscription_price_id: null,
    subscription_price_lookup_key: null,
    membership_tier: null,
    ...overrides,
  };
}

function makeStripeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: "cus_new_123",
    deleted: false,
    name: "Test Corp Billing",
    email: "billing@example.com",
    metadata: {},
    ...overrides,
  };
}

function makePreviewRow(overrides: Record<string, unknown> = {}) {
  return {
    token: "preview-token",
    workos_organization_id: "org_test_123",
    new_customer_id: "cus_new_123",
    current_customer_id: "cus_old_123",
    actor_workos_user_id: "user_admin_123",
    actor_email: "admin@aao.org",
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

function makeTxClient(
  overrides: {
    previewRow?: Record<string, unknown>;
    org?: ReturnType<typeof makeOrg>;
    failOn?: "audit_insert";
  } = {},
) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (
        overrides.failOn === "audit_insert" &&
        sql.startsWith("INSERT INTO registry_audit_log")
      ) {
        throw new Error("audit INSERT failed");
      }
      if (sql.includes("DELETE FROM admin_stripe_customer_update_previews")) {
        return { rows: [overrides.previewRow ?? makePreviewRow()] };
      }
      if (sql.includes("SELECT * FROM organizations")) {
        return {
          rows: [
            overrides.org ??
              makeOrg({ stripe_customer_id: "cus_old_123" }),
          ],
        };
      }
      if (
        sql.includes("FROM organizations") &&
        sql.includes("stripe_customer_id = $1")
      ) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

// ── ADMIN_TOOLS definition tests ──────────────────────────────────────────────
describe("ADMIN_TOOLS definitions", () => {
  it("exports a non-empty array of tools", () => {
    expect(Array.isArray(ADMIN_TOOLS)).toBe(true);
    expect(ADMIN_TOOLS.length).toBeGreaterThan(0);
  });

  it("all tools have required properties", () => {
    for (const tool of ADMIN_TOOLS) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("input_schema");
      expect(typeof tool.name).toBe("string");
      expect(tool.input_schema).toHaveProperty("type", "object");
      expect(tool.input_schema).toHaveProperty("properties");
    }
  });

  describe("log_conversation tool", () => {
    let tool: (typeof ADMIN_TOOLS)[number] | undefined;

    beforeEach(() => {
      tool = ADMIN_TOOLS.find((t) => t.name === "log_conversation");
    });

    it("exists in ADMIN_TOOLS", () => {
      expect(tool).toBeDefined();
    });

    it("only requires summary", () => {
      expect(tool?.input_schema.required).toEqual(["summary"]);
    });

    it("usage_hints clarify that only summary is required and other fields are inferred", () => {
      expect(tool?.usage_hints).toContain("Only summary is required");
    });

    it("has all expected input schema properties", () => {
      const props = tool?.input_schema.properties ?? {};
      expect(props).toHaveProperty("company_name");
      expect(props).toHaveProperty("org_id");
      expect(props).toHaveProperty("contact_name");
      expect(props).toHaveProperty("channel");
      expect(props).toHaveProperty("summary");
    });
  });

  describe("org Stripe customer update tools", () => {
    it("exposes preview and confirm tools", () => {
      expect(
        ADMIN_TOOLS.find((t) => t.name === "preview_org_stripe_customer_update"),
      ).toBeDefined();
      expect(
        ADMIN_TOOLS.find((t) => t.name === "confirm_org_stripe_customer_update"),
      ).toBeDefined();
    });

    it("keeps raw Stripe customer IDs out of the confirm write schema", () => {
      const tool = ADMIN_TOOLS.find(
        (t) => t.name === "confirm_org_stripe_customer_update",
      );
      const props = tool?.input_schema.properties ?? {};
      expect(props).toHaveProperty("preview_token");
      expect(props).toHaveProperty("confirm");
      expect(props).toHaveProperty("reason");
      expect(props).not.toHaveProperty("customer_id");
      expect(props).not.toHaveProperty("new_customer_id");
      expect(tool?.input_schema.required).toEqual([
        "preview_token",
        "confirm",
        "reason",
      ]);
      expect(props.confirm).toMatchObject({ const: true });
      expect(props.reason).toMatchObject({ minLength: 10 });
    });

    it("constrains the preview schema to Stripe customer IDs", () => {
      const tool = ADMIN_TOOLS.find(
        (t) => t.name === "preview_org_stripe_customer_update",
      );
      const props = tool?.input_schema.properties ?? {};
      expect(props.new_customer_id).toMatchObject({ pattern: "^cus_" });
    });
  });

  describe("get_platform_stats tool", () => {
    let tool: (typeof ADMIN_TOOLS)[number] | undefined;

    beforeEach(() => {
      tool = ADMIN_TOOLS.find((t) => t.name === "get_platform_stats");
    });

    it("exists in ADMIN_TOOLS", () => {
      expect(tool).toBeDefined();
    });

    it("takes no required input", () => {
      expect(tool?.input_schema.required).toEqual([]);
      expect(tool?.input_schema.properties).toEqual({});
    });
  });
});

// ── org Stripe customer update handler tests ──────────────────────────────────
describe("org Stripe customer update handlers", () => {
  let previewRows: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    previewRows = [];
    mockGetOrganization.mockResolvedValue(makeOrg());
    mockPoolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO admin_stripe_customer_update_previews")) {
        previewRows.push(
          makePreviewRow({
            token: params?.[0],
            workos_organization_id: params?.[1],
            new_customer_id: params?.[2],
            current_customer_id: params?.[3],
            actor_workos_user_id: params?.[4],
            actor_email: params?.[5],
            expires_at: params?.[6],
          }),
        );
        return { rows: [] };
      }
      if (
        sql.includes("FROM admin_stripe_customer_update_previews") &&
        sql.includes("WHERE token = $1")
      ) {
        return { rows: previewRows.filter((row) => row.token === params?.[0]) };
      }
      return { rows: [] };
    });
    mockCustomersRetrieve.mockResolvedValue(makeStripeCustomer());
    mockCustomersUpdate.mockResolvedValue({});
    mockSubscriptionsList.mockResolvedValue({ data: [] });
    mockSubscriptionsUpdate.mockResolvedValue({});
    mockInvoicesList.mockResolvedValue({ data: [] });
    mockProductsRetrieve.mockResolvedValue({
      id: "prod_membership",
      name: "Membership",
      metadata: {},
      deleted: false,
    });
    mockPickMembershipSubWithProductFetch.mockResolvedValue(null);
    mockBuildSubscriptionUpdate.mockReturnValue(null);
    mockResolvePersonId.mockResolvedValue("pr_admin_123");
  });

  it("previews and validates the new Stripe customer without opening a transaction", async () => {
    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = JSON.parse(
      await handlers.get("preview_org_stripe_customer_update")!({
        org_id: "org_test_123",
        new_customer_id: "cus_new_123",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.preview_token).toEqual(expect.any(String));
    expect(result.current_customer_id).toBeNull();
    expect(result.org.name).toBe(
      "<untrusted_proposer_input>Test Corp</untrusted_proposer_input>",
    );
    expect(result.new_customer.id).toBe("cus_new_123");
    expect(result.new_customer.name).toBe(
      "<untrusted_proposer_input>Test Corp Billing</untrusted_proposer_input>",
    );
    expect(mockGetOrganization).toHaveBeenCalledWith("org_test_123");
    expect(mockCustomersRetrieve).toHaveBeenCalledWith("cus_new_123");
    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: "cus_new_123",
      status: "all",
      limit: 100,
    });
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it("confirms only a preview token and records registry plus person-event audit rows", async () => {
    mockGetOrganization.mockResolvedValue(
      makeOrg({ stripe_customer_id: "cus_old_123" }),
    );
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValue(tx.client);

    const handlers = createAdminToolHandlers(adminMemberContext);
    const preview = JSON.parse(
      await handlers.get("preview_org_stripe_customer_update")!({
        org_id: "org_test_123",
        new_customer_id: "cus_new_123",
      }),
    );
    mockPoolConnect.mockResolvedValue(tx.client);

    const confirm = JSON.parse(
      await handlers.get("confirm_org_stripe_customer_update")!({
        preview_token: preview.preview_token,
        confirm: true,
        reason: "Correct duplicate Stripe customer linkage",
      }),
    );

    expect(confirm.success).toBe(true);
    expect(confirm.previous_customer_id).toBe("cus_old_123");
    expect(confirm.new_customer_id).toBe("cus_new_123");

    const auditInsert = tx.calls.find((call) =>
      call.sql.startsWith("INSERT INTO registry_audit_log"),
    );
    expect(auditInsert?.params?.slice(0, 5)).toEqual([
      "org_test_123",
      "user_admin_123",
      "admin_stripe_link_replace",
      "subscription",
      "cus_new_123",
    ]);
    const auditDetails = JSON.parse(String(auditInsert?.params?.[5]));
    expect(auditDetails.previous_customer_id).toBe("cus_old_123");
    expect(auditDetails.source).toBe("addie");

    const personEventInsert = tx.calls.find((call) =>
      call.sql.startsWith("INSERT INTO person_events"),
    );
    expect(personEventInsert?.params?.[0]).toBe("pr_admin_123");
    expect(personEventInsert?.params?.[1]).toBe("billing_customer_relinked");
    const eventData = JSON.parse(String(personEventInsert?.params?.[3]));
    expect(eventData.old_customer_id).toBe("cus_old_123");
    expect(eventData.new_customer_id).toBe("cus_new_123");
    expect(eventData.actor_user_id).toBe("user_admin_123");

    const previewDelete = tx.calls.find((call) =>
      call.sql.includes("DELETE FROM admin_stripe_customer_update_previews"),
    );
    expect(previewDelete?.params).toEqual([preview.preview_token]);

    const customerUpdate = tx.calls.find((call) =>
      call.sql.includes("SET stripe_customer_id = $1"),
    );
    expect(customerUpdate?.params).toEqual([
      "cus_new_123",
      "org_test_123",
      "cus_old_123",
    ]);

    expect(mockCustomersUpdate).toHaveBeenCalledWith("cus_new_123", {
      metadata: { workos_organization_id: "org_test_123" },
    });
    expect(mockCustomersUpdate).toHaveBeenCalledWith("cus_old_123", {
      metadata: { workos_organization_id: "" },
    });
    expect(mockInvalidateMembershipCache).toHaveBeenCalledWith("org_test_123");
  });

  it("does not commit a relink when target customer metadata cannot be stamped", async () => {
    mockGetOrganization.mockResolvedValue(
      makeOrg({ stripe_customer_id: "cus_old_123" }),
    );
    mockCustomersUpdate.mockRejectedValueOnce(new Error("Stripe metadata outage"));

    const handlers = createAdminToolHandlers(adminMemberContext);
    const preview = JSON.parse(
      await handlers.get("preview_org_stripe_customer_update")!({
        org_id: "org_test_123",
        new_customer_id: "cus_new_123",
      }),
    );

    const confirm = JSON.parse(
      await handlers.get("confirm_org_stripe_customer_update")!({
        preview_token: preview.preview_token,
        confirm: true,
        reason: "Correct duplicate Stripe customer linkage",
      }),
    );

    expect(confirm.success).toBe(false);
    expect(confirm.error).toContain("relink was not committed");
    expect(mockCustomersUpdate).toHaveBeenCalledWith("cus_new_123", {
      metadata: { workos_organization_id: "org_test_123" },
    });
    expect(mockPoolConnect).toHaveBeenCalled();
  });

  it("restores target customer metadata when the local relink transaction fails", async () => {
    mockGetOrganization.mockResolvedValue(
      makeOrg({ stripe_customer_id: "cus_old_123" }),
    );
    mockCustomersRetrieve.mockResolvedValue(
      makeStripeCustomer({ metadata: { workos_organization_id: "org_previous" } }),
    );
    const tx = makeTxClient({
      failOn: "audit_insert",
      org: makeOrg({ stripe_customer_id: "cus_old_123" }),
    });
    mockPoolConnect.mockResolvedValue(tx.client);

    const handlers = createAdminToolHandlers(adminMemberContext);
    const preview = JSON.parse(
      await handlers.get("preview_org_stripe_customer_update")!({
        org_id: "org_test_123",
        new_customer_id: "cus_new_123",
      }),
    );
    mockPoolConnect.mockResolvedValue(tx.client);

    const confirm = JSON.parse(
      await handlers.get("confirm_org_stripe_customer_update")!({
        preview_token: preview.preview_token,
        confirm: true,
        reason: "Correct duplicate Stripe customer linkage",
      }),
    );

    expect(confirm.success).toBe(false);
    expect(confirm.error).toContain("audit INSERT failed");
    expect(tx.calls.map((call) => call.sql)).toContain("ROLLBACK");
    expect(mockCustomersUpdate).toHaveBeenCalledWith("cus_new_123", {
      metadata: { workos_organization_id: "org_test_123" },
    });
    expect(mockCustomersUpdate).toHaveBeenCalledWith("cus_new_123", {
      metadata: { workos_organization_id: "org_previous" },
    });
  });

  it("rejects confirm calls without a valid preview token", async () => {
    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = JSON.parse(
      await handlers.get("confirm_org_stripe_customer_update")!({
        preview_token: "missing",
        confirm: true,
        reason: "Correct duplicate Stripe customer linkage",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Preview token/);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });
});

// ── log_conversation handler tests ────────────────────────────────────────────
describe("log_conversation handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessInteraction.mockResolvedValue({ analyzed: false });
  });

  it("persists learnings to org_activities via UPDATE when analysis returns non-empty learnings", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ workos_organization_id: "org_123", name: "Test Corp" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] });

    mockProcessInteraction.mockResolvedValue({
      analyzed: true,
      analysis: {
        learnings: {
          interests: ["upgrade", "seat limit"],
          concerns: ["pricing"],
          decisionTimeline: null,
          budget: null,
          otherNotes: null,
        },
        taskActions: [],
        rawAnalysis: "",
      },
    });

    const handlers = createAdminToolHandlers(adminMemberContext);
    await handlers.get("log_conversation")!({
      company_name: "Test Corp",
      channel: "email",
      summary:
        "Emailed Ben about the Leader upgrade and seat limit. Concerns around pricing.",
    });

    const updateCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" &&
        sql.includes("UPDATE org_activities") &&
        sql.includes("metadata || $2::jsonb"),
    );
    expect(updateCall).toBeDefined();

    const params: unknown[] = updateCall![1];
    expect(params[0]).toBe(42);
    const persisted = JSON.parse(params[1] as string);
    expect(persisted.learnings.interests).toContain("upgrade");
    expect(persisted.learnings.concerns).toContain("pricing");
  });

  it("does not issue UPDATE when analysis returns empty learnings", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ workos_organization_id: "org_123", name: "Test Corp" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 42 }] });

    mockProcessInteraction.mockResolvedValue({
      analyzed: true,
      analysis: {
        learnings: { interests: [], concerns: [] },
        taskActions: [],
        rawAnalysis: "",
      },
    });

    const handlers = createAdminToolHandlers(adminMemberContext);
    await handlers.get("log_conversation")!({
      company_name: "Test Corp",
      summary: "Quick catch-up call, nothing notable.",
    });

    const updateCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("UPDATE org_activities"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("does not issue UPDATE when processInteraction returns no analysis", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ workos_organization_id: "org_123", name: "Test Corp" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 42 }] });

    mockProcessInteraction.mockResolvedValue({ analyzed: false });

    const handlers = createAdminToolHandlers(adminMemberContext);
    await handlers.get("log_conversation")!({
      company_name: "Test Corp",
      summary: "Quick catch-up.",
    });

    const updateCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("UPDATE org_activities"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("does not INSERT when org cannot be resolved by name", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const handlers = createAdminToolHandlers(adminMemberContext);
    await handlers.get("log_conversation")!({
      company_name: "Unknown Corp",
      summary: "Had a call.",
    });

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("INSERT INTO org_activities"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("returns error message when memberContext has no workos_user", async () => {
    const noUserContext = {
      ...adminMemberContext,
      workos_user: null,
    } as unknown as MemberContext;

    const handlers = createAdminToolHandlers(noUserContext);
    const result = await handlers.get("log_conversation")!({ summary: "test" });

    expect(typeof result).toBe("string");
    expect(result).toContain("❌");
  });
});

// ── platform stats handler tests ─────────────────────────────────────────────
describe("get_platform_stats handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a deduplicated platform-wide JSON snapshot", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          snapshot_at: new Date("2026-06-21T12:00:00Z"),
          users_total: "10",
          users_with_attributed_org: "8",
          users_without_attributed_org: "2",
          users_member: "4",
          users_engaged: "3",
          users_registered: "1",
          users_prospect: "2",
          orgs_total: "6",
          orgs_corporate: "4",
          orgs_individual: "2",
          orgs_member: "2",
          orgs_engaged: "1",
          orgs_registered: "1",
          orgs_prospect: "2",
          subscription_active: "2",
          subscription_trialing: "1",
          subscription_past_due: "1",
          subscription_canceled: "1",
          subscription_none: "1",
          membership_tiers: {
            company_standard: 2,
            individual_professional: 1,
            none: 3,
          },
        },
      ],
    });

    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = await handlers.get("get_platform_stats")!({});
    const json = result.match(/```json\n([\s\S]+)\n```/)?.[1];

    expect(json).toBeDefined();
    const snapshot = JSON.parse(json!);
    expect(snapshot.users).toMatchObject({
      total: 10,
      deduplicated: true,
      deduplication_key: "identity_id_fallback_workos_user_id_or_slack_user_id",
      attributed_to_org: 8,
      without_attributed_org: 2,
      by_platform_tier: {
        member: 4,
        engaged: 3,
        registered: 1,
        prospect: 2,
      },
    });
    expect(snapshot.organizations).toMatchObject({
      total: 6,
      by_type: { corporate: 4, individual: 2 },
      by_platform_tier: {
        member: 2,
        engaged: 1,
        registered: 1,
        prospect: 2,
      },
      by_membership_tier: {
        company_standard: 2,
        individual_professional: 1,
        none: 3,
      },
    });
    expect(snapshot.memberships).toEqual({
      active: 2,
      trialing: 1,
      past_due: 1,
      canceled: 1,
      none: 1,
    });
    expect(snapshot.snapshot_at).toBe("2026-06-21T12:00:00.000Z");

    const sql = mockPoolQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain("identity_workos_users");
    expect(sql).toContain("primary_organization_id");
    expect(sql).toContain("'slack:' || sm.slack_user_id");
    expect(sql).toContain(
      "sm.pending_organization_id AS primary_organization_id",
    );
    expect(sql).toContain("sm.mapping_status = 'unmapped'");
    expect(sql).toContain("sm.workos_user_id IS NULL");
    expect(sql).toContain(
      "subscription_status = 'active' AND subscription_canceled_at IS NULL",
    );
    expect(sql).toContain("subscription_status IS DISTINCT FROM 'active'");
  });
});

// ── create_contact tool definition tests ─────────────────────────────────────
describe("create_contact tool definition", () => {
  let tool: (typeof ADMIN_TOOLS)[number] | undefined;

  beforeEach(() => {
    tool = ADMIN_TOOLS.find((t) => t.name === "create_contact");
  });

  it("exists in ADMIN_TOOLS", () => {
    expect(tool).toBeDefined();
  });

  it("only requires email", () => {
    expect(tool?.input_schema.required).toEqual(["email"]);
  });

  it("has email and display_name properties", () => {
    const props = tool?.input_schema.properties ?? {};
    expect(props).toHaveProperty("email");
    expect(props).toHaveProperty("display_name");
  });
});

// ── create_contact handler tests ──────────────────────────────────────────────
describe("create_contact handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns new contact summary when contact is created for the first time", async () => {
    mockUpsertEmailContact.mockResolvedValue({
      contactId: "ec_new_123",
      organizationId: "org_456",
      workosUserId: null,
      isNew: true,
      email: "ben@mediaocean.com",
      domain: "mediaocean.com",
      mappingStatus: "mapped",
    });
    mockResolvePersonId.mockResolvedValue("pr_789");

    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = await handlers.get("create_contact")!({
      email: "ben@mediaocean.com",
      display_name: "Ben Smith",
    });

    expect(result).toContain("✅ Created new contact");
    expect(result).toContain("Ben Smith");
    expect(result).toContain("ben@mediaocean.com");
    expect(result).toContain("org_456");
    expect(result).toContain("mapped");
    expect(result).toContain("ec_new_123");
    expect(result).toContain("pr_789");
  });

  it("returns existing contact summary when contact already exists", async () => {
    mockUpsertEmailContact.mockResolvedValue({
      contactId: "ec_existing_999",
      organizationId: null,
      workosUserId: null,
      isNew: false,
      email: "jane@unknown.io",
      domain: "unknown.io",
      mappingStatus: "unmapped",
    });
    mockResolvePersonId.mockResolvedValue("pr_111");

    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = await handlers.get("create_contact")!({
      email: "jane@unknown.io",
    });

    expect(result).toContain("ℹ️");
    expect(result).toContain("already exists");
    expect(result).toContain("Not matched to any organization");
    expect(result).toContain("unmapped");
  });

  it("returns error when email is missing", async () => {
    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = await handlers.get("create_contact")!({});

    expect(result).toContain("❌");
    expect(mockUpsertEmailContact).not.toHaveBeenCalled();
    expect(mockResolvePersonId).not.toHaveBeenCalled();
  });

  it("returns error when upsertEmailContact throws", async () => {
    mockUpsertEmailContact.mockRejectedValue(new Error("DB connection failed"));
    mockResolvePersonId.mockResolvedValue("pr_000");

    const handlers = createAdminToolHandlers(adminMemberContext);
    const result = await handlers.get("create_contact")!({ email: "x@y.com" });

    expect(result).toContain("❌");
    expect(result).toContain("DB connection failed");
  });
});
