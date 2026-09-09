/**
 * Deliberately non-runnable matched-v4 operator entrypoint.
 *
 * Local filesystem paths, GitHub Actions identity, and R2 upload-only
 * conventions cannot produce immutable, decision-grade evidence: each can be
 * replaced, deleted, or fail after dispatch. Paid authority construction
 * independently enforces the same invariant, but this manual command also
 * refuses before reading any execution configuration.
 */
throw new Error(
  "Matched v4 paid execution is blocked: configure and implement a sanctioned immutable artifact sink before dispatch",
);
