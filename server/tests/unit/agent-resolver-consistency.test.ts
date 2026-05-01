/**
 * Pure-logic consistency checks for the AAO agent resolver.
 *
 * Table-driven over the storyboard variants from
 * `specs/capabilities-brand-url.md` §"Compliance impact":
 *
 * 1. happy path — eTLD+1 match, agent in brand.json, key_origins consistent
 * 2. brand_url omitted while signing declared (caller-side check, but
 *    relevant for declaredSigningPurposes)
 * 3. brand.json does not list the agent
 * 4. eTLD+1 mismatch with no authorized_operators delegation
 * 5. eTLD+1 mismatch WITH authorized_operators delegation (passes)
 * 6. key_origins host disagrees with resolved jwks_uri
 * 7. key_origins absent while signing declared
 * 8. ambiguous brand.json (multiple matching agents[] entries)
 *
 * Tests behavior, not implementation — calls the public functions exported
 * from `consistency.ts` and asserts on returned shapes.
 */
import { describe, it, expect } from "vitest";
import {
  checkOriginBinding,
  findAgentEntries,
  resolveJwksUri,
  extractIdentity,
  declaredSigningPurposes,
  checkKeyOrigins,
  findMissingKeyOrigin,
} from "../../src/registry/agent-resolver/consistency.js";
import type { ParsedBrandJson } from "../../src/registry/agent-resolver/brand-json-fetcher.js";

const baseBrandJson: ParsedBrandJson = {
  agents: [
    {
      type: "buying",
      url: "https://buyer.example.com/mcp",
      id: "buyer_main",
      jwks_uri: "https://keys.example.com/.well-known/jwks.json",
    },
  ],
  authorized_operators: [],
  raw: {},
};

describe("checkOriginBinding", () => {
  it("returns etld1_match when agent and brand_url share eTLD+1", () => {
    const r = checkOriginBinding(
      "https://buyer.example.com/mcp",
      "https://example.com/.well-known/brand.json",
      [],
    );
    expect(r.binding).toBe("etld1_match");
    expect(r.agent_etld1).toBe("example.com");
    expect(r.brand_url_etld1).toBe("example.com");
  });

  it("returns mismatch when eTLD+1 differs and no authorized_operators delegation", () => {
    const r = checkOriginBinding(
      "https://agent.scope3.com/mcp",
      "https://nike.com/.well-known/brand.json",
      [],
    );
    expect(r.binding).toBe("mismatch");
    expect(r.agent_etld1).toBe("scope3.com");
    expect(r.brand_url_etld1).toBe("nike.com");
  });

  it("returns authorized_operator when delegation is present", () => {
    const r = checkOriginBinding(
      "https://agent.scope3.com/mcp",
      "https://nike.com/.well-known/brand.json",
      [{ domain: "scope3.com", brands: ["*"] }],
    );
    expect(r.binding).toBe("authorized_operator");
  });

  it("is case-insensitive on authorized_operators.domain", () => {
    const r = checkOriginBinding(
      "https://agent.scope3.com/mcp",
      "https://nike.com/.well-known/brand.json",
      [{ domain: "SCOPE3.COM", brands: ["*"] }],
    );
    expect(r.binding).toBe("authorized_operator");
  });
});

describe("findAgentEntries", () => {
  it("byte-equals agent URL against brand_json agents[]", () => {
    const r = findAgentEntries("https://buyer.example.com/mcp", baseBrandJson);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].id).toBe("buyer_main");
  });

  it("returns no matches when agent URL is not present", () => {
    const r = findAgentEntries("https://other.example.com/mcp", baseBrandJson);
    expect(r.matches).toHaveLength(0);
  });

  it("does NOT canonicalize trailing slashes (byte-for-byte)", () => {
    const r = findAgentEntries("https://buyer.example.com/mcp/", baseBrandJson);
    expect(r.matches).toHaveLength(0);
  });

  it("flags ambiguous matches when brand_json lists the agent twice", () => {
    const dup: ParsedBrandJson = {
      ...baseBrandJson,
      agents: [
        baseBrandJson.agents[0],
        { type: "buying", url: "https://buyer.example.com/mcp", id: "duplicate" },
      ],
    };
    const r = findAgentEntries("https://buyer.example.com/mcp", dup);
    expect(r.matches).toHaveLength(2);
  });
});

describe("resolveJwksUri", () => {
  it("uses agent_entry.jwks_uri when present", () => {
    expect(
      resolveJwksUri(baseBrandJson.agents[0], "https://buyer.example.com/mcp"),
    ).toBe("https://keys.example.com/.well-known/jwks.json");
  });

  it("defaults to /.well-known/jwks.json on agent origin when jwks_uri absent", () => {
    expect(
      resolveJwksUri(
        { type: "buying", url: "https://buyer.example.com/mcp" },
        "https://buyer.example.com/mcp",
      ),
    ).toBe("https://buyer.example.com/.well-known/jwks.json");
  });

  it("preserves agent origin (scheme+host+port) when defaulting", () => {
    expect(
      resolveJwksUri(
        { type: "buying", url: "https://buyer.example.com:8443/mcp" },
        "https://buyer.example.com:8443/mcp",
      ),
    ).toBe("https://buyer.example.com:8443/.well-known/jwks.json");
  });
});

