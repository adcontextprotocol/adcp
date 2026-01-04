import { describe, it, expect } from "vitest";
import {
  COMPANY_TYPES,
  COMPANY_TYPE_VALUES,
  getCompanyTypeLabel,
  getCompanyTypeDescription,
  formatCompanyTypes,
  getCompanyTypesDocumentation,
  CompanyTypeValue,
} from "../../src/config/company-types.js";
import {
  mapIndustryToCompanyType,
  mapIndustryToCompanyTypes,
} from "../../src/services/lusha.js";

describe("Company Types Config", () => {
  describe("COMPANY_TYPES", () => {
    it("should have all expected company types", () => {
      const expectedTypes = ["adtech", "agency", "brand", "publisher", "data", "ai", "other"];
      expect(Object.keys(COMPANY_TYPES)).toEqual(expectedTypes);
    });

    it("should have value, label, and description for each type", () => {
      for (const [key, config] of Object.entries(COMPANY_TYPES)) {
        expect(config.value).toBe(key);
        expect(config.label).toBeTruthy();
        expect(config.description).toBeTruthy();
      }
    });

    it("should have proper labels for new types", () => {
      expect(COMPANY_TYPES.data.label).toBe("Data & Measurement");
      expect(COMPANY_TYPES.ai.label).toBe("AI & Tech Platforms");
    });
  });

  describe("COMPANY_TYPE_VALUES", () => {
    it("should be an array of all type keys", () => {
      expect(COMPANY_TYPE_VALUES).toEqual(Object.keys(COMPANY_TYPES));
    });

    it("should include data and ai types", () => {
      expect(COMPANY_TYPE_VALUES).toContain("data");
      expect(COMPANY_TYPE_VALUES).toContain("ai");
    });

    it("should NOT include ai_infra (deprecated)", () => {
      expect(COMPANY_TYPE_VALUES).not.toContain("ai_infra");
    });
  });

  describe("getCompanyTypeLabel", () => {
    it("should return correct labels for known types", () => {
      expect(getCompanyTypeLabel("adtech")).toBe("Ad Tech");
      expect(getCompanyTypeLabel("data")).toBe("Data & Measurement");
      expect(getCompanyTypeLabel("ai")).toBe("AI & Tech Platforms");
    });

    it("should return the value itself for unknown types", () => {
      expect(getCompanyTypeLabel("unknown")).toBe("unknown");
      expect(getCompanyTypeLabel("ai_infra")).toBe("ai_infra"); // legacy value
    });
  });

  describe("formatCompanyTypes", () => {
    it("should format single type", () => {
      expect(formatCompanyTypes(["brand"])).toBe("Brand");
    });

    it("should format multiple types with comma separation", () => {
      expect(formatCompanyTypes(["brand", "ai"])).toBe("Brand, AI & Tech Platforms");
    });

    it("should return dash for empty array", () => {
      expect(formatCompanyTypes([])).toBe("-");
    });

    it("should return dash for null/undefined", () => {
      expect(formatCompanyTypes(null)).toBe("-");
      expect(formatCompanyTypes(undefined)).toBe("-");
    });

    it("should handle legacy ai_infra gracefully", () => {
      // Legacy values should still display (as the raw value)
      expect(formatCompanyTypes(["ai_infra"])).toBe("ai_infra");
    });
  });

  describe("getCompanyTypesDocumentation", () => {
    it("should return markdown formatted documentation", () => {
      const docs = getCompanyTypesDocumentation();
      expect(docs).toContain("- **adtech**:");
      expect(docs).toContain("- **data**:");
      expect(docs).toContain("- **ai**:");
      expect(docs).toContain("Data & Measurement");
      expect(docs).toContain("AI & Tech Platforms");
    });
  });
});

