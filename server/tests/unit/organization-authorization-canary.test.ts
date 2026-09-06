import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveUserOrgAuthorizationMock,
  evaluateUserOrgRoleAuthorizationMock,
  getRuntimeSettingDbMock,
  captureEventMock,
} = vi.hoisted(() => ({
  resolveUserOrgAuthorizationMock: vi.fn(),
  evaluateUserOrgRoleAuthorizationMock: vi.fn(),
  getRuntimeSettingDbMock: vi.fn(),
  captureEventMock: vi.fn(),
}));

vi.mock("../../src/utils/resolve-user-org-authorization.js", () => ({
  resolveUserOrgAuthorization: resolveUserOrgAuthorizationMock,
  evaluateUserOrgRoleAuthorization: evaluateUserOrgRoleAuthorizationMock,
}));

vi.mock("../../src/db/system-settings-db.js", () => ({
  getOrganizationAuthorizationEnforcement: getRuntimeSettingDbMock,
}));

vi.mock("../../src/utils/posthog.js", () => ({
  captureEvent: captureEventMock,
}));

import {
  evaluateOrganizationAuthorizationCanary,
  invalidateOrganizationAuthorizationRuntimeSettingCache,
  isOrganizationAuthorizationBoundaryAllowedByEnvironment,
  ORGANIZATION_AUTHORIZATION_BOUNDARIES,
  recordOrganizationAuthorizationCanaryDecision,
} from "../../src/middleware/organization-authorization-canary.js";

const BOUNDARY = ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_ROLES_READ;
const DOMAINS_BOUNDARY =
  ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_DOMAINS_READ;
const PENDING_COUNT_BOUNDARY =
  ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_PENDING_JOIN_REQUEST_COUNT_READ;
const PENDING_REQUESTS_BOUNDARY =
  ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_PENDING_JOIN_REQUESTS_READ;
const REFERRAL_CODES_BOUNDARY =
  ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_REFERRAL_CODES_READ;
const CERTIFICATION_STALLED_COUNT_BOUNDARY =
  ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_CERTIFICATION_STALLED_COUNT_READ;

