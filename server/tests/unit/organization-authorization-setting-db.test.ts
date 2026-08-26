import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({ query: queryMock }));

import {
  getOrganizationAuthorizationEnforcement,
  setOrganizationAuthorizationEnforcement,
} from "../../src/db/system-settings-db.js";

describe("organization authorization system setting", () => {
  beforeEach(() => queryMock.mockReset());

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

  it.each([
    [true],
    [{ enabled: "true", boundaries: [] }],
    [{ enabled: true, boundaries: "organization_roles_read" }],
    [{ enabled: true, boundaries: [42] }],
    [{ enabled: true, boundaries: [] }],
    [{ enabled: true, boundaries: ["unknown_boundary"] }],
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
});
