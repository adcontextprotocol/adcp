import { describe, it, expect } from "@jest/globals";
import { CapabilityDiscovery, type AgentCapabilityProfile } from "../server/src/capabilities.js";

describe("CapabilityDiscovery", () => {
  const discovery = new CapabilityDiscovery();

  describe("inferAgentType (private)", () => {
    // Access private method for testing using any cast
    const inferAgentType = (tools: Array<{ name: string }>) =>
      (discovery as any).inferAgentType(
        tools.map((t) => ({ name: t.name, description: "", input_schema: {}, verified_at: "" }))
      );

    it("should infer sales type from sales-specific tools", () => {
      expect(inferAgentType([{ name: "get_products" }])).toBe("sales");
      expect(inferAgentType([{ name: "create_media_buy" }])).toBe("sales");
      expect(inferAgentType([{ name: "list_authorized_properties" }])).toBe("sales");
      expect(
        inferAgentType([
          { name: "get_products" },
          { name: "create_media_buy" },
          { name: "list_authorized_properties" },
        ])
      ).toBe("sales");
    });

    it("should infer creative type from creative-specific tools", () => {
      expect(inferAgentType([{ name: "list_creative_formats" }])).toBe("creative");
      expect(inferAgentType([{ name: "build_creative" }])).toBe("creative");
      expect(inferAgentType([{ name: "generate_creative" }])).toBe("creative");
      expect(inferAgentType([{ name: "validate_creative" }])).toBe("creative");
    });

    it("should infer signals type from signals-specific tools", () => {
      expect(inferAgentType([{ name: "get_signals" }])).toBe("signals");
      expect(inferAgentType([{ name: "list_signals" }])).toBe("signals");
      expect(inferAgentType([{ name: "match_audience" }])).toBe("signals");
      expect(inferAgentType([{ name: "activate_signal" }])).toBe("signals");
      expect(inferAgentType([{ name: "activate_audience" }])).toBe("signals");
    });

    it("should return unknown when no type-specific tools are found", () => {
      expect(inferAgentType([])).toBe("unknown");
      expect(inferAgentType([{ name: "some_random_tool" }])).toBe("unknown");
      expect(inferAgentType([{ name: "ping" }, { name: "health_check" }])).toBe("unknown");
    });

    it("should return unknown when multiple types are detected", () => {
      // Both sales and creative tools
      expect(
        inferAgentType([{ name: "get_products" }, { name: "list_creative_formats" }])
      ).toBe("unknown");
      // All three types
      expect(
        inferAgentType([
          { name: "get_products" },
          { name: "build_creative" },
          { name: "get_signals" },
        ])
      ).toBe("unknown");
    });

    it("should handle tool names case-insensitively", () => {
      expect(inferAgentType([{ name: "GET_PRODUCTS" }])).toBe("sales");
      expect(inferAgentType([{ name: "List_Creative_Formats" }])).toBe("creative");
      expect(inferAgentType([{ name: "MATCH_AUDIENCE" }])).toBe("signals");
    });
  });

  describe("inferTypeFromProfile (public)", () => {
    const baseProfile: AgentCapabilityProfile = {
      agent_url: "https://example.com/mcp",
      protocol: "mcp",
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
    };

    it("should return sales when standard_operations is present", () => {
      const profile: AgentCapabilityProfile = {
        ...baseProfile,
        standard_operations: {
          can_search_inventory: true,
          can_get_availability: true,
          can_reserve_inventory: false,
          can_get_pricing: true,
          can_create_order: false,
          can_list_properties: true,
        },
      };
      expect(discovery.inferTypeFromProfile(profile)).toBe("sales");
    });

    it("should return creative when creative_capabilities is present", () => {
      const profile: AgentCapabilityProfile = {
        ...baseProfile,
        creative_capabilities: {
          formats_supported: ["display_300x250"],
          can_generate: true,
          can_validate: true,
          can_preview: false,
        },
      };
      expect(discovery.inferTypeFromProfile(profile)).toBe("creative");
    });

    it("should return signals when signals_capabilities is present", () => {
      const profile: AgentCapabilityProfile = {
        ...baseProfile,
        signals_capabilities: {
          audience_types: ["behavioral"],
          can_match: true,
          can_activate: true,
          can_get_signals: true,
        },
      };
      expect(discovery.inferTypeFromProfile(profile)).toBe("signals");
    });

    it("should return unknown when no capabilities are present", () => {
      expect(discovery.inferTypeFromProfile(baseProfile)).toBe("unknown");
    });

    it("should prioritize sales over creative over signals when multiple present", () => {
      // sales + creative -> sales
      const salesAndCreative: AgentCapabilityProfile = {
        ...baseProfile,
        standard_operations: {
          can_search_inventory: true,
          can_get_availability: false,
          can_reserve_inventory: false,
          can_get_pricing: false,
          can_create_order: false,
          can_list_properties: false,
        },
        creative_capabilities: {
          formats_supported: [],
          can_generate: true,
          can_validate: false,
          can_preview: false,
        },
      };
      expect(discovery.inferTypeFromProfile(salesAndCreative)).toBe("sales");

      // creative + signals -> creative
      const creativeAndSignals: AgentCapabilityProfile = {
        ...baseProfile,
        creative_capabilities: {
          formats_supported: [],
          can_generate: true,
          can_validate: false,
          can_preview: false,
        },
        signals_capabilities: {
          audience_types: [],
          can_match: true,
          can_activate: false,
          can_get_signals: false,
        },
      };
      expect(discovery.inferTypeFromProfile(creativeAndSignals)).toBe("creative");
    });
  });
});
