/**
 * Parse and validate untrusted `oauth_client_credentials` input for the
 * Test-your-agent save paths. Shared between the REST endpoint
 * (`PUT /registry/agents/:url/oauth-client-credentials`) and the Addie
 * `save_agent` MCP tool so both apply identical rules — any divergence
 * reopens SSRF or env-var exfiltration surfaces one of the paths closed.
 *
 * Failure results carry a `code` + `field` tag alongside the human-readable
 * `error`. Callers that surface the response to an operator (the dashboard
 * form) can map `code` to localized prose and scroll to `field`. Tool
 * callers that just hand the string to an LLM can ignore them.
 */

import type { OAuthClientCredentials } from '../../db/agent-context-db.js';

/**
 * `$ENV:VAR_NAME` references resolved at exchange time by `@adcp/sdk`.
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

/**
 * Field names that can be reported back as `field` on a rejection. UI uses
 * these to scroll-into-view and highlight the offending input.
 */
export type ParseOAuthClientCredentialsField =
  | 'oauth_client_credentials'
  | 'token_endpoint'
  | 'client_id'
  | 'client_secret'
  | 'scope'
  | 'resource'
  | 'audience'
  | 'auth_method';

/**
 * Rejection taxonomy. Stable strings — UI localization and telemetry both
 * key off these. Add, don't rename.
 */
export type ParseOAuthClientCredentialsCode =
  | 'invalid_blob_shape'
  | 'missing_field'
  | 'invalid_field_type'
  | 'field_too_long'
  | 'invalid_url'
  | 'invalid_env_reference'
  | 'invalid_auth_method_value';

export type ParseOAuthClientCredentialsResult =
  | { ok: true; creds: OAuthClientCredentials }
  | {
      ok: false;
      error: string;
      code: ParseOAuthClientCredentialsCode;
      field: ParseOAuthClientCredentialsField;
    };

export interface ParseOAuthClientCredentialsOptions {
  /** Returns the raw URL on success, null if the endpoint fails SSRF / scheme checks. */
  validateTokenEndpoint: (url: string) => string | null;
}

function fail(
  code: ParseOAuthClientCredentialsCode,
  field: ParseOAuthClientCredentialsField,
  error: string,
): ParseOAuthClientCredentialsResult {
  return { ok: false, code, field, error };
}

export function parseOAuthClientCredentialsInput(
  input: unknown,
  opts: ParseOAuthClientCredentialsOptions,
): ParseOAuthClientCredentialsResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(
      'invalid_blob_shape',
      'oauth_client_credentials',
      'oauth_client_credentials must be an object with token_endpoint, client_id, and client_secret.',
    );
  }
  const cc = input as Record<string, unknown>;

  if (typeof cc.token_endpoint !== 'string' || !cc.token_endpoint) {
    return fail('missing_field', 'token_endpoint', 'oauth_client_credentials.token_endpoint is required.');
  }
  if (!opts.validateTokenEndpoint(cc.token_endpoint)) {
    return fail(
      'invalid_url',
      'token_endpoint',
      'oauth_client_credentials.token_endpoint failed URL validation. Must be https:// (http://localhost is allowed in development), and cannot be a cloud metadata or private-network host.',
    );
  }

  if (typeof cc.client_id !== 'string' || !cc.client_id) {
    return fail('missing_field', 'client_id', 'oauth_client_credentials.client_id is required.');
  }
  if (cc.client_id.length > 2048) {
    return fail('field_too_long', 'client_id', 'oauth_client_credentials.client_id exceeds maximum length.');
  }
  if (cc.client_id.startsWith('$ENV:') && !ENV_REFERENCE_PATTERN.test(cc.client_id)) {
    return fail(
      'invalid_env_reference',
      'client_id',
      `oauth_client_credentials.client_id: ${ENV_REFERENCE_ERROR}`,
    );
  }

  if (typeof cc.client_secret !== 'string' || !cc.client_secret) {
    return fail(
      'missing_field',
      'client_secret',
      'oauth_client_credentials.client_secret is required. Use $ENV:ADCP_OAUTH_<NAME> to reference an environment variable.',
    );
  }
  if (cc.client_secret.length > 8192) {
    return fail('field_too_long', 'client_secret', 'oauth_client_credentials.client_secret exceeds maximum length.');
  }
  if (cc.client_secret.startsWith('$ENV:') && !ENV_REFERENCE_PATTERN.test(cc.client_secret)) {
    return fail(
      'invalid_env_reference',
      'client_secret',
      `oauth_client_credentials.client_secret: ${ENV_REFERENCE_ERROR}`,
    );
  }

  const scope = parseOptionalString(cc.scope, 1024, 'scope');
  if (scope.error) return scope.error;
  const resource = parseOptionalString(cc.resource, 2048, 'resource');
  if (resource.error) return resource.error;
  const audience = parseOptionalString(cc.audience, 2048, 'audience');
  if (audience.error) return audience.error;

  let authMethod: 'basic' | 'body' | undefined;
  if (cc.auth_method !== undefined && cc.auth_method !== null && cc.auth_method !== '') {
    if (cc.auth_method !== 'basic' && cc.auth_method !== 'body') {
      return fail(
        'invalid_auth_method_value',
        'auth_method',
        'oauth_client_credentials.auth_method must be "basic" or "body".',
      );
    }
    authMethod = cc.auth_method;
  }

  return {
    ok: true,
    creds: {
      token_endpoint: cc.token_endpoint,
      client_id: cc.client_id,
      client_secret: cc.client_secret,
      ...(scope.value && { scope: scope.value }),
      ...(resource.value && { resource: resource.value }),
      ...(audience.value && { audience: audience.value }),
      ...(authMethod && { auth_method: authMethod }),
    },
  };
}

type OptionalStringResult =
  | { value: string | null; error?: never }
  | { value?: never; error: ParseOAuthClientCredentialsResult };

function parseOptionalString(
  value: unknown,
  max: number,
  field: Extract<ParseOAuthClientCredentialsField, 'scope' | 'resource' | 'audience'>,
): OptionalStringResult {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') {
    return { error: fail('invalid_field_type', field, `oauth_client_credentials.${field} must be a string.`) };
  }
  if (value.length > max) {
    return { error: fail('field_too_long', field, `oauth_client_credentials.${field} exceeds maximum length.`) };
  }
  return { value };
}
