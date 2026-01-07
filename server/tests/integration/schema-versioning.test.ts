import { describe, it, expect } from "vitest";

/**
 * Tests for schema version aliasing logic.
 *
 * These tests verify the pure functions used by the HTTP middleware
 * without requiring the full server stack.
 */
describe("Schema Versioning Middleware", () => {

  describe("parseSemver and findMatchingVersion logic", () => {
    // Test the core version matching logic in isolation

    function parseSemver(version: string): { major: number, minor: number, patch: number } {
      const [major, minor, patch] = version.split('.').map(Number);
      return { major, minor, patch };
    }

    function findMatchingVersion(versions: string[], requestedMajor: number, requestedMinor?: number): string | undefined {
      // Sort versions by semver descending
      const sorted = [...versions].sort((a, b) => {
        const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
        const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
        if (aMajor !== bMajor) return bMajor - aMajor;
        if (aMinor !== bMinor) return bMinor - aMinor;
        return bPatch - aPatch;
      });

      return sorted.find(v => {
        const { major, minor } = parseSemver(v);
        if (major !== requestedMajor) return false;
        if (requestedMinor !== undefined && minor !== requestedMinor) return false;
        return true;
      });
    }

    it("should correctly parse semver versions", () => {
      expect(parseSemver("2.5.1")).toEqual({ major: 2, minor: 5, patch: 1 });
      expect(parseSemver("12.0.0")).toEqual({ major: 12, minor: 0, patch: 0 });
      expect(parseSemver("2.50.3")).toEqual({ major: 2, minor: 50, patch: 3 });
    });

    it("should find latest major version correctly", () => {
      const versions = ["2.5.0", "2.5.1", "2.6.0", "12.0.0"];

      // v2 should find 2.6.0 (latest 2.x.x)
      expect(findMatchingVersion(versions, 2)).toBe("2.6.0");

      // v12 should find 12.0.0
      expect(findMatchingVersion(versions, 12)).toBe("12.0.0");

      // v3 should return undefined (no 3.x.x versions)
      expect(findMatchingVersion(versions, 3)).toBeUndefined();
    });

    it("should find latest minor version correctly", () => {
      const versions = ["2.5.0", "2.5.1", "2.6.0"];

      // v2.5 should find 2.5.1 (latest 2.5.x)
      expect(findMatchingVersion(versions, 2, 5)).toBe("2.5.1");

      // v2.6 should find 2.6.0
      expect(findMatchingVersion(versions, 2, 6)).toBe("2.6.0");

      // v2.7 should return undefined
      expect(findMatchingVersion(versions, 2, 7)).toBeUndefined();
    });

    it("should NOT confuse v2.5 with v2.50 (the original bug)", () => {
      const versions = ["2.5.0", "2.5.1", "2.50.0"];

      // v2.5 should find 2.5.1, NOT 2.50.0
      expect(findMatchingVersion(versions, 2, 5)).toBe("2.5.1");

      // v2.50 should find 2.50.0
      expect(findMatchingVersion(versions, 2, 50)).toBe("2.50.0");
    });

    it("should NOT confuse v2 with v12 (string prefix bug)", () => {
      const versions = ["2.6.0", "12.0.0"];

      // v2 should find 2.6.0, NOT 12.0.0
      expect(findMatchingVersion(versions, 2)).toBe("2.6.0");

      // v12 should find 12.0.0
      expect(findMatchingVersion(versions, 12)).toBe("12.0.0");
    });
  });

  describe("version alias regex matching", () => {
    const regex = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;

    it("should match major version aliases", () => {
      const match = "/v2/core/product.json".match(regex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("2");
      expect(match![2]).toBeUndefined();
      expect(match![3]).toBe("/core/product.json");
    });

    it("should match minor version aliases", () => {
      const match = "/v2.5/core/product.json".match(regex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("2");
      expect(match![2]).toBe("5");
      expect(match![3]).toBe("/core/product.json");
    });

    it("should match two-digit minor versions", () => {
      const match = "/v2.50/core/product.json".match(regex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("2");
      expect(match![2]).toBe("50");
      expect(match![3]).toBe("/core/product.json");
    });

    it("should match two-digit major versions", () => {
      const match = "/v12/core/product.json".match(regex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("12");
      expect(match![2]).toBeUndefined();
      expect(match![3]).toBe("/core/product.json");
    });

    it("should NOT match full semver versions (those are served directly)", () => {
      const match = "/v2.5.1/core/product.json".match(regex);
      // This should NOT match because we have three parts (major.minor.patch)
      // The regex expects at most major.minor
      expect(match).toBeNull();
    });

    it("should match root paths", () => {
      const match = "/v2/".match(regex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("2");
      expect(match![3]).toBe("/");
    });

    it("should match paths without trailing content", () => {
      const matchWithSlash = "/v2.5/".match(regex);
      expect(matchWithSlash).not.toBeNull();
      expect(matchWithSlash![3]).toBe("/");

      // Without trailing slash - the regex allows this
      const matchWithout = "/v2.5".match(regex);
      expect(matchWithout).not.toBeNull();
      expect(matchWithout![3]).toBeUndefined();
    });
  });

  describe("directory redirect regex", () => {
    const regex = /^\/(\d+\.\d+\.\d+|latest)\/$/;

    it("should match semver directory paths", () => {
      expect("/2.6.0/".match(regex)).not.toBeNull();
      expect("/2.5.1/".match(regex)).not.toBeNull();
      expect("/12.0.0/".match(regex)).not.toBeNull();
    });

    it("should match latest directory path", () => {
      expect("/latest/".match(regex)).not.toBeNull();
    });

    it("should NOT match version alias paths (handled by alias middleware)", () => {
      // These are rewritten by the alias middleware first
      expect("/v2/".match(regex)).toBeNull();
      expect("/v2.5/".match(regex)).toBeNull();
    });

    it("should NOT match file paths", () => {
      expect("/2.6.0/index.json".match(regex)).toBeNull();
      expect("/2.6.0/core/product.json".match(regex)).toBeNull();
      expect("/latest/index.json".match(regex)).toBeNull();
    });

    it("should NOT match paths without trailing slash", () => {
      expect("/2.6.0".match(regex)).toBeNull();
      expect("/latest".match(regex)).toBeNull();
    });
  });
});
