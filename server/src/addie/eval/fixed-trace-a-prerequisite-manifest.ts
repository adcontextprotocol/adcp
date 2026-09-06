/**
 * Dependency-free, immutable description of the merged A planning artifact.
 *
 * This is intentionally data only: importing it must not traverse corpus,
 * tool, provider, pricing, billing, logging, authentication, or environment
 * configuration modules. Updating A requires a separately reviewed update to
 * this manifest and B's independent pin.
 */
export interface FixedTraceAUnavailableDescriptor {
  readonly status: "unavailable";
  readonly digest: null;
}

export interface FixedTraceAPurePrerequisiteManifest {
  readonly version: "addie-fixed-trace-A-prerequisite-manifest-v1";
  readonly sourceCommit: "5094c5c0242ea10c2fd8452a21c0ea1bf33a68a3";
  readonly protocolFingerprint: "b9ef28a8451ca606bbc77e48ff709405e90290c55833bb76e8047a7633e6c7dd";
  readonly corpus: {
    readonly suiteVersion: "addie-fixed-traces-v32";
    readonly suiteSha256: "5f7f0a6d653a4757991728a1d9de8aee69b40d580dafb65e98941c1f9e3fea83";
  };
  readonly partitionManifestSha256: "99a0727723fd84bcc4c7f40852a0e2392b578964bb4e7b0954739946451e4b96";
  readonly experimentalDesignFingerprint: "d4f54eae99a90426ba43c5a4a26a7196102bc524537cdec56d32f0df8d9fb153";
  readonly measurementManifestSha256: "ba46e9ddd18171602b4d17ff0e5bf6e1ad6bfee997236bdb1b345c3c817a41e0";
  readonly schedule: FixedTraceAUnavailableDescriptor;
  readonly pricingWindow: FixedTraceAUnavailableDescriptor & {
    readonly cohortId: null;
    readonly effectiveFrom: null;
    readonly effectiveBefore: null;
  };
  readonly calibration: FixedTraceAUnavailableDescriptor;
  /** A-owned declaration: C has no authenticated exposure producer yet. */
  readonly providerExposure: FixedTraceAUnavailableDescriptor;
  readonly custody: FixedTraceAUnavailableDescriptor;
}

export const FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST:
  FixedTraceAPurePrerequisiteManifest = Object.freeze({
    version: "addie-fixed-trace-A-prerequisite-manifest-v1",
    sourceCommit: "5094c5c0242ea10c2fd8452a21c0ea1bf33a68a3",
    protocolFingerprint: "b9ef28a8451ca606bbc77e48ff709405e90290c55833bb76e8047a7633e6c7dd",
    corpus: Object.freeze({
      suiteVersion: "addie-fixed-traces-v32",
      suiteSha256: "5f7f0a6d653a4757991728a1d9de8aee69b40d580dafb65e98941c1f9e3fea83",
    }),
    partitionManifestSha256: "99a0727723fd84bcc4c7f40852a0e2392b578964bb4e7b0954739946451e4b96",
    experimentalDesignFingerprint: "d4f54eae99a90426ba43c5a4a26a7196102bc524537cdec56d32f0df8d9fb153",
    measurementManifestSha256: "ba46e9ddd18171602b4d17ff0e5bf6e1ad6bfee997236bdb1b345c3c817a41e0",
    schedule: Object.freeze({ status: "unavailable", digest: null }),
    pricingWindow: Object.freeze({
      status: "unavailable", digest: null, cohortId: null,
      effectiveFrom: null, effectiveBefore: null,
    }),
    calibration: Object.freeze({ status: "unavailable", digest: null }),
    providerExposure: Object.freeze({ status: "unavailable", digest: null }),
    custody: Object.freeze({ status: "unavailable", digest: null }),
  });

class FixedTraceAPurePrerequisiteManifestValidationError extends Error {
  readonly status = "pin_drift" as const;
  readonly code = "fixed_trace_A_prerequisite_manifest_invalid" as const;

