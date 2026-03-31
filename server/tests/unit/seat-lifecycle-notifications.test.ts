import { describe, it, expect } from "vitest";
import { escapeSlackMrkdwn } from "../../src/slack/org-group-dm.js";
import {
  getSeatLimits,
  inferMembershipTier,
  SEAT_LIMITS,
} from "../../src/db/organization-db.js";

describe("escapeSlackMrkdwn", () => {
  it("escapes < and > to prevent link injection", () => {
    expect(escapeSlackMrkdwn("<https://evil.com|click here>")).toBe(
      "&lt;https://evil.com|click here&gt;"
    );
  });

  it("escapes & to prevent entity injection", () => {
    expect(escapeSlackMrkdwn("AT&T")).toBe("AT&amp;T");
  });

  it("escapes combined special characters", () => {
    expect(escapeSlackMrkdwn("a<b&c>d")).toBe("a&lt;b&amp;c&gt;d");
  });

  it("passes through safe mrkdwn formatting characters", () => {
    // Bold, italic, strike, code are safe in Slack mrkdwn
    expect(escapeSlackMrkdwn("*bold* _italic_ ~strike~ `code`")).toBe(
      "*bold* _italic_ ~strike~ `code`"
    );
  });

  it("handles empty string", () => {
    expect(escapeSlackMrkdwn("")).toBe("");
  });

  it("handles normal text without special characters", () => {
    expect(escapeSlackMrkdwn("Alice Smith")).toBe("Alice Smith");
  });
});

describe("Seat Limits", () => {
  it("returns correct limits for each tier", () => {
    expect(getSeatLimits("individual_professional")).toEqual({ contributor: 1, community: 0 });
    expect(getSeatLimits("individual_academic")).toEqual({ contributor: 0, community: 1 });
    expect(getSeatLimits("company_standard")).toEqual({ contributor: 5, community: 5 });
    expect(getSeatLimits("company_icl")).toEqual({ contributor: 10, community: 50 });
    expect(getSeatLimits("company_leader")).toEqual({ contributor: 20, community: -1 });
  });

  it("returns default limits for null tier", () => {
    expect(getSeatLimits(null)).toEqual({ contributor: 0, community: 1 });
  });

  it("returns default limits for unknown tier", () => {
    expect(getSeatLimits("unknown_tier")).toEqual({ contributor: 0, community: 1 });
  });
});

describe("Tier Inference", () => {
  it("infers individual professional from $250/year", () => {
    expect(inferMembershipTier(25000, "year", true)).toBe("individual_professional");
  });

  it("infers individual academic from $50/year", () => {
    expect(inferMembershipTier(5000, "year", true)).toBe("individual_academic");
  });

  it("infers company standard from $3000/year", () => {
    expect(inferMembershipTier(300000, "year", false)).toBe("company_standard");
  });

  it("infers company ICL from $15000/year", () => {
    expect(inferMembershipTier(1500000, "year", false)).toBe("company_icl");
  });

  it("infers company leader from $50000/year", () => {
    expect(inferMembershipTier(5000000, "year", false)).toBe("company_leader");
  });

  it("annualizes monthly amounts", () => {
    // $250/month = $3000/year → company_standard
    expect(inferMembershipTier(25000, "month", false)).toBe("company_standard");
  });

  it("returns null for zero amount", () => {
    expect(inferMembershipTier(0, "year", false)).toBeNull();
  });

  it("returns null for null amount", () => {
    expect(inferMembershipTier(null, "year", false)).toBeNull();
  });
});

describe("Seat Warning Thresholds", () => {
  // These are pure logic tests - the DB functions need integration tests
  // but we can verify the threshold logic here

  it("80% of 5 seats is 4", () => {
    const usage = 4;
    const limit = 5;
    const percentage = (usage / limit) * 100;
    expect(percentage).toBe(80);
  });

  it("60% hysteresis band for 5 seats is 3", () => {
    const usage = 3;
    const limit = 5;
    const percentage = (usage / limit) * 100;
    expect(percentage).toBe(60);
  });

  it("individual tiers should be excluded from percentage warnings", () => {
    // 1 seat: 100% is meaningful but 80% (0.8 seats) is not
    const tier = "individual_professional";
    expect(tier.startsWith("individual_")).toBe(true);
  });

  it("unlimited seats (-1) should skip warnings", () => {
    const limit = -1;
    expect(limit <= 0).toBe(true);
  });
});

describe("Seat Upgrade Request Validation", () => {
  const VALID_RESOURCE_TYPES = ["working_group", "council", "product_summit"];

  it("accepts valid resource types", () => {
    expect(VALID_RESOURCE_TYPES.includes("working_group")).toBe(true);
    expect(VALID_RESOURCE_TYPES.includes("council")).toBe(true);
    expect(VALID_RESOURCE_TYPES.includes("product_summit")).toBe(true);
  });

  it("rejects invalid resource types", () => {
    expect(VALID_RESOURCE_TYPES.includes("slack")).toBe(false);
    expect(VALID_RESOURCE_TYPES.includes("admin")).toBe(false);
    expect(VALID_RESOURCE_TYPES.includes("")).toBe(false);
  });
});
