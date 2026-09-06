import { describe, expect, it, vi } from "vitest";
import {
  FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  fixedTraceEvaluatorCoordinatorUnavailable,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";
import {
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON,
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON,
} from "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js";
import {
  FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN,
  fixedTraceEvidencePrerequisiteDiagnostic,
} from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";
import * as prerequisiteExports from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";

const manifestModule = "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js";
type JsonRecord = Record<string, unknown>;

function parsedManifest(): JsonRecord {
  return JSON.parse(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON) as JsonRecord;
}

function reorderedManifest(): string {
  const manifest = parsedManifest();
  const { version, protocolVersion, ...rest } = manifest;
  return JSON.stringify({ protocolVersion, version, ...rest });
}

async function withManifest(
  value: unknown,
  verify: () => Promise<void> | void,
  canonical = FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON,
): Promise<void> {
  vi.resetModules();
  vi.doMock(manifestModule, async () => {
    const actual = await vi.importActual<typeof import("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js")>(manifestModule);
    return {
      ...actual,
      FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON: canonical,
      FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON: value,
    };
  });
  try {
    await verify();
  } finally {
    vi.doUnmock(manifestModule);
    vi.resetModules();
  }
}

function hostileArguments() {
  const reads = { getter: 0, get: 0, ownKeys: 0, primitive: 0, json: 0 };
  const accessor = Object.defineProperty({}, "evidence", {
    enumerable: true,
    get: () => { reads.getter += 1; throw new Error("getter read"); },
  });
  const proxy = new Proxy({}, {
    get: () => { reads.get += 1; throw new Error("proxy get"); },
    ownKeys: () => { reads.ownKeys += 1; throw new Error("proxy ownKeys"); },
  });
  const coercible = {
    [Symbol.toPrimitive]: () => { reads.primitive += 1; throw new Error("coerced"); },
    toJSON: () => { reads.json += 1; throw new Error("serialized"); },
  };
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  return { reads, values: [accessor, proxy, coercible, cyclic] };
}

describe("fixed-trace evaluator coordinator refusal boundary", () => {
  it("returns ordinary unavailable only while the independently pinned A manifest agrees", () => {
    expect(fixedTraceEvidencePrerequisiteDiagnostic()).toEqual({
      status: "ordinary_unavailable",
      code: FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
      reason: "A_manifest_is_pinned_but_required_artifacts_are_unavailable",
    });
    expect(fixedTraceEvaluatorCoordinatorUnavailable()).toMatchObject({
      status: "unavailable",
      admission: FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
    });
  });

  it("pins every A-owned authority leaf without an aggregate protocol-hash surrogate", () => {
    const manifest = parsedManifest();
    const final = manifest.finalPrerequisites as JsonRecord;
    expect(FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN).toMatchObject({
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      corpusSuiteVersion: (manifest.corpus as JsonRecord).suiteVersion,
      corpusSuiteSha256: (manifest.corpus as JsonRecord).suiteSha256,
      partitionManifestSha256: manifest.partitionManifestSha256,
      experimentalDesignFingerprint: manifest.experimentalDesignFingerprint,
      measurement: manifest.measurement,
      authorityDigests: manifest.authorityDigests,
      randomization: final.randomization,
      pricingWindow: final.pricingWindow,
      calibration: final.calibration,
      custody: final.custody,
      providerExposure: final.providerExposure,
    });
    expect("protocolFingerprint" in FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN).toBe(false);
    expect("validateFixedTraceAPurePrerequisiteManifest" in prerequisiteExports).toBe(false);
    expect("FixedTraceEvidencePrerequisitePinDriftError" in prerequisiteExports).toBe(false);
  });

  it("does not inspect extra hostile arguments", () => {
    const hostile = hostileArguments();
    const entry = fixedTraceEvaluatorCoordinatorUnavailable as unknown as (...args: unknown[]) => unknown;
    expect(entry(...hostile.values)).toMatchObject({ status: "unavailable" });
    expect(hostile.reads).toEqual({ getter: 0, get: 0, ownKeys: 0, primitive: 0, json: 0 });
  });

  it.each([
    ["duplicate root", FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON.replace(
      '"version":"addie-fixed-trace-A-prerequisite-manifest-v3"',
      '"version":"forged","version":"addie-fixed-trace-A-prerequisite-manifest-v3"',
    )],
    ["duplicate nested", FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON.replace(
      '"providerExposure":{"status":"unavailable","digest":null}',
      '"providerExposure":{"status":"forged","status":"unavailable","digest":null}',
    )],
    ["leading whitespace", ` ${FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON}`],
    ["reordered root", reorderedManifest()],
    ["alternate escape", FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON.replace("addie-fixed-trace-A", "addie\\u002dfixed-trace-A")],
  ])("rejects a simultaneous canonical/source alias mutation: %s", async (_name, source) => {
    await withManifest(source, async () => {
      const prerequisite = await import("../../../src/addie/eval/fixed-trace-evidence-prerequisite.js");
      expect(prerequisite.fixedTraceEvidencePrerequisiteDiagnostic()).toMatchObject({
        status: "pin_drift", mismatchedFields: ["manifest_shape"],
      });
    }, source);
  });

  it.each([
    ["getter-backed object", () => {
      const reads = { count: 0 };
      const value = Object.defineProperty({}, "manifest", { get: () => { reads.count += 1; throw new Error("getter"); } });
      return { value, reads };
    }],
    ["proxy-backed object", () => {
      const reads = { count: 0 };
      const value = new Proxy({}, { get: () => { reads.count += 1; throw new Error("get"); }, ownKeys: () => { reads.count += 1; throw new Error("keys"); } });
      return { value, reads };
    }],
    ["custom-prototype object", () => ({ value: Object.create({ inherited: true }), reads: { count: 0 } })],
    ["cycle", () => { const value: { self?: unknown } = {}; value.self = value; return { value, reads: { count: 0 } }; }],
    ["partial JSON", () => ({ value: "{}", reads: { count: 0 } })],
    ["wrong-type JSON", () => ({ value: "[]", reads: { count: 0 } })],
  ])("rejects %s at the actual primitive manifest boundary without hostile inspection", async (_name, create) => {
    const hostile = create();
    await withManifest(hostile.value, async () => {
      const prerequisite = await import("../../../src/addie/eval/fixed-trace-evidence-prerequisite.js");
      const coordinator = await import("../../../src/addie/eval/fixed-trace-evaluator-coordinator.js");
      expect(prerequisite.fixedTraceEvidencePrerequisiteDiagnostic()).toMatchObject({
        status: "pin_drift", mismatchedFields: ["manifest_shape"],
      });
      expect(() => coordinator.fixedTraceEvaluatorCoordinatorUnavailable())
        .toThrow("fixed_trace_A_prerequisite_pin_drift");
      expect(hostile.reads.count).toBe(0);
    });
  });

  it.each([
    ["version", (root: JsonRecord) => { root.version = "drift"; }],
    ["protocolVersion", (root: JsonRecord) => { root.protocolVersion = "drift"; }],
    ["corpus.suiteVersion", (root: JsonRecord) => { (root.corpus as JsonRecord).suiteVersion = "drift"; }],
    ["corpus.suiteSha256", (root: JsonRecord) => { (root.corpus as JsonRecord).suiteSha256 = "0".repeat(64); }],
    ["partitionManifestSha256", (root: JsonRecord) => { root.partitionManifestSha256 = "0".repeat(64); }],
    ["experimentalDesignFingerprint", (root: JsonRecord) => { root.experimentalDesignFingerprint = "0".repeat(64); }],
    ["measurement.version", (root: JsonRecord) => { (root.measurement as JsonRecord).version = "drift"; }],
    ["measurement.sha256", (root: JsonRecord) => { (root.measurement as JsonRecord).sha256 = "0".repeat(64); }],
    ["authorityDigests.finalPrerequisitesSha256", (root: JsonRecord) => { (root.authorityDigests as JsonRecord).finalPrerequisitesSha256 = "0".repeat(64); }],
    ["finalPrerequisites.randomization.scheduleDigest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).randomization as JsonRecord).scheduleDigest = "x"; }],
    ["finalPrerequisites.randomization.episodeClusterManifestDigest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).randomization as JsonRecord).episodeClusterManifestDigest = "x"; }],
    ["finalPrerequisites.pricingWindow.id", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).pricingWindow as JsonRecord).id = "x"; }],
    ["finalPrerequisites.pricingWindow.effectiveFrom", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).pricingWindow as JsonRecord).effectiveFrom = "x"; }],
    ["finalPrerequisites.pricingWindow.effectiveBefore", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).pricingWindow as JsonRecord).effectiveBefore = "x"; }],
    ["finalPrerequisites.pricingWindow.digest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).pricingWindow as JsonRecord).digest = "x"; }],
    ["finalPrerequisites.calibration.status", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).calibration as JsonRecord).status = "available"; }],
    ["finalPrerequisites.calibration.allowedRelationshipToScoredDevelopment", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).calibration as JsonRecord).allowedRelationshipToScoredDevelopment = "drift"; }],
    ["finalPrerequisites.calibration.digest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).calibration as JsonRecord).digest = "x"; }],
    ["finalPrerequisites.custody.status", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).custody as JsonRecord).status = "available"; }],
    ["finalPrerequisites.custody.custodianIdentity", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).custody as JsonRecord).custodianIdentity = "x"; }],
    ["finalPrerequisites.custody.packDigest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).custody as JsonRecord).packDigest = "x"; }],
    ["finalPrerequisites.custody.signature", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).custody as JsonRecord).signature = "x"; }],
    ["finalPrerequisites.custody.collisionAuditDigest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).custody as JsonRecord).collisionAuditDigest = "x"; }],
    ["finalPrerequisites.providerExposure.status", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).providerExposure as JsonRecord).status = "available"; }],
    ["finalPrerequisites.providerExposure.digest", (root: JsonRecord) => { ((root.finalPrerequisites as JsonRecord).providerExposure as JsonRecord).digest = "x"; }],
  ])("rejects reloaded %s before parsing a noncanonical source", async (_field, mutate) => {
    const manifest = parsedManifest();
    mutate(manifest);
    await withManifest(JSON.stringify(manifest), async () => {
      const prerequisite = await import("../../../src/addie/eval/fixed-trace-evidence-prerequisite.js");
      expect(prerequisite.fixedTraceEvidencePrerequisiteDiagnostic()).toMatchObject({
        status: "pin_drift", mismatchedFields: ["manifest_shape"],
      });
    });
  });

  it("freezes its private typed drift error", async () => {
    await withManifest("{}", async () => {
      const coordinator = await import("../../../src/addie/eval/fixed-trace-evaluator-coordinator.js");
      try {
        coordinator.fixedTraceEvaluatorCoordinatorUnavailable();
        throw new Error("expected typed drift error");
      } catch (error) {
        expect(error).toMatchObject({ status: "pin_drift", code: "fixed_trace_A_prerequisite_pin_drift" });
        expect(Object.isFrozen(error)).toBe(true);
        expect(Reflect.set(error as object, "status", "ordinary_unavailable")).toBe(false);
      }
    });
  });
});
