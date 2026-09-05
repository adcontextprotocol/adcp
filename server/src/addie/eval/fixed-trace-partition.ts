import { createHash } from "node:crypto";
import {
  FIXED_TRACE_CORPUS,
  FIXED_TRACE_PHASE_COUNTS,
} from "./fixed-trace-suite.js";

/**
 * This ID-only manifest is the partition boundary. It deliberately contains
 * no fixture text, expected routes, or grading rubric.
 */
export const FIXED_TRACE_PARTITION_MANIFEST_VERSION =
  "addie-fixed-trace-partition-v2" as const;
export const FIXED_TRACE_PARTITION_MANIFEST = Object.freeze({
  version: FIXED_TRACE_PARTITION_MANIFEST_VERSION,
  /** Derived from the corpus authority, never a stale hand-copied list. */
  development: Object.freeze(
    FIXED_TRACE_CORPUS.filter((trace) => trace.phase === "development").map(
      (trace) => trace.id,
    ),
  ),
  tuning: Object.freeze(
    FIXED_TRACE_CORPUS.filter((trace) => trace.phase === "tuning").map(
      (trace) => trace.id,
    ),
  ),
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Partition manifest contains a non-JSON value");
}

export function fixedTracePartitionManifestSha256(): string {
  return createHash("sha256")
    .update(canonicalJson(FIXED_TRACE_PARTITION_MANIFEST), "utf8")
    .digest("hex");
}

export const FIXED_TRACE_PARTITION_MANIFEST_SHA256 =
  fixedTracePartitionManifestSha256();

export function assertFixedTracePartitionManifest(): void {
  if (
    fixedTracePartitionManifestSha256() !==
    FIXED_TRACE_PARTITION_MANIFEST_SHA256
  ) {
    throw new Error("Fixed-trace partition manifest hash mismatch");
  }
  const all = [
    ...FIXED_TRACE_PARTITION_MANIFEST.development,
    ...FIXED_TRACE_PARTITION_MANIFEST.tuning,
  ];
  if (new Set(all).size !== all.length)
    throw new Error("Fixed-trace partition manifest has duplicate IDs");
  if (
    FIXED_TRACE_PARTITION_MANIFEST.development.length !==
      FIXED_TRACE_PHASE_COUNTS.development ||
    FIXED_TRACE_PARTITION_MANIFEST.tuning.length !==
      FIXED_TRACE_PHASE_COUNTS.tuning ||
    FIXED_TRACE_PHASE_COUNTS.sealed_final !== 0 ||
    all.length !== 82
  ) {
    throw new Error(
      "Fixed-trace partition manifest does not match the 46 development / 36 tuning corpus authority",
    );
  }
}
