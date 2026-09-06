import { describe, expect, it, vi } from "vitest";
import {
  FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  fixedTraceEvaluatorCoordinatorUnavailable,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";
import {
  FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
  fixedTraceAPurePrerequisiteManifest,
} from "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js";
import {
  FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN,
  fixedTraceEvidencePrerequisiteDiagnostic,
} from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";
import * as prerequisiteExports from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";

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
    expect(pin.version).toBe(manifest.version);
    expect(pin.sourceCommit).toBe(manifest.sourceCommit);
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
    expect("FixedTraceEvidencePrerequisitePinDriftError" in prerequisiteExports).toBe(false);
  });

  it("takes a detached deeply frozen A snapshot before B compares its pin", () => {
    const snapshot = fixedTraceAPurePrerequisiteManifest();
    expect(snapshot).not.toBe(FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.corpus)).toBe(true);
    expect(Object.isFrozen(snapshot.schedule)).toBe(true);
    expect(Object.isFrozen(snapshot.pricingWindow)).toBe(true);
    expect(Object.isFrozen(snapshot.calibration)).toBe(true);
    expect(Object.isFrozen(snapshot.providerExposure)).toBe(true);
    expect(Object.isFrozen(snapshot.custody)).toBe(true);
  });

  it("does not inspect extra hostile arguments, including accessors, traps, cycles, or coercion", () => {
    const hostile = hostileArguments();
    const entry = fixedTraceEvaluatorCoordinatorUnavailable as unknown as (...args: unknown[]) => unknown;
    expect(entry(...hostile.values)).toMatchObject({ status: "unavailable" });
    expect(hostile.reads).toEqual({ getter: 0, get: 0, ownKeys: 0, primitive: 0, json: 0 });
  });

  it.each([
    ["version", (manifest: any) => ({ ...manifest, version: "drift" })],
    ["sourceCommit", (manifest: any) => ({ ...manifest, sourceCommit: "drift" })],
    ["protocolFingerprint", (manifest: any) => ({ ...manifest, protocolFingerprint: "0".repeat(64) })],
    ["corpus.suiteVersion", (manifest: any) => ({ ...manifest, corpus: { ...manifest.corpus, suiteVersion: "drift" } })],
    ["corpus.suiteSha256", (manifest: any) => ({ ...manifest, corpus: { ...manifest.corpus, suiteSha256: "0".repeat(64) } })],
    ["partitionManifestSha256", (manifest: any) => ({ ...manifest, partitionManifestSha256: "0".repeat(64) })],
    ["experimentalDesignFingerprint", (manifest: any) => ({ ...manifest, experimentalDesignFingerprint: "0".repeat(64) })],
    ["measurementManifestSha256", (manifest: any) => ({ ...manifest, measurementManifestSha256: "0".repeat(64) })],
    ["schedule.status", (manifest: any) => ({ ...manifest, schedule: { ...manifest.schedule, status: "available" } })],
    ["schedule.digest", (manifest: any) => ({ ...manifest, schedule: { ...manifest.schedule, digest: "0".repeat(64) } })],
    ["pricingWindow.status", (manifest: any) => ({ ...manifest, pricingWindow: { ...manifest.pricingWindow, status: "available" } })],
    ["pricingWindow.digest", (manifest: any) => ({ ...manifest, pricingWindow: { ...manifest.pricingWindow, digest: "0".repeat(64) } })],
    ["pricingWindow.cohortId", (manifest: any) => ({ ...manifest, pricingWindow: { ...manifest.pricingWindow, cohortId: "cohort" } })],
    ["pricingWindow.effectiveFrom", (manifest: any) => ({ ...manifest, pricingWindow: { ...manifest.pricingWindow, effectiveFrom: "2026-01-01T00:00:00Z" } })],
    ["pricingWindow.effectiveBefore", (manifest: any) => ({ ...manifest, pricingWindow: { ...manifest.pricingWindow, effectiveBefore: "2026-01-01T00:00:00Z" } })],
    ["calibration.status", (manifest: any) => ({ ...manifest, calibration: { ...manifest.calibration, status: "available" } })],
    ["calibration.digest", (manifest: any) => ({ ...manifest, calibration: { ...manifest.calibration, digest: "0".repeat(64) } })],
    ["providerExposure.status", (manifest: any) => ({ ...manifest, providerExposure: { ...manifest.providerExposure, status: "available" } })],
    ["providerExposure.digest", (manifest: any) => ({ ...manifest, providerExposure: { ...manifest.providerExposure, digest: "0".repeat(64) } })],
    ["custody.status", (manifest: any) => ({ ...manifest, custody: { ...manifest.custody, status: "available" } })],
    ["custody.digest", (manifest: any) => ({ ...manifest, custody: { ...manifest.custody, digest: "0".repeat(64) } })],
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
        fixedTraceAPurePrerequisiteManifest: () => Object.freeze(
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
        reason: "manifest_invalid_or_pin_mismatch",
        mismatchedFields: [
          ["schedule", "pricingWindow", "calibration", "providerExposure", "custody"].some((prefix) => field.startsWith(`${prefix}.`))
            ? "manifest_shape"
            : field,
        ],
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

  it("turns a malformed reloaded manifest into a frozen typed drift diagnostic", async () => {
    vi.resetModules();
    vi.doMock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js", async () => {
      const actual = await vi.importActual<typeof import("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js")>(
        "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js",
      );
      return {
        ...actual,
        FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST: Object.freeze({
          ...actual.FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
          corpus: undefined,
        }),
        fixedTraceAPurePrerequisiteManifest: () => Object.freeze({
          ...actual.FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
          corpus: undefined,
        }) as never,
      };
    });
    try {
      const prerequisite = await import("../../../src/addie/eval/fixed-trace-evidence-prerequisite.js");
      const coordinator = await import("../../../src/addie/eval/fixed-trace-evaluator-coordinator.js");
      expect(prerequisite.fixedTraceEvidencePrerequisiteDiagnostic()).toEqual({
        status: "pin_drift",
        code: "fixed_trace_A_prerequisite_pin_drift",
        reason: "manifest_invalid_or_pin_mismatch",
        mismatchedFields: ["manifest_shape"],
      });
      try {
        coordinator.fixedTraceEvaluatorCoordinatorUnavailable();
        throw new Error("expected typed drift error");
      } catch (error) {
        expect(error).toMatchObject({
          name: "FixedTraceEvidencePrerequisitePinDriftError",
          status: "pin_drift",
          code: "fixed_trace_A_prerequisite_pin_drift",
          diagnostic: { mismatchedFields: ["manifest_shape"] },
        });
        expect(Object.isFrozen(error)).toBe(true);
        expect(Object.isFrozen((error as { diagnostic: unknown }).diagnostic)).toBe(true);
        expect(Reflect.set(error as object, "status", "ordinary_unavailable")).toBe(false);
        expect(Reflect.set(error as object, "code", "mutated")).toBe(false);
      }
    } finally {
      vi.doUnmock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js");
      vi.resetModules();
    }
  });

  it.each([
    ["missing root", () => undefined],
    ["empty root", () => ({})],
    ["missing corpus", () => ({ ...FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST, corpus: undefined })],
    ["unknown root key", () => ({ ...FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST, extra: true })],
    ["throwing proxy", () => new Proxy({}, {
      ownKeys: () => { throw new Error("ownKeys"); },
      get: () => { throw new Error("get"); },
    })],
  ])("contains malformed reloaded A state (%s) at the frozen typed drift boundary", async (_name, produce) => {
    vi.resetModules();
    vi.doMock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js", async () => {
      const actual = await vi.importActual<typeof import("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js")>(
        "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js",
      );
      return {
        ...actual,
        fixedTraceAPurePrerequisiteManifest: () => produce() as never,
      };
    });
    try {
      const prerequisite = await import("../../../src/addie/eval/fixed-trace-evidence-prerequisite.js");
      expect(prerequisite.fixedTraceEvidencePrerequisiteDiagnostic()).toEqual({
        status: "pin_drift",
        code: "fixed_trace_A_prerequisite_pin_drift",
        reason: "manifest_invalid_or_pin_mismatch",
        mismatchedFields: ["manifest_shape"],
      });
      expect(() => prerequisite.assertFixedTraceEvidencePrerequisitePinned())
        .toThrow("fixed_trace_A_prerequisite_pin_drift");
    } finally {
      vi.doUnmock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js");
      vi.resetModules();
    }
  });
});
