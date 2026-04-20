/**
 * Presence-gated authenticator for the grader-targeted `/mcp-strict` route.
 *
 * Behaviour matrix (vs. the default `/mcp` route's `anyOf(bearers, signing)`):
 *
 * | Signature header | Signature valid | Bearer | Strict result                          |
 * |------------------|-----------------|--------|----------------------------------------|
 * | yes              | yes             | *      | accept (signing principal)             |
 * | yes              | no              | *      | 401 (do not fall through to bearer)    |
 * | no               | —               | yes    | bearer accepted if op ∉ required_for;  |
 * |                  |                 |        | otherwise 401 `request_signature_required` |
 * | no               | —               | no     | 401 (unauthorized)                     |
 *
 * The default `/mcp` route uses `anyOf(bearers, signingAuth)` which (a) lets
 * present-but-invalid signatures fall through to bearer and (b) doesn't
 * enforce `required_for` because `verifySignatureAsAuthenticator` returns
 * `null` on unsigned requests before the verifier's `required_for` check
 * runs. Strict mode closes both gaps locally; upstream SDK helper tracked in
 * adcp-client#659.
 */

import { AuthError, type Authenticator, type AuthPrincipal } from '@adcp/client/server';
import type { IncomingMessage } from 'node:http';

/** Extract the MCP operation name from a JSON-RPC `tools/call` request body.
 *  Prefers `req.body` (populated by `express.json()`) and falls back to
 *  `req.rawBody` when body parsing ran after this authenticator (raw HTTP
 *  paths). Returns `undefined` for non-tools/call methods or unparseable
 *  bodies — those are not covered by `required_for`, so the caller falls
 *  through to bearer. */
function extractOperation(req: IncomingMessage & { body?: unknown; rawBody?: string }): string | undefined {
  const parsed = req.body as { method?: string; params?: { name?: string } } | undefined;
  if (parsed && typeof parsed === 'object' && parsed.method === 'tools/call' && typeof parsed.params?.name === 'string') {
    return parsed.params.name;
  }
  const raw = req.rawBody;
  if (!raw) return undefined;
  try {
    const body = JSON.parse(raw) as { method?: string; params?: { name?: string } };
    if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
      return body.params.name;
    }
  } catch {
    // Malformed body — MCP transport will reject downstream.
  }
  return undefined;
}

function hasSignatureHeader(req: IncomingMessage): boolean {
  const v = req.headers['signature-input'];
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

/**
 * Sentinel thrown when an unsigned request targets an operation listed in
 * `required_for`. The route's `requireToken` wrapper catches this and
 * surfaces error code `request_signature_required` in the 401 body
 * (instead of the generic `invalid_token` / `Credentials rejected.` that
 * `anyOf` would produce).
 */
export class RequestSignatureRequiredError extends AuthError {
  readonly operation: string;
  constructor(operation: string) {
    super(`Operation "${operation}" requires a signed request.`);
    this.name = 'RequestSignatureRequiredError';
    this.operation = operation;
  }
}

export interface StrictAuthenticatorOptions {
  /** Bearer authenticator chain (typically `anyOf(verifyApiKey(...), verifyApiKey(workos))`).
   *  Runs only when the request is unsigned AND the operation is not in `requiredFor`. */
  bearerAuth: Authenticator;
  /** Signing authenticator (typically `verifySignatureAsAuthenticator(...)`).
   *  Runs only when the request carries `Signature-Input` — throws `AuthError`
   *  on verification failure, which the wrapper re-throws without bearer fallthrough. */
  signingAuth: Authenticator;
  /** Operations that MUST be signed on this route. Unsigned calls to any
   *  listed op throw `RequestSignatureRequiredError`. */
  requiredFor: readonly string[];
}

/**
 * Compose a presence-gated authenticator. See file header for the behaviour
 * matrix. The returned `Authenticator` is drop-in compatible with the
 * SDK's middleware (same signature as `anyOf` / `verifyApiKey` etc.).
 */
export function strictSignatureAuthenticator(options: StrictAuthenticatorOptions): Authenticator {
  const requiredForSet = new Set(options.requiredFor);

  return async (req): Promise<AuthPrincipal | null> => {
    if (hasSignatureHeader(req)) {
      // Signature present → MUST verify. Invalid signatures throw AuthError
      // and the 401 propagates without bearer fallthrough.
      return await options.signingAuth(req);
    }

    // Unsigned. Fire `request_signature_required` before the bearer chain
    // so grader vector 001 sees the canonical error code.
    const operation = extractOperation(req);
    if (operation && requiredForSet.has(operation)) {
      throw new RequestSignatureRequiredError(operation);
    }

    // Not required — fall through to bearer. Discovery probes, list_tools,
    // and non-mutating reads keep working without signing infrastructure.
    return await options.bearerAuth(req);
  };
}
