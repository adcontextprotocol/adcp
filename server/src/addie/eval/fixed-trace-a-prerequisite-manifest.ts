/**
 * A dependency-free serialized mirror of A's prerequisite declarations.
 *
 * This module exports data only. B accepts only a bounded, byte-for-byte
 * canonical primitive source; it never parses caller-provided JSON. A's
 * executable protocol independently derives and validates every leaf.
 */
export const FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES = 16 * 1024;

export const FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON = `{"version":"addie-fixed-trace-A-prerequisite-manifest-v3","protocolVersion":"addie-fixed-trace-evaluation-protocol-v3","corpus":{"suiteVersion":"addie-fixed-traces-v32","suiteSha256":"5f7f0a6d653a4757991728a1d9de8aee69b40d580dafb65e98941c1f9e3fea83"},"partitionManifestSha256":"99a0727723fd84bcc4c7f40852a0e2392b578964bb4e7b0954739946451e4b96","experimentalDesignFingerprint":"6d35e07721616ac18922de4bdd99085c36e0a55b438a551d35d98389ddf3079c","measurement":{"version":"addie-fixed-trace-measurement-manifest-v1","sha256":"c465bc7b5b69f3bf6e8151a5b4ff57d10d630d3f8ddc64c1cce4d504ad80fb5a"},"authorityDigests":{"finalPrerequisitesSha256":"fa4755eb1357c6a52bfe59f71b95700dd33d1cce66cee414847c8d14d29a8623"},"finalPrerequisites":{"randomization":{"scheduleDigest":null,"episodeClusterManifestDigest":null},"pricingWindow":{"id":null,"effectiveFrom":null,"effectiveBefore":null,"digest":null},"calibration":{"status":"unavailable","allowedRelationshipToScoredDevelopment":"separate_or_cross_fitted_only","digest":null},"custody":{"status":"unavailable","custodianIdentity":null,"packDigest":null,"signature":null,"collisionAuditDigest":null},"providerExposure":{"status":"unavailable","digest":null}}}` as const;

/** The only value B consumes; tests may replace this import to prove refusal. */
export const FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON =
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON;
