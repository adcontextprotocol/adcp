/**
 * Deliberately non-runnable matched-v4 operator entrypoint.
 *
 * Local filesystem paths cannot produce immutable, decision-grade evidence:
 * an owner can replace even exclusively-created and fsynced files. Paid
 * authority construction independently enforces the same invariant, but this
 * manual command also refuses before reading any execution configuration.
 *
 * A reviewed adapter for a sanctioned append-only/WORM artifact sink, or an
 * independently signed receipt bound to the settlement ledger, must replace
 * this gate before any matched-v4 execution command can be enabled.
 */
throw new Error(
  "Matched v4 paid execution is blocked: configure and implement a sanctioned immutable artifact sink before dispatch",
);
