import { describe, expect, it } from "vitest";
import {
  ADDIE_MATCHED_V4_CLEAN_TOOL_NAMES,
  addieMatchedV4BroadToolManifest,
  addieMatchedV4CleanToolManifest,
  addieMatchedV4ProductionPromptBlocks,
  addieMatchedV4RuntimeSurfaceProvenance,
  addieMatchedV4WireSurface,
} from "../../../src/addie/eval/matched-v4-runtime-surface.js";
import { createAddieMatchedV4Plan } from "../../../src/addie/eval/matched-v4-evaluation.js";

describe("matched-v4 production-representative runtime surface", () => {
  it("derives fixed broad and clean definitions without a route oracle", () => {
    const broad = addieMatchedV4BroadToolManifest();
    const clean = addieMatchedV4CleanToolManifest();
    expect(broad.length).toBeGreaterThan(clean.length);
    expect(clean.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...ADDIE_MATCHED_V4_CLEAN_TOOL_NAMES]),
    );
    expect(broad.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(clean.map((tool) => tool.name)),
    );
    // These domains are assembled by the current Bolt runtime but were absent
    // from the old fixed-trace-only manifest.
    expect(broad.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "ask_about_adcp_task",
        "create_event",
        "get_recent_news",
        "search_image_library",
        "validate_json",
      ]),
    );
    expect(Object.isFrozen(broad)).toBe(true);
    expect(Object.isFrozen(clean)).toBe(true);
    expect(Object.isFrozen(broad[0]!.input_schema)).toBe(true);
    expect(Reflect.set(broad[0]!.input_schema, "type", "array")).toBe(false);
  });

  it("uses the production prompt builder and seals different provenance", () => {
    const broad = addieMatchedV4RuntimeSurfaceProvenance("broad");
    const clean = addieMatchedV4RuntimeSurfaceProvenance("clean");
    expect(broad.promptAssembly).toBe("buildAddieRuntimeSystemBlocks");
    expect(broad.toolManifestSha256).not.toBe(clean.toolManifestSha256);
    expect(broad.productionPromptBlocksSha256).not.toBe(clean.productionPromptBlocksSha256);
    expect(addieMatchedV4ProductionPromptBlocks("broad").length).toBeGreaterThan(0);
    const anthropic = addieMatchedV4WireSurface("broad", "anthropic");
    const openai = addieMatchedV4WireSurface("broad", "openai");
    expect(anthropic.system.some((block) => block.cacheHint === "ephemeral")).toBe(true);
    expect(openai.system.some((block) => block.cacheHint !== undefined)).toBe(false);
    expect(anthropic.provenance.systemBlocksSha256).not.toBe(openai.provenance.systemBlocksSha256);
  });

  it("screens every exposed native effort while keeping the immutable ledger cap", () => {
    const plan = createAddieMatchedV4Plan();
    const anthropic = plan.screening.cells.filter((cell) => cell.provider === "anthropic" && cell.arm === "direct");
    expect(anthropic.filter((cell) => cell.toolSurface === "broad")).toHaveLength(6);
    expect(new Set(anthropic.map((cell) => cell.reasoningEffort))).toEqual(
      new Set(["provider_default", "medium"]),
    );
    expect(plan.screening.maxProviderDispatches).toBeLessThanOrEqual(1584);
    expect(plan.full.maxProviderDispatches).toBeLessThanOrEqual(1584);
  });
});
