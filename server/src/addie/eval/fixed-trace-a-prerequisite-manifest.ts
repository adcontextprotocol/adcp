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
