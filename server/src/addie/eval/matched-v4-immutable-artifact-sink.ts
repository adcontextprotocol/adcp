/**
 * The production gate for matched-v4 immutable evidence.
 *
 * A local path, chmod, O_EXCL, GitHub Actions identity assertion, or
 * content-addressed R2 upload is not an immutable artifact capability. This
 * module remains deliberately closed until the platform supplies a reviewed
 * WORM/append-only sink or independently signed durable receipt implementation
 * bound to the settlement ledger.
 */
export function assertMatchedV4SanctionedImmutableArtifactSink(): void {
  throw new Error(
    "Matched v4 paid dispatch requires a sanctioned immutable artifact sink adapter",
  );
}