describe("organization authorization canary", () => {
  beforeEach(() => {
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED;
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES;
    resolveUserOrgAuthorizationMock.mockReset();
    evaluateUserOrgRoleAuthorizationMock.mockReset();
    getRuntimeSettingDbMock.mockReset();
    captureEventMock.mockReset();
    invalidateOrganizationAuthorizationRuntimeSettingCache();
  });

  afterEach(() => {
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED;
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES;
  });

  it.each([
    ["both switches absent", undefined, undefined],
    ["global switch off", "false", BOUNDARY],
    ["boundary switch absent", "true", undefined],
    ["different boundary selected", "true", "another_boundary"],
  ])("does no authority work when %s", async (_label, globalSwitch, boundaries) => {
    if (globalSwitch !== undefined) {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = globalSwitch;
    }
    if (boundaries !== undefined) {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = boundaries;
    }
    const getWorkos = vi.fn();
    const getRuntimeSetting = vi.fn();

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: BOUNDARY,
      principal: {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      organizationId: "org_test",
      getWorkos,
      getRuntimeSetting,
    });

    expect(decision).toEqual({ enforced: false });
    expect(getWorkos).not.toHaveBeenCalled();
    expect(getRuntimeSetting).not.toHaveBeenCalled();
    expect(resolveUserOrgAuthorizationMock).not.toHaveBeenCalled();
  });

  it("requires the global switch and the exact fixed environment boundary", () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    expect(isOrganizationAuthorizationBoundaryAllowedByEnvironment(BOUNDARY)).toBe(false);

    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = "another_boundary";
    expect(isOrganizationAuthorizationBoundaryAllowedByEnvironment(BOUNDARY)).toBe(false);

    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = `another_boundary, ${BOUNDARY}`;
    expect(isOrganizationAuthorizationBoundaryAllowedByEnvironment(BOUNDARY)).toBe(true);

    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "false";
    expect(isOrganizationAuthorizationBoundaryAllowedByEnvironment(BOUNDARY)).toBe(false);
  });

  it("records enforced decisions without credential, membership, or organization identifiers", () => {
    recordOrganizationAuthorizationCanaryDecision(BOUNDARY, {
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_sensitive",
        role: "member",
        source: "workos",
      },
    });

    expect(captureEventMock).toHaveBeenCalledWith(
      "server-metrics",
      "org_authorization_canary",
      {
        boundary: BOUNDARY,
        decision: "authorized",
        unavailable_sources: undefined,
      }
    );
    expect(JSON.stringify(captureEventMock.mock.calls)).not.toContain("sensitive");

    captureEventMock.mockClear();
    recordOrganizationAuthorizationCanaryDecision(BOUNDARY, {
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos", "runtime_config"],
    });

    expect(captureEventMock).toHaveBeenCalledWith(
      "server-metrics",
      "org_authorization_canary",
      {
        boundary: BOUNDARY,
        decision: "unavailable",
        unavailable_sources: ["workos", "runtime_config"],
      }
    );
  });

  it("keeps legacy authorization when the audited runtime gate is off", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
    const getWorkos = vi.fn();
    const getRuntimeSetting = vi.fn().mockResolvedValue({
      enabled: false,
      boundaries: [BOUNDARY],
    });

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: BOUNDARY,
      principal: { id: "user_test" },
      organizationId: "org_test",
      getWorkos,
      getRuntimeSetting,
    });

    expect(decision).toEqual({ enforced: false });
    expect(getRuntimeSetting).toHaveBeenCalledOnce();
    expect(getWorkos).not.toHaveBeenCalled();
    expect(resolveUserOrgAuthorizationMock).not.toHaveBeenCalled();
  });

  it.each(
    [
      BOUNDARY,
      DOMAINS_BOUNDARY,
      PENDING_COUNT_BOUNDARY,
      PENDING_REQUESTS_BOUNDARY,
      REFERRAL_CODES_BOUNDARY,
      CERTIFICATION_STALLED_COUNT_BOUNDARY,
    ].flatMap((requestedBoundary) =>
      [
        BOUNDARY,
        DOMAINS_BOUNDARY,
        PENDING_COUNT_BOUNDARY,
        PENDING_REQUESTS_BOUNDARY,
        REFERRAL_CODES_BOUNDARY,
        CERTIFICATION_STALLED_COUNT_BOUNDARY,
      ]
        .filter((enabledBoundary) => enabledBoundary !== requestedBoundary)
        .map((enabledBoundary) => [requestedBoundary, enabledBoundary] as const),
    ),
  )(
    "does not enforce %s when runtime enables only %s",
    async (requestedBoundary, enabledBoundary) => {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES =
        `${BOUNDARY},${DOMAINS_BOUNDARY},${PENDING_COUNT_BOUNDARY},${PENDING_REQUESTS_BOUNDARY},${REFERRAL_CODES_BOUNDARY},${CERTIFICATION_STALLED_COUNT_BOUNDARY}`;
      const getWorkos = vi.fn();
      const getRuntimeSetting = vi.fn().mockResolvedValue({
        enabled: true,
        boundaries: [enabledBoundary],
      });

      const decision = await evaluateOrganizationAuthorizationCanary({
        boundary: requestedBoundary,
        principal: { id: "user_test" },
        organizationId: "org_test",
        getWorkos,
        getRuntimeSetting,
      });

      expect(decision).toEqual({ enforced: false });
      expect(getRuntimeSetting).toHaveBeenCalledOnce();
      expect(getWorkos).not.toHaveBeenCalled();
      expect(resolveUserOrgAuthorizationMock).not.toHaveBeenCalled();
    },
  );

  it("enforces the pending-count boundary when both rollout gates select it", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES =
      PENDING_COUNT_BOUNDARY;
    const getRuntimeSetting = vi.fn().mockResolvedValue({
      enabled: true,
      boundaries: [PENDING_COUNT_BOUNDARY],
    });
    const workos = { userManagement: {} };
    resolveUserOrgAuthorizationMock.mockResolvedValue({ status: "authorized" });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "workos",
      },
    });

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: PENDING_COUNT_BOUNDARY,
      principal: {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      organizationId: "org_test",
      getWorkos: () => workos as never,
      getRuntimeSetting,
    });

    expect(decision).toEqual({
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "workos",
      },
    });
    expect(getRuntimeSetting).toHaveBeenCalledOnce();
    expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
      workos,
      {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      "org_test",
    );
  });

  it("enforces the pending-requests boundary when both rollout gates select it", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES =
      PENDING_REQUESTS_BOUNDARY;
    const getRuntimeSetting = vi.fn().mockResolvedValue({
      enabled: true,
      boundaries: [PENDING_REQUESTS_BOUNDARY],
    });
    const workos = { userManagement: {} };
    const resolution = {
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "workos",
      },
      complete: false,
      unavailableSources: ["credential_grant"],
    };
    resolveUserOrgAuthorizationMock.mockResolvedValue(resolution);
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({
      status: "unavailable",
      unavailableSources: ["credential_grant"],
    });

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: PENDING_REQUESTS_BOUNDARY,
      principal: {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      organizationId: "org_test",
      getWorkos: () => workos as never,
      getRuntimeSetting,
      minimumRole: "admin",
    });

    expect(decision).toEqual({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["credential_grant"],
    });
    expect(getRuntimeSetting).toHaveBeenCalledOnce();
    expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
      workos,
      {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      "org_test",
    );
    expect(evaluateUserOrgRoleAuthorizationMock).toHaveBeenCalledWith(
      resolution,
      "admin",
    );
  });

  it("enforces the referral-codes boundary when both rollout gates select it", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES =
      REFERRAL_CODES_BOUNDARY;
    const getRuntimeSetting = vi.fn().mockResolvedValue({
      enabled: true,
      boundaries: [REFERRAL_CODES_BOUNDARY],
    });
    const workos = { userManagement: {} };
    resolveUserOrgAuthorizationMock.mockResolvedValue({ status: "authorized" });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "credential_grant",
      },
    });

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: REFERRAL_CODES_BOUNDARY,
      principal: {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      organizationId: "org_test",
      getWorkos: () => workos as never,
      getRuntimeSetting,
      minimumRole: "member",
    });

    expect(decision).toEqual({
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "credential_grant",
      },
    });
    expect(getRuntimeSetting).toHaveBeenCalledOnce();
    expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
      workos,
      {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      "org_test",
    );
    expect(evaluateUserOrgRoleAuthorizationMock).toHaveBeenCalledWith(
      { status: "authorized" },
      "member",
    );
  });

  it("enforces the certification-stalled-count boundary when both rollout gates select it", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES =
      CERTIFICATION_STALLED_COUNT_BOUNDARY;
    const getRuntimeSetting = vi.fn().mockResolvedValue({
      enabled: true,
      boundaries: [CERTIFICATION_STALLED_COUNT_BOUNDARY],
    });
    const workos = { userManagement: {} };
    resolveUserOrgAuthorizationMock.mockResolvedValue({ status: "authorized" });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "credential_grant",
      },
    });

    await expect(evaluateOrganizationAuthorizationCanary({
      boundary: CERTIFICATION_STALLED_COUNT_BOUNDARY,
      principal: { id: "user_canonical", authWorkosUserId: "user_authenticated" },
      organizationId: "org_test",
      getWorkos: () => workos as never,
      getRuntimeSetting,
      minimumRole: "member",
    })).resolves.toMatchObject({ enforced: true, status: "authorized" });
    expect(evaluateUserOrgRoleAuthorizationMock).toHaveBeenCalledWith(
      { status: "authorized" },
      "member",
    );
  });

  it("fails closed when the environment is staged but runtime configuration is unavailable", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
    const getWorkos = vi.fn();

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: BOUNDARY,
      principal: { id: "user_test" },
      organizationId: "org_test",
      getWorkos,
      getRuntimeSetting: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    expect(decision).toEqual({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["runtime_config"],
    });
    expect(getWorkos).not.toHaveBeenCalled();
    expect(resolveUserOrgAuthorizationMock).not.toHaveBeenCalled();
  });

  it("invalidates the process cache so rollback is visible without a restart", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
    getRuntimeSettingDbMock
      .mockResolvedValueOnce({ enabled: true, boundaries: [BOUNDARY] })
      .mockResolvedValueOnce({ enabled: false, boundaries: [BOUNDARY] });
    resolveUserOrgAuthorizationMock.mockResolvedValue({ status: "authorized" });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({ status: "forbidden" });
    const input = {
      boundary: BOUNDARY,
      principal: { id: "user_test" },
      organizationId: "org_test",
      getWorkos: vi.fn(() => ({ userManagement: {} }) as never),
    };

    expect(await evaluateOrganizationAuthorizationCanary(input)).toEqual({
      enforced: true,
      status: "forbidden",
    });
    expect(await evaluateOrganizationAuthorizationCanary(input)).toEqual({
      enforced: true,
      status: "forbidden",
    });
    expect(getRuntimeSettingDbMock).toHaveBeenCalledOnce();

    invalidateOrganizationAuthorizationRuntimeSettingCache();
    expect(await evaluateOrganizationAuthorizationCanary(input)).toEqual({ enforced: false });
    expect(getRuntimeSettingDbMock).toHaveBeenCalledTimes(2);
  });

  it("does not let an in-flight stale read repopulate the cache after rollback", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
    let resolveStaleRead!: (setting: { enabled: boolean; boundaries: string[] }) => void;
    getRuntimeSettingDbMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleRead = resolve;
      }))
      .mockResolvedValueOnce({ enabled: false, boundaries: [BOUNDARY] });
    resolveUserOrgAuthorizationMock.mockResolvedValue({ status: "authorized" });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({ status: "forbidden" });
    const input = {
      boundary: BOUNDARY,
      principal: { id: "user_test" },
      organizationId: "org_test",
      getWorkos: vi.fn(() => ({ userManagement: {} }) as never),
    };

    const staleDecision = evaluateOrganizationAuthorizationCanary(input);
    await vi.waitFor(() => expect(getRuntimeSettingDbMock).toHaveBeenCalledOnce());
    invalidateOrganizationAuthorizationRuntimeSettingCache();

    expect(await evaluateOrganizationAuthorizationCanary(input)).toEqual({ enforced: false });
    resolveStaleRead({ enabled: true, boundaries: [BOUNDARY] });
    expect(await staleDecision).toEqual({ enforced: true, status: "forbidden" });

    expect(await evaluateOrganizationAuthorizationCanary(input)).toEqual({ enforced: false });
    expect(getRuntimeSettingDbMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      {
        status: "authorized",
        membership: {
          organizationId: "org_test",
          role: "member",
          source: "workos",
        },
      },
      {
        enforced: true,
        status: "authorized",
        membership: {
          organizationId: "org_test",
          role: "member",
          source: "workos",
        },
      },
    ],
    [{ status: "forbidden" }, { enforced: true, status: "forbidden" }],
    [
      { status: "unavailable", unavailableSources: ["workos"] },
      { enforced: true, status: "unavailable", unavailableSources: ["workos"] },
    ],
  ])(
    "preserves the typed enforcement decision %#",
    async (roleDecision, expected) => {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
      const resolution = { status: "authorized" };
      const workos = { userManagement: {} };
      resolveUserOrgAuthorizationMock.mockResolvedValue(resolution);
      evaluateUserOrgRoleAuthorizationMock.mockReturnValue(roleDecision);

      const decision = await evaluateOrganizationAuthorizationCanary({
        boundary: BOUNDARY,
        principal: {
          id: "user_canonical",
          authWorkosUserId: "user_authenticated",
        },
        organizationId: "org_test",
        getWorkos: () => workos as never,
        getRuntimeSetting: vi.fn().mockResolvedValue({
          enabled: true,
          boundaries: [BOUNDARY],
        }),
      });

      expect(decision).toEqual(expected);
      expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
        workos,
        { id: "user_canonical", authWorkosUserId: "user_authenticated" },
        "org_test"
      );
    }
  );

  it("represents WorkOS client construction failure as an unavailable source", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
    resolveUserOrgAuthorizationMock.mockResolvedValue({
      status: "unavailable",
      unavailableSources: ["workos"],
    });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({
      status: "unavailable",
      unavailableSources: ["workos"],
    });

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: BOUNDARY,
      principal: { id: "user_test" },
      organizationId: "org_test",
      getWorkos: () => {
        throw new Error("missing configuration");
      },
      getRuntimeSetting: vi.fn().mockResolvedValue({
        enabled: true,
        boundaries: [BOUNDARY],
      }),
    });

    expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
      null,
      { id: "user_test" },
      "org_test"
    );
    expect(decision).toEqual({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos"],
    });
  });
});
