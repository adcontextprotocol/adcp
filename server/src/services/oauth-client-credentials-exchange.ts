/**
 * Server-side RFC 6749 §4.4 (OAuth 2.0 Client Credentials) token exchange.
 *
 * Context: PR #2800 added an `oauth_client_credentials` variant to
 * `ResolvedOwnerAuth` (the server's internal auth union for agents
 * with saved credentials), but `@adcp/client`'s `ComplyOptions.auth`
 * and `TestOptions.auth` unions only accept `bearer | basic | oauth`.
 * Passing the client-credentials variant to the SDK is a type error and
 * would also fail at runtime because the SDK doesn't implement the
 * exchange.
 *
 * This module bridges the gap: given a parsed
 * `OAuthClientCredentials` config, resolve `$ENV:ADCP_OAUTH_<NAME>`
 * references, POST to `token_endpoint`, and return a bearer token the
 * SDK can carry. Callers narrow the auth to `{ type: 'bearer', token }`
 * before handing it to the SDK.
 *
 * Tradeoff: no caching / expiry tracking yet. Compliance heartbeat and
 * the registry test paths are both low-frequency (minutes / per-request
 * hit counts, not steady-state traffic), so re-exchanging each call is
 * acceptable. When `@adcp/client` learns native client-credentials
 * support with 401-triggered refresh, this bridge can be removed and
 * the configs passed through untouched.
 */

import type { OAuthClientCredentials } from '../db/agent-context-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('oauth-client-credentials-exchange');

/** Max size we'll read from the token endpoint response to keep a hostile server bounded. */
const MAX_RESPONSE_BYTES = 32 * 1024;
/** Request timeout for the exchange — short to avoid blocking the caller. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/** `$ENV:ADCP_OAUTH_<NAME>` reference pattern, mirroring the input parser. */
const ENV_REFERENCE_PATTERN = /^\$ENV:ADCP_OAUTH_([A-Z0-9_]+)$/;

export type ExchangeResult =
  | { ok: true; access_token: string; expires_in?: number }
  | { ok: false; error: string };

/**
 * Resolve a config value that may be a `$ENV:ADCP_OAUTH_<NAME>`
 * reference. Returns the literal value if there's no prefix, the env
 * var's value if the reference resolves, or `null` when the env var
 * isn't set (treated as a hard failure by the caller).
 */
export function resolveEnvReference(value: string): string | null {
  const match = ENV_REFERENCE_PATTERN.exec(value);
  if (!match) return value;
  const name = `ADCP_OAUTH_${match[1]}`;
  const resolved = process.env[name];
  return resolved !== undefined && resolved !== '' ? resolved : null;
}

/**
 * Perform the client-credentials exchange and return a bearer token.
 *
 * `auth_method` picks between HTTP Basic auth (default, per RFC 6749
 * §2.3.1 recommendation) and credentials-in-body. Some providers
 * require one specifically — the form is caller-controlled.
 *
 * Network failures, non-2xx responses, and malformed JSON all collapse
 * to a single `{ ok: false, error }` so callers have one branch to
 * handle. The token-endpoint response body is capped to 32KB so a
 * hostile server can't stream junk into our process.
 */
export async function exchangeClientCredentials(
  creds: OAuthClientCredentials,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ExchangeResult> {
  const clientId = resolveEnvReference(creds.client_id);
  const clientSecret = resolveEnvReference(creds.client_secret);

  if (clientId === null) {
    return { ok: false, error: 'OAuth client_credentials: client_id env reference did not resolve.' };
  }
  if (clientSecret === null) {
    return { ok: false, error: 'OAuth client_credentials: client_secret env reference did not resolve.' };
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  if (creds.scope) form.set('scope', creds.scope);
  if (creds.resource) form.set('resource', creds.resource);
  if (creds.audience) form.set('audience', creds.audience);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };

  if (creds.auth_method === 'body') {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  } else {
    // RFC 6749 §2.3.1: HTTP Basic is the default, preferred method.
    const encoded = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(creds.token_endpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Don't surface the endpoint's raw error body to the caller —
      // that can contain sensitive diagnostic info; the log has it.
      const preview = await readCapped(response);
      logger.warn(
        { status: response.status, tokenEndpoint: creds.token_endpoint, bodyPreview: preview },
        'OAuth client-credentials exchange returned non-2xx',
      );
      return { ok: false, error: `OAuth client_credentials exchange failed: HTTP ${response.status}` };
    }

    const body = await readCapped(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, error: 'OAuth client_credentials: token endpoint did not return JSON.' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'OAuth client_credentials: token endpoint returned non-object body.' };
    }
    const obj = parsed as Record<string, unknown>;
    const accessToken = obj.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { ok: false, error: 'OAuth client_credentials: token endpoint response missing access_token.' };
    }
    const expiresIn = typeof obj.expires_in === 'number' ? obj.expires_in : undefined;
    return { ok: true, access_token: accessToken, expires_in: expiresIn };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, tokenEndpoint: creds.token_endpoint }, 'OAuth client-credentials exchange threw');
    return { ok: false, error: `OAuth client_credentials exchange failed: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_RESPONSE_BYTES) break;
    }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)), Math.min(total, MAX_RESPONSE_BYTES)).toString('utf8');
}
