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
  mockGetPool,
  mockEscapeLikePattern,
  mockProcessInteraction,
} = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockPool = { query: mockPoolQuery };
  const mockGetPool = vi.fn().mockReturnValue(mockPool);
  const mockEscapeLikePattern = vi.fn((s: string) => s);
  const mockProcessInteraction = vi.fn().mockResolvedValue({ analyzed: false });
  return {
    mockPoolQuery,
    mockGetPool,
    mockEscapeLikePattern,
    mockProcessInteraction,
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
    getEngagementSignals = vi.fn().mockResolvedValue({
      interest_level: null,
      interest_level_set_by: null,
      login_count_30d: 0,
    });
    searchOrganizations = vi.fn().mockResolvedValue([]);
  },
  resolveMembershipTier: vi.fn().mockReturnValue(null),
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
  getPendingInvoices: vi.fn().mockResolvedValue([]),
  getAllOpenInvoices: vi.fn().mockResolvedValue([]),
  createOrgDiscount: vi.fn(),
  createCoupon: vi.fn(),
  createPromotionCode: vi.fn(),
  resendInvoice: vi.fn(),
  updateCustomerEmail: vi.fn(),
  getProductsForCustomer: vi.fn().mockResolvedValue([]),
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

// ── relationship db ───────────────────────────────────────────────────────────
vi.mock("../../server/src/db/relationship-db.js", () => ({
  resolvePersonId: vi.fn(),
  getRelationship: vi.fn(),
  recordAddieMessage: vi.fn(),
  updateStage: vi.fn(),
  rowToRelationship: vi.fn(),
  getRelationshipBySlackId: vi.fn(),
  getRelationshipByWorkosId: vi.fn(),
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
