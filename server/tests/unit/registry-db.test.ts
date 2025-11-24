import { describe, it, expect, beforeEach, vi } from "vitest";
import { RegistryDatabase } from "../../src/db/registry-db.js";
import * as clientModule from "../../src/db/client.js";

// Mock database client
vi.mock("../../src/db/client.js");

describe("RegistryDatabase", () => {
  let db: RegistryDatabase;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new RegistryDatabase();
    mockQuery = vi.fn();
    vi.mocked(clientModule.query).mockImplementation(mockQuery as any);
  });

  describe("createEntry", () => {
    it("should create a new registry entry", async () => {
      const mockEntry = {
        id: "test-id",
        entry_type: "agent",
        name: "Test Agent",
        slug: "creative/test-agent",
        url: "http://test",
        metadata: { protocol: "mcp" },
        tags: ["creative", "mcp"],
        created_at: new Date(),
        updated_at: new Date(),
        active: true,
        approval_status: "approved",
      };

      mockQuery.mockResolvedValue({ rows: [mockEntry] });

      const result = await db.createEntry({
        entry_type: "agent",
        name: "Test Agent",
        slug: "creative/test-agent",
        url: "http://test",
        metadata: { protocol: "mcp" },
        tags: ["creative", "mcp"],
      });

      expect(result).toEqual(mockEntry);
      expect(mockQuery).toHaveBeenCalled();
    });
  });

  describe("getEntryBySlug", () => {
    it("should retrieve entry by slug", async () => {
      const mockEntry = {
        id: "test-id",
        slug: "creative/test-agent",
        name: "Test Agent",
        metadata: JSON.stringify({ protocol: "mcp" }),
        card_format_id: null,
      };

      mockQuery.mockResolvedValue({ rows: [mockEntry] });

      const result = await db.getEntryBySlug("creative/test-agent");

      expect(result).toBeDefined();
      expect(result?.slug).toBe("creative/test-agent");
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM registry_entries WHERE slug = $1",
        ["creative/test-agent"]
      );
    });

    it("should return null for non-existent slug", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await db.getEntryBySlug("nonexistent");

      expect(result).toBeNull();
    });

    it("should deserialize JSON fields correctly", async () => {
      const mockEntry = {
        id: "test-id",
        slug: "creative/test-agent",
        name: "Test Agent",
        metadata: JSON.stringify({ protocol: "mcp", description: "Test" }),
        card_format_id: JSON.stringify({ agent_url: "http://test", id: "format-1" }),
      };

      mockQuery.mockResolvedValue({ rows: [mockEntry] });

      const result = await db.getEntryBySlug("creative/test-agent");

      expect(result?.metadata).toEqual({ protocol: "mcp", description: "Test" });
      expect(result?.card_format_id).toEqual({ agent_url: "http://test", id: "format-1" });
    });
  });

  describe("listEntries", () => {
    it("should list all entries", async () => {
      const mockEntries = [
        { id: "1", name: "Agent 1", entry_type: "agent", metadata: "{}", card_format_id: null },
        { id: "2", name: "Agent 2", entry_type: "agent", metadata: "{}", card_format_id: null },
      ];

      mockQuery.mockResolvedValue({ rows: mockEntries });

      const result = await db.listEntries();

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalled();
    });

    it("should filter by entry_type", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await db.listEntries({ entry_type: "agent" });

      expect(mockQuery).toHaveBeenCalled();
      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain("WHERE entry_type = $1");
      expect(call[1]).toContain("agent");
    });

    it("should filter by tags", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await db.listEntries({ tags: ["creative", "mcp"] });

      expect(mockQuery).toHaveBeenCalled();
      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain("tags && $");
      expect(call[1]).toEqual([["creative", "mcp"]]);
    });

    it("should apply limit and offset", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await db.listEntries({ limit: 10, offset: 20 });

      expect(mockQuery).toHaveBeenCalled();
      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain("LIMIT");
      expect(call[0]).toContain("OFFSET");
      expect(call[1]).toContain(10);
      expect(call[1]).toContain(20);
    });
  });

  describe("updateEntry", () => {
    it("should update existing entry", async () => {
      const mockEntry = {
        id: "test-id",
        slug: "creative/test-agent",
        name: "Updated Agent",
        url: "http://test-updated",
      };

      mockQuery.mockResolvedValue({ rows: [mockEntry] });

      const result = await db.updateEntry("creative/test-agent", {
        name: "Updated Agent",
        url: "http://test-updated",
      });

      expect(result).toBeDefined();
      expect(result?.name).toBe("Updated Agent");
      expect(mockQuery).toHaveBeenCalled();
    });

    it("should not update when no changes provided", async () => {
      mockQuery.mockResolvedValue({ rows: [{ slug: "test" }] });

      await db.updateEntry("test", {});

      // Should only call getEntryBySlug, not UPDATE
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM registry_entries WHERE slug = $1",
        ["test"]
      );
    });
  });

  describe("deleteEntry", () => {
    it("should delete entry by slug", async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      const result = await db.deleteEntry("creative/test-agent");

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        "DELETE FROM registry_entries WHERE slug = $1",
        ["creative/test-agent"]
      );
    });

    it("should return false when entry not found", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });

      const result = await db.deleteEntry("nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("entryToAgent conversion", () => {
    it("should convert registry entry to Agent format", () => {
      const entry: any = {
        id: "test-id",
        entry_type: "agent",
        name: "Test Agent",
        slug: "creative/test-agent",
        url: "http://test",
        metadata: {
          protocol: "mcp",
          description: "Test description",
          mcp_endpoint: "http://test/mcp",
          agent_type: "creative",
          added_date: "2024-01-01",
        },
        tags: ["creative", "mcp"],
        contact_name: "John Doe",
        contact_email: "john@example.com",
        contact_website: "https://example.com",
        created_at: new Date(),
      };

      const agent = db.entryToAgent(entry);

      expect(agent.name).toBe("Test Agent");
      expect(agent.url).toBe("http://test");
      expect(agent.type).toBe("creative");
      expect(agent.protocol).toBe("mcp");
      expect(agent.description).toBe("Test description");
      expect(agent.contact.name).toBe("John Doe");
      expect(agent.contact.email).toBe("john@example.com");
    });

    it("should handle missing metadata gracefully", () => {
      const entry: any = {
        name: "Test Agent",
        url: "http://test",
        metadata: {},
        tags: ["sales"],
        created_at: new Date("2024-01-01"),
      };

      const agent = db.entryToAgent(entry);

      expect(agent.type).toBe("sales"); // Falls back to first tag
      expect(agent.protocol).toBe("mcp"); // Default
      expect(agent.description).toBe("");
    });
  });

  describe("listAgents", () => {
    it("should list agents with type filter", async () => {
      const mockEntries = [
        {
          name: "Creative Agent",
          url: "http://test",
          metadata: { agent_type: "creative" },
          tags: ["creative"],
          created_at: new Date(),
        },
      ];

      mockQuery.mockResolvedValue({ rows: mockEntries });

      const agents = await db.listAgents("creative");

      expect(agents).toHaveLength(1);
      expect(agents[0].type).toBe("creative");
      expect(mockQuery).toHaveBeenCalled();
    });

    it("should list all agents when no type specified", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await db.listAgents();

      expect(mockQuery).toHaveBeenCalled();
      const call = mockQuery.mock.calls[0];
      expect(call[1][0]).toBe("agent"); // entry_type filter
    });
  });
});
