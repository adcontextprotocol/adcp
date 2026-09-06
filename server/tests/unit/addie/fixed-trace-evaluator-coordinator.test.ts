import { describe, expect, it, vi } from "vitest";
import {
  FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  fixedTraceEvaluatorCoordinatorUnavailable,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";
import {
  FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
} from "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js";
import {
  FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN,
  fixedTraceEvidencePrerequisiteDiagnostic,
} from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";

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

  it("pins every pure A fingerprint and unavailable descriptor, including exposure", () => {
    const pin = FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN;
    const manifest = FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST;
    expect(pin.protocolFingerprint).toBe(manifest.protocolFingerprint);
    expect(pin.corpusSuiteVersion).toBe(manifest.corpus.suiteVersion);
    expect(pin.corpusSuiteSha256).toBe(manifest.corpus.suiteSha256);
    expect(pin.partitionManifestSha256).toBe(manifest.partitionManifestSha256);
    expect(pin.experimentalDesignFingerprint).toBe(manifest.experimentalDesignFingerprint);
    expect(pin.measurementManifestSha256).toBe(manifest.measurementManifestSha256);
    expect(pin.schedule).toEqual(manifest.schedule);
    expect(pin.pricingWindow).toEqual(manifest.pricingWindow);
    expect(pin.calibration).toEqual(manifest.calibration);
    expect(pin.providerExposure).toEqual(manifest.providerExposure);
    expect(pin.custody).toEqual(manifest.custody);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it("does not inspect extra hostile arguments, including accessors, traps, cycles, or coercion", () => {
    const hostile = hostileArguments();
    const entry = fixedTraceEvaluatorCoordinatorUnavailable as unknown as (...args: unknown[]) => unknown;
    expect(entry(...hostile.values)).toMatchObject({ status: "unavailable" });
    expect(hostile.reads).toEqual({ getter: 0, get: 0, ownKeys: 0, primitive: 0, json: 0 });
  });

  it.each([
    ["protocolFingerprint", (manifest: any) => ({ ...manifest, protocolFingerprint: "0".repeat(64) })],
    ["corpus.suiteVersion", (manifest: any) => ({ ...manifest, corpus: { ...manifest.corpus, suiteVersion: "drift" } })],
    ["corpus.suiteSha256", (manifest: any) => ({ ...manifest, corpus: { ...manifest.corpus, suiteSha256: "0".repeat(64) } })],
    ["partitionManifestSha256", (manifest: any) => ({ ...manifest, partitionManifestSha256: "0".repeat(64) })],
    ["experimentalDesignFingerprint", (manifest: any) => ({ ...manifest, experimentalDesignFingerprint: "0".repeat(64) })],
    ["measurementManifestSha256", (manifest: any) => ({ ...manifest, measurementManifestSha256: "0".repeat(64) })],
    ["schedule", (manifest: any) => ({ ...manifest, schedule: { ...manifest.schedule, digest: "0".repeat(64) } })],
    ["pricingWindow", (manifest: any) => ({ ...manifest, pricingWindow: { ...manifest.pricingWindow, digest: "0".repeat(64) } })],
    ["calibration", (manifest: any) => ({ ...manifest, calibration: { ...manifest.calibration, digest: "0".repeat(64) } })],
    ["providerExposure", (manifest: any) => ({ ...manifest, providerExposure: { ...manifest.providerExposure, digest: "0".repeat(64) } })],
    ["custody", (manifest: any) => ({ ...manifest, custody: { ...manifest.custody, digest: "0".repeat(64) } })],
  ])("reports reloaded %s drift distinctly rather than swallowing it", async (field, mutate) => {
    vi.resetModules();
    vi.doMock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js", async () => {
      const actual = await vi.importActual<typeof import("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js")>(
        "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js",
      );
      return {
        ...actual,
        FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST: Object.freeze(
          mutate(actual.FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST),
        ),
      };
    });
    try {
      const prerequisite = await import("../../../src/addie/eval/fixed-trace-evidence-prerequisite.js");
      const coordinator = await import("../../../src/addie/eval/fixed-trace-evaluator-coordinator.js");
      const judge = await import("../../../src/addie/eval/fixed-trace-judge.js");
      expect(prerequisite.fixedTraceEvidencePrerequisiteDiagnostic()).toEqual({
        status: "pin_drift",
        code: "fixed_trace_A_prerequisite_pin_drift",
        mismatchedFields: [field],
      });
      expect(() => coordinator.fixedTraceEvaluatorCoordinatorUnavailable())
        .toThrow("fixed_trace_A_prerequisite_pin_drift");
      expect(() => judge.fixedTraceJudgeUnavailable())
        .toThrow("fixed_trace_A_prerequisite_pin_drift");
    } finally {
      vi.doUnmock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js");
      vi.resetModules();
    }
  });
});