describe("Industry to Company Type Mapping", () => {
  describe("mapIndustryToCompanyType (single value)", () => {
    it("should return ai for AI/ML industries", () => {
      expect(mapIndustryToCompanyType("Artificial Intelligence", "")).toBe("ai");
      expect(mapIndustryToCompanyType("Technology", "LLM")).toBe("ai");
      expect(mapIndustryToCompanyType("Software", "Cloud Computing")).toBe("ai");
    });

    it("should return data for data/measurement industries", () => {
      expect(mapIndustryToCompanyType("Data Analytics", "")).toBe("data");
      expect(mapIndustryToCompanyType("Technology", "Clean Room")).toBe("data");
      expect(mapIndustryToCompanyType("Marketing", "CDP")).toBe("data");
      expect(mapIndustryToCompanyType("Technology", "Identity")).toBe("data");
      expect(mapIndustryToCompanyType("Technology", "Measurement")).toBe("data");
    });

    it("should return adtech for advertising technology", () => {
      expect(mapIndustryToCompanyType("Advertising", "DSP")).toBe("adtech");
      expect(mapIndustryToCompanyType("Technology", "Programmatic")).toBe("adtech");
    });

    it("should return agency for agency-related industries", () => {
      // "Advertising Agency" also triggers "advertising" -> adtech, but agency is also added
      // mapIndustryToCompanyType returns the FIRST type, which may be adtech
      expect(mapIndustryToCompanyType("Agency", "")).toBe("agency");
      expect(mapIndustryToCompanyType("Public Relations", "")).toBe("agency");
    });

    it("should return publisher for media companies", () => {
      expect(mapIndustryToCompanyType("Media", "Publisher")).toBe("publisher");
      expect(mapIndustryToCompanyType("Broadcasting", "")).toBe("publisher");
    });

    it("should return brand for consumer companies", () => {
      expect(mapIndustryToCompanyType("Retail", "")).toBe("brand");
      expect(mapIndustryToCompanyType("Consumer Goods", "")).toBe("brand");
      expect(mapIndustryToCompanyType("Financial Services", "")).toBe("brand");
    });

    it("should return null for unknown industries", () => {
      expect(mapIndustryToCompanyType(undefined, undefined)).toBeNull();
      expect(mapIndustryToCompanyType("", "")).toBeNull();
    });
  });

  describe("mapIndustryToCompanyTypes (array)", () => {
    it("should return multiple types for multi-faceted companies", () => {
      // A company with both AI and advertising technology
      // Note: The subIndustry "Advertising" triggers the adtech check
      const types = mapIndustryToCompanyTypes("Artificial Intelligence", "Programmatic");
      expect(types).toContain("ai");
      expect(types).toContain("adtech");
    });

    it("should not include ai_infra (deprecated)", () => {
      const types = mapIndustryToCompanyTypes("Artificial Intelligence", "Cloud Computing");
      expect(types).not.toContain("ai_infra");
      expect(types).toContain("ai");
    });

    it("should detect data companies", () => {
      const types = mapIndustryToCompanyTypes("Technology", "Customer Data Platform");
      expect(types).toContain("data");
    });
  });
});

describe("Migration Compatibility", () => {
  it("should handle legacy single-value to array conversion", () => {
    // Simulate what the migration does: ARRAY[company_type]
    const legacyValue = "brand";
    const migratedArray = [legacyValue];

    expect(formatCompanyTypes(migratedArray)).toBe("Brand");
  });

  it("should handle all legacy values after migration", () => {
    // These are the values that could exist in the database before migration
    const legacyValues = ["brand", "publisher", "agency", "adtech", "other"];

    for (const value of legacyValues) {
      const migratedArray = [value];
      const formatted = formatCompanyTypes(migratedArray);
      expect(formatted).not.toBe("-");
      expect(formatted).not.toBe(value); // Should be formatted to label
    }
  });

  it("should support backwards compatibility with company_type field", () => {
    // When saving company_types array, first value should go to legacy company_type
    const types: CompanyTypeValue[] = ["brand", "ai"];
    const legacyValue = types[0];

    expect(legacyValue).toBe("brand");
    expect(COMPANY_TYPE_VALUES).toContain(legacyValue);
  });
});
