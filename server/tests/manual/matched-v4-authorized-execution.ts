/**
 * Deliberately blocked local matched-v4 operator entrypoint.
 *
 * A checkout cannot prove that its source is the admitted deployment. The
 * paid runner must instead be launched from a protected deployment with a
 * runtime-bound build attestation; plain environment text is not evidence of
 * the executing source revision.
 */
throw new Error(
  "Matched v4 paid execution is blocked locally: run only from a protected deployment with a runtime-bound build attestation",
);