  constructor() {
    super("fixed_trace_A_prerequisite_manifest_invalid");
    this.name = "FixedTraceAPurePrerequisiteManifestValidationError";
    Object.freeze(this);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function unavailableDescriptor(value: unknown, pricing = false): boolean {
  if (!isRecord(value)) return false;
  const keys = pricing
    ? ["status", "digest", "cohortId", "effectiveFrom", "effectiveBefore"]
    : ["status", "digest"];
  return exactKeys(value, keys) && value.status === "unavailable" && value.digest === null
    && (!pricing || (value.cohortId === null && value.effectiveFrom === null && value.effectiveBefore === null));
}

/**
 * Validate and detach a pure A manifest. This is a data-boundary helper, not
 * an admission or execution API; B uses it to contain malformed hot-reloads.
 */
export function validateFixedTraceAPurePrerequisiteManifest(
  candidate: unknown,
): FixedTraceAPurePrerequisiteManifest {
  try {
    const manifest = candidate;
    if (!isRecord(manifest) || !exactKeys(manifest, [
      "version", "sourceCommit", "protocolFingerprint", "corpus",
      "partitionManifestSha256", "experimentalDesignFingerprint",
      "measurementManifestSha256", "schedule", "pricingWindow", "calibration",
      "providerExposure", "custody",
    ]) || !isRecord(manifest.corpus)
      || !exactKeys(manifest.corpus, ["suiteVersion", "suiteSha256"])
      || typeof manifest.version !== "string" || typeof manifest.sourceCommit !== "string"
      || typeof manifest.protocolFingerprint !== "string"
      || typeof manifest.corpus.suiteVersion !== "string" || typeof manifest.corpus.suiteSha256 !== "string"
      || typeof manifest.partitionManifestSha256 !== "string"
      || typeof manifest.experimentalDesignFingerprint !== "string"
      || typeof manifest.measurementManifestSha256 !== "string"
      || !unavailableDescriptor(manifest.schedule)
      || !unavailableDescriptor(manifest.pricingWindow, true)
      || !unavailableDescriptor(manifest.calibration)
      || !unavailableDescriptor(manifest.providerExposure)
      || !unavailableDescriptor(manifest.custody)
    ) throw new FixedTraceAPurePrerequisiteManifestValidationError();
    return snapshotFixedTraceAPurePrerequisiteManifest(
      manifest as unknown as FixedTraceAPurePrerequisiteManifest,
    );
  } catch (error) {
    if (error instanceof FixedTraceAPurePrerequisiteManifestValidationError) throw error;
    throw new FixedTraceAPurePrerequisiteManifestValidationError();
  }
}

function snapshotFixedTraceAPurePrerequisiteManifest(
  manifest: FixedTraceAPurePrerequisiteManifest,
): FixedTraceAPurePrerequisiteManifest {
  return Object.freeze({
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    protocolFingerprint: manifest.protocolFingerprint,
    corpus: Object.freeze({
      suiteVersion: manifest.corpus.suiteVersion,
      suiteSha256: manifest.corpus.suiteSha256,
    }),
    partitionManifestSha256: manifest.partitionManifestSha256,
    experimentalDesignFingerprint: manifest.experimentalDesignFingerprint,
    measurementManifestSha256: manifest.measurementManifestSha256,
    schedule: Object.freeze({
      status: manifest.schedule.status,
      digest: manifest.schedule.digest,
    }),
    pricingWindow: Object.freeze({
      status: manifest.pricingWindow.status,
      digest: manifest.pricingWindow.digest,
      cohortId: manifest.pricingWindow.cohortId,
      effectiveFrom: manifest.pricingWindow.effectiveFrom,
      effectiveBefore: manifest.pricingWindow.effectiveBefore,
    }),
    calibration: Object.freeze({
      status: manifest.calibration.status,
      digest: manifest.calibration.digest,
    }),
    providerExposure: Object.freeze({
      status: manifest.providerExposure.status,
      digest: manifest.providerExposure.digest,
    }),
    custody: Object.freeze({
      status: manifest.custody.status,
      digest: manifest.custody.digest,
    }),
  });
}

export function fixedTraceAPurePrerequisiteManifest(): FixedTraceAPurePrerequisiteManifest {
  return validateFixedTraceAPurePrerequisiteManifest(
    FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
  );
}