describe("extractIdentity", () => {
  it("returns null when identity block is absent", () => {
    expect(extractIdentity({})).toBeNull();
  });

  it("returns null when identity is not an object", () => {
    expect(extractIdentity({ identity: "x" })).toBeNull();
  });

  it("filters non-string key_origins values", () => {
    const r = extractIdentity({
      identity: { key_origins: { request_signing: "https://k.example.com", junk: 42 } },
    });
    expect(r?.key_origins).toEqual({ request_signing: "https://k.example.com" });
  });

  it("preserves per_principal_key_isolation", () => {
    const r = extractIdentity({
      identity: { per_principal_key_isolation: true, key_origins: {} },
    });
    expect(r?.per_principal_key_isolation).toBe(true);
  });
});

describe("declaredSigningPurposes", () => {
  it("returns empty when no signing posture is declared", () => {
    expect(declaredSigningPurposes({}).size).toBe(0);
  });

  it("does NOT trigger on request_signing.supported alone with empty arrays", () => {
    // Round-2 spec change: a no-op `supported: true` with empty arrays
    // doesn't bind any operation, so it shouldn't drag in key_origins.
    expect(
      declaredSigningPurposes({
        request_signing: { supported: true, supported_for: [], required_for: [] },
      }).has("request_signing"),
    ).toBe(false);
  });

  it("triggers on non-empty supported_for", () => {
    expect(
      declaredSigningPurposes({
        request_signing: { supported: true, supported_for: ["create_media_buy"] },
      }).has("request_signing"),
    ).toBe(true);
  });

  it("triggers on non-empty required_for", () => {
    expect(
      declaredSigningPurposes({
        request_signing: { supported: true, required_for: ["create_media_buy"] },
      }).has("request_signing"),
    ).toBe(true);
  });

  it("triggers on webhook_signing.supported === true", () => {
    expect(
      declaredSigningPurposes({ webhook_signing: { supported: true } }).has("webhook_signing"),
    ).toBe(true);
  });
});

describe("findMissingKeyOrigin", () => {
  it("returns null when all declared purposes have a key_origins entry", () => {
    expect(
      findMissingKeyOrigin(new Set(["request_signing"]), {
        request_signing: "https://k.example.com",
      }),
    ).toBeNull();
  });

  it("returns the first missing purpose", () => {
    const r = findMissingKeyOrigin(new Set(["request_signing"]), {});
    expect(r?.purpose).toBe("request_signing");
  });

  it("returns missing when key_origins is undefined", () => {
    const r = findMissingKeyOrigin(new Set(["webhook_signing"]), undefined);
    expect(r?.purpose).toBe("webhook_signing");
  });
});

describe("checkKeyOrigins", () => {
  it("passes when key_origins is undefined (no claim)", () => {
    expect(
      checkKeyOrigins(undefined, "https://keys.example.com/.well-known/jwks.json").match,
    ).toBe(true);
  });

  it("passes when declared origin equals resolved jwks_uri origin", () => {
    const r = checkKeyOrigins(
      { request_signing: "https://keys.example.com" },
      "https://keys.example.com/.well-known/jwks.json",
    );
    expect(r.match).toBe(true);
    expect(r.checkedPurposes).toEqual(["request_signing"]);
  });

  it("flags mismatch when declared origin host differs", () => {
    const r = checkKeyOrigins(
      { request_signing: "https://other.example.com" },
      "https://keys.example.com/.well-known/jwks.json",
    );
    expect(r.match).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({
      purpose: "request_signing",
      expected_origin: "https://other.example.com",
      actual_origin: "https://keys.example.com",
    });
  });

  it("skips bypassed purposes (publisher pin override)", () => {
    const r = checkKeyOrigins(
      { webhook_signing: "https://wh-publisher.example.com" },
      "https://keys.example.com/.well-known/jwks.json",
      { bypassedPurposes: new Set(["webhook_signing"]) },
    );
    expect(r.match).toBe(true);
    expect(r.checkedPurposes).toHaveLength(0);
  });

  it("treats unparseable declared origins as a mismatch", () => {
    const r = checkKeyOrigins(
      { request_signing: "not-a-url" },
      "https://keys.example.com/.well-known/jwks.json",
    );
    expect(r.match).toBe(false);
  });

  it("checks multiple purposes in a single call", () => {
    const r = checkKeyOrigins(
      {
        request_signing: "https://keys.example.com",
        webhook_signing: "https://other.example.com",
      },
      "https://keys.example.com/.well-known/jwks.json",
    );
    expect(r.match).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].purpose).toBe("webhook_signing");
  });
});
