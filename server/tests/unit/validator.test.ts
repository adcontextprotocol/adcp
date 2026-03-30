import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentValidator } from "../../src/validator.js";

describe("AgentValidator", () => {
  let validator: AgentValidator;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    validator = new AgentValidator();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("authorizes property tag entries by resolving the domain to top-level properties", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        properties: [
          {
            property_id: "example_site",
            property_type: "website",
            name: "Example Site",
            identifiers: [{ type: "domain", value: "example.com" }],
            tags: ["premium"],
          },
        ],
        authorized_agents: [
          {
            url: "https://sales.example.com",
            authorized_for: "Premium placements",
            authorization_type: "property_tags",
            property_tags: ["premium"],
          },
        ],
      })
    );

    const result = await validator.validate("example.com", "https://sales.example.com");

    expect(result.authorized).toBe(true);
    expect(result.matched_authorization?.authorization_type).toBe("property_tags");
  });

  it("does not widen placement-scoped authorization when placement scope is missing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        properties: [
          {
            property_id: "example_site",
            property_type: "website",
            name: "Example Site",
            identifiers: [{ type: "domain", value: "example.com" }],
          },
        ],
        placements: [
          {
            placement_id: "pre_roll",
            name: "Pre-roll",
            property_ids: ["example_site"],
            collection_ids: ["morning-show"],
          },
        ],
        authorized_agents: [
          {
            url: "https://sales.example.com",
            authorized_for: "Homepage banner only",
            authorization_type: "property_ids",
            property_ids: ["example_site"],
            placement_ids: ["homepage_banner"],
          },
        ],
      })
    );

    const result = await validator.validate("example.com", "https://sales.example.com");

    expect(result.authorized).toBe(false);
  });

  it("matches collection, placement, country, and time scoped authorization and returns pinned signing keys", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        properties: [
          {
            property_id: "example_site",
            property_type: "website",
            name: "Example Site",
            identifiers: [{ type: "domain", value: "example.com" }],
          },
        ],
        placements: [
          {
            placement_id: "pre_roll",
            name: "Pre-roll",
            property_ids: ["example_site"],
            collection_ids: ["morning-show"],
          },
        ],
        authorized_agents: [
          {
            url: "https://sales.example.com",
            authorized_for: "US podcast pre-roll",
            authorization_type: "property_ids",
            property_ids: ["example_site"],
            collections: [
              {
                publisher_domain: "example.com",
                collection_ids: ["morning-show"],
              },
            ],
            placement_ids: ["pre_roll"],
            countries: ["US"],
            delegation_type: "delegated",
            effective_from: "2026-03-01T00:00:00Z",
            effective_until: "2026-03-31T23:59:59Z",
            signing_keys: [
              {
                kid: "sales-key-1",
                kty: "OKP",
                alg: "EdDSA",
                crv: "Ed25519",
                x: "abc123",
              },
            ],
          },
        ],
      })
    );

    const result = await validator.validate("example.com", "https://sales.example.com", {
      property_id: "example_site",
      collection_ids: ["morning-show"],
      placement_ids: ["pre_roll"],
      country: "us",
      at: "2026-03-30T12:00:00Z",
    });

    expect(result.authorized).toBe(true);
    expect(result.matched_authorization).toMatchObject({
      authorization_type: "property_ids",
      delegation_type: "delegated",
      countries: ["US"],
      collection_ids: ["morning-show"],
      placement_ids: ["pre_roll"],
      signing_keys: [
        {
          kid: "sales-key-1",
          kty: "OKP",
        },
      ],
    });
  });

  it("matches placement tag authorization by resolving placement ids through the publisher registry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        properties: [
          {
            property_id: "example_site",
            property_type: "website",
            name: "Example Site",
            identifiers: [{ type: "domain", value: "example.com" }],
          },
        ],
        placement_tags: {
          programmatic: {
            name: "Programmatic",
            description: "Placements available programmatically",
          },
        },
        placements: [
          {
            placement_id: "homepage_banner",
            name: "Homepage Banner",
            tags: ["programmatic", "publisher_managed"],
            property_ids: ["example_site"],
          },
        ],
        authorized_agents: [
          {
            url: "https://ssp.example.com",
            authorized_for: "Programmatic publisher-managed placements",
            authorization_type: "property_ids",
            property_ids: ["example_site"],
            placement_tags: ["programmatic"],
          },
        ],
      })
    );

    const result = await validator.validate("example.com", "https://ssp.example.com", {
      property_id: "example_site",
      placement_ids: ["homepage_banner"],
    });

    expect(result.authorized).toBe(true);
    expect(result.matched_authorization).toMatchObject({
      placement_tags: ["programmatic"],
    });
  });

  it("rejects placement tag authorization when the resolved placement belongs to a different property", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        properties: [
          {
            property_id: "property_a",
            property_type: "website",
            name: "Property A",
            identifiers: [{ type: "domain", value: "example.com" }],
          },
          {
            property_id: "property_b",
            property_type: "website",
            name: "Property B",
            identifiers: [{ type: "domain", value: "example.com" }],
          },
        ],
        placement_tags: {
          programmatic: {
            name: "Programmatic",
            description: "Placements available programmatically",
          },
        },
        placements: [
          {
            placement_id: "placement_b",
            name: "Placement B",
            tags: ["programmatic"],
            property_ids: ["property_b"],
          },
        ],
        authorized_agents: [
          {
            url: "https://ssp.example.com",
            authorized_for: "Programmatic inventory on property A",
            authorization_type: "property_ids",
            property_ids: ["property_a"],
            placement_tags: ["programmatic"],
          },
        ],
      })
    );

    const result = await validator.validate("example.com", "https://ssp.example.com", {
      property_id: "property_a",
      placement_ids: ["placement_b"],
    });

    expect(result.authorized).toBe(false);
  });

  it("supports publisher-defined placement tag queries without a concrete placement id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        properties: [
          {
            property_id: "example_site",
            property_type: "website",
            name: "Example Site",
            identifiers: [{ type: "domain", value: "example.com" }],
          },
        ],
        placement_tags: {
          programmatic: {
            name: "Programmatic",
            description: "Placements available programmatically",
          },
        },
        placements: [
          {
            placement_id: "homepage_banner",
            name: "Homepage Banner",
            tags: ["programmatic"],
            property_ids: ["example_site"],
          },
        ],
        authorized_agents: [
          {
            url: "https://ssp.example.com",
            authorized_for: "Programmatic inventory",
            authorization_type: "property_ids",
            property_ids: ["example_site"],
            placement_tags: ["programmatic"],
          },
        ],
      })
    );

    const result = await validator.validate("example.com", "https://ssp.example.com", {
      property_id: "example_site",
      placement_tags: ["programmatic"],
    });

    expect(result.authorized).toBe(true);
  });

  it("follows a single authoritative_location hop", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          authoritative_location: "https://cdn.example.com/adagents.json",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authorized_agents: [
            {
              url: "https://sales.example.com",
              authorized_for: "Global direct path",
            },
          ],
        })
      );

    const result = await validator.validate("example.com", "https://sales.example.com");

    expect(result.authorized).toBe(true);
    expect(result.source).toBe("https://cdn.example.com/adagents.json");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
