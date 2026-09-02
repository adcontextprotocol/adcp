import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOS } from "@workos-inc/node";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({ query: queryMock }));

import {
  evaluateUserOrgRoleAuthorization,
  resolveUserOrgAuthorization,
} from "../../src/utils/resolve-user-org-authorization.js";

const ORGANIZATION_ID = "org_authorization_test";

function workosWithMemberships(data: unknown[]): WorkOS {
  return {
    userManagement: {
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data }),
    },
  } as unknown as WorkOS;
}

describe("resolveUserOrgAuthorization", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
  });

  it("uses the exact authenticated credential rather than the canonical identity user", async () => {
    const workos = workosWithMemberships([
      {
        organizationId: ORGANIZATION_ID,
        status: "active",
        role: { slug: "member" },
      },
    ]);

    await resolveUserOrgAuthorization(
      workos,
      { id: "user_canonical", authWorkosUserId: "user_authenticated" },
      ORGANIZATION_ID
    );

    expect(
      workos.userManagement.listOrganizationMemberships
    ).toHaveBeenCalledWith({
      userId: "user_authenticated",
      organizationId: ORGANIZATION_ID,
    });
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      "user_authenticated",
      ORGANIZATION_ID,
    ]);
  });

  it("returns a definitive denial only when both authority sources are available", async () => {
    const result = await resolveUserOrgAuthorization(
      workosWithMemberships([]),
      { id: "user_without_access" },
      ORGANIZATION_ID
    );

    expect(result).toEqual({
      status: "forbidden",
      complete: true,
      unavailableSources: [],
    });
  });

  it("distinguishes an authority-source outage from a denial", async () => {
    queryMock.mockRejectedValue(new Error("database unavailable"));

    const result = await resolveUserOrgAuthorization(
      workosWithMemberships([]),
      { id: "user_unknown" },
      ORGANIZATION_ID
    );

    expect(result).toEqual({
      status: "unavailable",
      complete: false,
      unavailableSources: ["credential_grant"],
    });
    expect(evaluateUserOrgRoleAuthorization(result)).toEqual({
      status: "unavailable",
      unavailableSources: ["credential_grant"],
    });
  });

  it("uses an active exact-credential grant and preserves partial role uncertainty", async () => {
    queryMock.mockResolvedValue({
      rows: [{ workos_organization_id: ORGANIZATION_ID, role: "member" }],
    });
    const workos = {
      userManagement: {
        listOrganizationMemberships: vi
          .fn()
          .mockRejectedValue(new Error("WorkOS unavailable")),
      },
    } as unknown as WorkOS;

    const result = await resolveUserOrgAuthorization(
      workos,
      { id: "user_granted" },
      ORGANIZATION_ID
    );

    expect(result).toMatchObject({
      status: "authorized",
      complete: false,
      unavailableSources: ["workos"],
      membership: { role: "member", source: "credential_grant" },
    });
    expect(evaluateUserOrgRoleAuthorization(result, "member")).toMatchObject({
      status: "authorized",
      membership: { role: "member" },
    });
    expect(evaluateUserOrgRoleAuthorization(result, "admin")).toEqual({
      status: "unavailable",
      unavailableSources: ["workos"],
    });
  });

  it("definitively denies a complete exact membership below the required role", () => {
    expect(evaluateUserOrgRoleAuthorization({
      status: "authorized",
      membership: {
        organizationId: ORGANIZATION_ID,
        role: "member",
        source: "workos",
      },
      complete: true,
      unavailableSources: [],
    }, "admin")).toEqual({ status: "forbidden" });
  });

  it("chooses the highest role while retaining its authority source", async () => {
    queryMock.mockResolvedValue({
      rows: [{ workos_organization_id: ORGANIZATION_ID, role: "owner" }],
    });
    const result = await resolveUserOrgAuthorization(
      workosWithMemberships([
        {
          organizationId: ORGANIZATION_ID,
          status: "active",
          role: { slug: "admin" },
        },
      ]),
      { id: "user_with_two_sources" },
      ORGANIZATION_ID
    );

    expect(result).toMatchObject({
      status: "authorized",
      complete: true,
      membership: { role: "owner", source: "credential_grant" },
    });
  });
});
