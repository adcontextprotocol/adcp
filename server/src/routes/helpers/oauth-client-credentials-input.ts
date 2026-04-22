/**
 * Parse and validate untrusted `oauth_client_credentials` input for the
 * Test-your-agent save paths. Shared between the REST endpoint
 * (`PUT /registry/agents/:url/oauth-client-credentials`) and the Addie
 * `save_agent` MCP tool so both apply identical rules — any divergence
 * reopens SSRF or env-var exfiltration surfaces one of the paths closed.
 */

import type { OAuthClientCredentials } from '../../db/agent-context-db.js';

/**
 * `$ENV:VAR_NAME` references resolved at exchange time by `@adcp/client`.
 * Constrained to an OAuth-scoped namespace so a caller with save access
 * cannot smuggle an unrelated server env var (`DATABASE_URL`,
 * `ENCRYPTION_SECRET`, cloud credentials, …) into `client_id` /
 * `client_secret` and exfiltrate it to a chosen token endpoint.
 *
 * Operators who want to wire secrets through environment variables
 * must name them with the `ADCP_OAUTH_` prefix.
 */
const ENV_REFERENCE_PATTERN = /^\$ENV:ADCP_OAUTH_[A-Z0-9_]+$/;
const ENV_REFERENCE_ERROR =
  '$ENV references must match pattern $ENV:ADCP_OAUTH_<NAME> (uppercase alphanumeric + underscore). Other env-var names are not accepted as credential references.';

export type ParseOAuthClientCredentialsResult =
  | { ok: true; creds: OAuthClientCredentials }
  | { ok: false; error: string };

export interface ParseOAuthClientCredentialsOptions {
  /** Returns the raw URL on success, null if the endpoint fails SSRF / scheme checks. */
  validateTokenEndpoint: (url: string) => string | null;
}

export function parseOAuthClientCredentialsInput(
  input: unknown,
  opts: ParseOAuthClientCredentialsOptions,
): ParseOAuthClientCredentialsResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'oauth_client_credentials must be an object with token_endpoint, client_id, and client_secret.' };
  }
  const cc = input as Record<string, unknown>;

  if (typeof cc.token_endpoint !== 'string' || !cc.token_endpoint) {
    return { ok: false, error: 'oauth_client_credentials.token_endpoint is required.' };
  }
  if (!opts.validateTokenEndpoint(cc.token_endpoint)) {
    return {
      ok: false,
      error:
        'oauth_client_credentials.token_endpoint failed URL validation. Must be https:// (http://localhost is allowed in development), and cannot be a cloud metadata or private-network host.',
    };
  }

  if (typeof cc.client_id !== 'string' || !cc.client_id) {
    return { ok: false, error: 'oauth_client_credentials.client_id is required.' };
  }
  if (cc.client_id.length > 2048) {
    return { ok: false, error: 'oauth_client_credentials.client_id exceeds maximum length.' };
  }
  if (cc.client_id.startsWith('$ENV:') && !ENV_REFERENCE_PATTERN.test(cc.client_id)) {
    return { ok: false, error: `oauth_client_credentials.client_id: ${ENV_REFERENCE_ERROR}` };
  }

  if (typeof cc.client_secret !== 'string' || !cc.client_secret) {
    return {
      ok: false,
      error:
        'oauth_client_credentials.client_secret is required. Use $ENV:ADCP_OAUTH_<NAME> to reference an environment variable.',
    };
  }
  if (cc.client_secret.length > 8192) {
    return { ok: false, error: 'oauth_client_credentials.client_secret exceeds maximum length.' };
  }
  if (cc.client_secret.startsWith('$ENV:') && !ENV_REFERENCE_PATTERN.test(cc.client_secret)) {
    return { ok: false, error: `oauth_client_credentials.client_secret: ${ENV_REFERENCE_ERROR}` };
  }

  const scope = parseOptionalString(cc.scope, 1024, 'oauth_client_credentials.scope');
  if (typeof scope === 'object' && scope && 'error' in scope) return { ok: false, error: scope.error };
  const resource = parseOptionalString(cc.resource, 2048, 'oauth_client_credentials.resource');
  if (typeof resource === 'object' && resource && 'error' in resource) return { ok: false, error: resource.error };
  const audience = parseOptionalString(cc.audience, 2048, 'oauth_client_credentials.audience');
  if (typeof audience === 'object' && audience && 'error' in audience) return { ok: false, error: audience.error };

  let authMethod: 'basic' | 'body' | undefined;
  if (cc.auth_method !== undefined && cc.auth_method !== null && cc.auth_method !== '') {
    if (cc.auth_method !== 'basic' && cc.auth_method !== 'body') {
      return { ok: false, error: 'oauth_client_credentials.auth_method must be "basic" or "body".' };
    }
    authMethod = cc.auth_method;
  }

  return {
    ok: true,
    creds: {
      token_endpoint: cc.token_endpoint,
      client_id: cc.client_id,
      client_secret: cc.client_secret,
      ...(typeof scope === 'string' && scope && { scope }),
      ...(typeof resource === 'string' && resource && { resource }),
      ...(typeof audience === 'string' && audience && { audience }),
      ...(authMethod && { auth_method: authMethod }),
    },
  };
}

function parseOptionalString(
  value: unknown,
  max: number,
  field: string,
): string | null | { error: string } {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return { error: `${field} must be a string.` };
  if (value.length > max) return { error: `${field} exceeds maximum length.` };
  return value;
}
