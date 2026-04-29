/**
 * Redaction helper for `IDEMPOTENCY_CONFLICT` response envelopes.
 *
 * The universal idempotency storyboard's `idempotency.conflict_no_payload_leak`
 * invariant (ships as a default in `@adcp/sdk/testing`) allows only a narrow
 * set of envelope keys on `adcp_error` when `code === 'IDEMPOTENCY_CONFLICT'`:
 * `code, message, status, retry_after, correlation_id, request_id, operation_id`.
 * Any other key is flagged as a potential stolen-key read oracle.
 *
 * `adcpError()` in `@adcp/sdk/server` auto-injects `recovery` for every
 * error it produces, and the framework dispatch path's `IDEMPOTENCY_CONFLICT`
 * branch routes through that builder — the `recovery: "correctable"` string
 * is a constant classification, not prior payload, but the invariant is
 * intentionally strict and flags it all the same. Rather than fork the SDK,
 * the training agent filters the envelope at the HTTP layer before bytes
 * leave the process. Legacy dispatch builds the envelope by hand so does not
 * need this shim.
 */
const CONFLICT_ALLOWED_ENVELOPE_KEYS = new Set([
  'code',
  'message',
  'status',
  'retry_after',
  'correlation_id',
  'request_id',
  'operation_id',
]);

const CONFLICT_CODE = 'IDEMPOTENCY_CONFLICT';

function isConflictEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { code?: unknown }).code === CONFLICT_CODE
  );
}

function stripConflictEnvelope(env: Record<string, unknown>): void {
  for (const key of Object.keys(env)) {
    if (!CONFLICT_ALLOWED_ENVELOPE_KEYS.has(key)) {
      delete env[key];
    }
  }
}

/**
 * Walk a parsed MCP JSON-RPC response, stripping disallowed envelope keys
 * from any `adcp_error` whose `code === 'IDEMPOTENCY_CONFLICT'`. Mutates in
 * place so both the `structuredContent.adcp_error` object and any
 * `content[].text`-embedded copy stay consistent.
 */
export function redactConflictEnvelopes(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) redactConflictEnvelopes(item);
    return;
  }
  const rec = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(rec)) {
    if (key === 'adcp_error' && isConflictEnvelope(child)) {
      stripConflictEnvelope(child);
      continue;
    }
    if (
      key === 'content'
      && Array.isArray(child)
    ) {
      for (const item of child) {
        if (
          item
          && typeof item === 'object'
          && (item as { type?: unknown }).type === 'text'
          && typeof (item as { text?: unknown }).text === 'string'
        ) {
          const textItem = item as { text: string };
          // content[].text is the JSON-text fallback (L2). It must stay in
          // sync with structuredContent so buyers that read either surface
          // see the same envelope.
          let parsed: unknown;
          try {
            parsed = JSON.parse(textItem.text);
          } catch {
            continue;
          }
          if (
            parsed
            && typeof parsed === 'object'
            && isConflictEnvelope((parsed as { adcp_error?: unknown }).adcp_error)
          ) {
            stripConflictEnvelope((parsed as { adcp_error: Record<string, unknown> }).adcp_error);
            textItem.text = JSON.stringify(parsed);
          }
        }
      }
      continue;
    }
    redactConflictEnvelopes(child);
  }
}

/**
 * Parse a JSON body, redact any `IDEMPOTENCY_CONFLICT` envelopes in place,
 * and return the re-serialized JSON. Returns the original body unchanged
 * when parsing fails — non-JSON responses (transport errors, SSE frames)
 * pass through untouched.
 */
export function redactConflictEnvelopeInBody(body: string): string {
  if (!body.includes(CONFLICT_CODE)) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  redactConflictEnvelopes(parsed);
  return JSON.stringify(parsed);
}
