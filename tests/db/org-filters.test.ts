import { describe, expect, it } from "vitest";

import {
  ENGAGED_FILTER,
  ENGAGED_FILTER_ALIASED,
  NOT_MEMBER,
  NOT_MEMBER_ALIASED,
  REGISTERED_FILTER,
  REGISTERED_FILTER_ALIASED,
} from "../../server/src/db/org-filters.js";

describe("organization tier SQL filters", () => {
  it("uses null-safe non-member checks for unaliased filters", () => {
    expect(NOT_MEMBER).toContain(
      "subscription_status IS DISTINCT FROM 'active'",
    );
    expect(NOT_MEMBER).toContain("subscription_canceled_at IS NOT NULL");
    expect(ENGAGED_FILTER).toContain(NOT_MEMBER);
    expect(REGISTERED_FILTER).toContain(NOT_MEMBER);
  });

  it("uses null-safe non-member checks for aliased filters", () => {
    expect(NOT_MEMBER_ALIASED).toContain(
      "o.subscription_status IS DISTINCT FROM 'active'",
    );
    expect(NOT_MEMBER_ALIASED).toContain(
      "o.subscription_canceled_at IS NOT NULL",
    );
    expect(ENGAGED_FILTER_ALIASED).toContain(NOT_MEMBER_ALIASED);
    expect(REGISTERED_FILTER_ALIASED).toContain(NOT_MEMBER_ALIASED);
  });
});
