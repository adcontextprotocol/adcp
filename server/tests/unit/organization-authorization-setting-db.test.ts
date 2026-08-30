import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({ query: queryMock }));
vi.mock("../../src/logger.js", () => ({
  createLogger: () => ({ warn: warnMock }),
}));

import {
  getOrganizationAuthorizationEnforcement,
  setOrganizationAuthorizationEnforcement,
} from "../../src/db/system-settings-db.js";

describe("organization authorization system setting", () => {
  beforeEach(() => {
    queryMock.mockReset();
    warnMock.mockReset();
  });

  it("defaults absent configuration off", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(getOrganizationAuthorizationEnforcement()).resolves.toEqual({
      enabled: false,
      boundaries: [],
    });
  });

  it("normalizes persisted boundaries", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ value: { enabled: true, boundaries: [" organization_roles_read ", "organization_roles_read"] } }],
    });

    await expect(getOrganizationAuthorizationEnforcement()).resolves.toEqual({
      enabled: true,
      boundaries: ["organization_roles_read"],
    });
  });

  it("keeps known enforcement active while ignoring a future boundary", async () => {
    const persistedSetting = {
      rows: [{
        value: {
          enabled: true,
          boundaries: [" organization_roles_read ", "organization_future_read", "organization_future_read"],
        },
      }],
    };
    queryMock.mockResolvedValueOnce(persistedSetting).mockResolvedValueOnce(persistedSetting);

    await expect(getOrganizationAuthorizationEnforcement()).resolves.toEqual({
      enabled: true,
      boundaries: ["organization_roles_read"],
    });
    await expect(getOrganizationAuthorizationEnforcement()).resolves.toEqual({
      enabled: true,
      boundaries: ["organization_roles_read"],
    });
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(
      { ignoredBoundaryCount: 1 },
      "Ignored organization authorization boundaries unsupported by this application version",
    );
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("organization_future_read");
  });

  it("disables enforcement when an enabled setting contains only future boundaries", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ value: { enabled: true, boundaries: ["organization_future_read"] } }],
    });

    await expect(getOrganizationAuthorizationEnforcement()).resolves.toEqual({
      enabled: false,
      boundaries: [],
    });
  });

  it("filters future boundaries from a disabled setting while retaining known boundaries", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        value: {
          enabled: false,
          boundaries: ["organization_roles_read", "organization_future_read"],
        },
      }],
    });

    await expect(getOrganizationAuthorizationEnforcement()).resolves.toEqual({
      enabled: false,
      boundaries: ["organization_roles_read"],
    });
  });

  it.each([
    [true],
    [{ enabled: "true", boundaries: [] }],
    [{ enabled: true, boundaries: "organization_roles_read" }],
    [{ enabled: true, boundaries: [42] }],
    [{ enabled: true, boundaries: ["organization_roles_read", 42] }],
    [{ enabled: true, boundaries: [] }],
    [{ enabled: true, boundaries: [" ", "\t"] }],
    [{ enabled: true, boundaries: ["../organization_future_read"] }],
    [{ enabled: true, boundaries: [`organization_${"a".repeat(97)}`] }],
  ])("rejects malformed persisted configuration %#", async (value) => {
    queryMock.mockResolvedValueOnce({ rows: [{ value }] });

    await expect(getOrganizationAuthorizationEnforcement()).rejects.toThrow(
      "Invalid organization authorization enforcement setting",
    );
  });

  it("writes normalized configuration through the audited setting operation", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await setOrganizationAuthorizationEnforcement(
      {
        enabled: false,
        boundaries: [" organization_roles_read ", "organization_roles_read"],
      },
      "user_authenticated_admin",
    );

    expect(queryMock).toHaveBeenCalledOnce();
    expect(queryMock.mock.calls[0][1]).toEqual([
      "organization_authorization_enforcement",
      JSON.stringify({ enabled: false, boundaries: ["organization_roles_read"] }),
      "user_authenticated_admin",
    ]);
  });

  it("will not persist enabled configuration outside the fixed boundary allowlist", async () => {
    await expect(setOrganizationAuthorizationEnforcement({
      enabled: true,
      boundaries: ["unknown_boundary"],
    })).rejects.toThrow("Invalid organization authorization enforcement setting");

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("will not persist disabled configuration outside the fixed boundary allowlist", async () => {
    await expect(setOrganizationAuthorizationEnforcement({
      enabled: false,
      boundaries: ["unknown_boundary"],
    })).rejects.toThrow("Invalid organization authorization enforcement setting");

    expect(queryMock).not.toHaveBeenCalled();
  });

  it.each([true, false])("will not persist mixed known and unknown configuration when enabled=%s", async (enabled) => {
    await expect(setOrganizationAuthorizationEnforcement({
      enabled,
      boundaries: ["organization_roles_read", "organization_future_read"],
    })).rejects.toThrow("Invalid organization authorization enforcement setting");

    expect(queryMock).not.toHaveBeenCalled();
  });
});
