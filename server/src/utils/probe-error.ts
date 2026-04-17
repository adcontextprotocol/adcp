/**
 * Coarse classification of agent probe failures so the UI (or an LLM) can
 * differentiate a mistyped URL from a TLS failure without leaking the raw
 * error message — which can contain cache paths, stack frames, or attacker-
 * controlled content from a hostile agent response.
 *
 * When in doubt, return "unknown" rather than guess. The classification is a
 * stable, closed enum — no string interpolation of caller data.
 */
export type ProbeErrorReason = 'network' | 'tls' | 'timeout' | 'protocol' | 'unknown';

/**
 * Inspect an error (and, one level deep, its `cause`) and classify. undici /
 * fetch / node:https all wrap low-level errors in `err.cause.code`, so a
 * naïve `err.code` check misses the common cases.
 */
export function classifyProbeError(err: unknown): ProbeErrorReason {
  if (!(err instanceof Error)) return 'unknown';
  const message = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code;
  const causeCode = (err as { cause?: NodeJS.ErrnoException }).cause?.code;
  const firstCode = code ?? causeCode;

  if (firstCode === 'ETIMEDOUT' || firstCode === 'UND_ERR_CONNECT_TIMEOUT' || /timed?\s*out|timeout/.test(message)) {
    return 'timeout';
  }
  if (
    firstCode === 'ENOTFOUND' ||
    firstCode === 'ECONNREFUSED' ||
    firstCode === 'ECONNRESET' ||
    firstCode === 'EAI_AGAIN' ||
    firstCode === 'UND_ERR_SOCKET'
  ) {
    return 'network';
  }
  if (
    firstCode?.startsWith('ERR_TLS') ||
    firstCode === 'CERT_HAS_EXPIRED' ||
    firstCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    firstCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    /tls|ssl|certificate/.test(message)
  ) {
    return 'tls';
  }
  if (/jsonrpc|mcp|protocol|invalid response|parse error|unexpected token/.test(message)) {
    return 'protocol';
  }
  return 'unknown';
}

/**
 * Human-facing label for a classified reason. Safe for LLM or UI output.
 */
export function probeReasonLabel(reason: ProbeErrorReason): string {
  switch (reason) {
    case 'timeout': return 'timed out';
    case 'network': return 'network / DNS failure';
    case 'tls': return 'TLS / certificate error';
    case 'protocol': return 'MCP / protocol error';
    case 'unknown':
    default: return 'unreachable';
  }
}
