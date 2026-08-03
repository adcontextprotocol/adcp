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
  | 'invalid_auth_method_value'
  | 'array_too_many'
  | 'array_too_few'
  | 'aggregate_too_long';

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
  const resource = parseResourceField(cc.resource);
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
      ...(resource.value != null && { resource: resource.value }),
      ...(audience.value && { audience: audience.value }),
      ...(authMethod && { auth_method: authMethod }),
    },
  };
}

type OptionalStringResult =
  | { value: string | null; error?: never }
  | { value?: never; error: ParseOAuthClientCredentialsResult };

type ResourceFieldResult =
  | { value: string | string[] | null; error?: never }
  | { value?: never; error: ParseOAuthClientCredentialsResult };

const MAX_RESOURCE_ARRAY_ENTRIES = 8;
const MAX_RESOURCE_ENTRY_LENGTH = 2048;
/** Tighter aggregate bound — independently reachable: 5 × 1700 chars = 8500 > 8192. */
const MAX_RESOURCE_AGGREGATE_CHARS = 8192;

/**
 * Parse the `resource` field which may be a scalar string or an array of
 * strings per RFC 8707. Absent/empty/null values are treated as absent (not
 * persisted). An empty array is rejected — callers must pass at least one
 * entry or omit the field entirely.
 *
 * Limits enforced: max 8 entries, max 2048 chars per entry, max 8192 chars
 * aggregate.
 */
function parseResourceField(value: unknown): ResourceFieldResult {
  if (value === undefined || value === null || value === '') return { value: null };

  if (typeof value === 'string') {
    if (value.length > MAX_RESOURCE_ENTRY_LENGTH) {
      return { error: fail('field_too_long', 'resource', 'oauth_client_credentials.resource exceeds maximum length.') };
    }
    return { value };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return {
        error: fail(
          'array_too_few',
          'resource',
          'oauth_client_credentials.resource array must contain at least one entry; omit the field to leave it unset.',
        ),
      };
    }
    if (value.length > MAX_RESOURCE_ARRAY_ENTRIES) {
      return {
        error: fail(
          'array_too_many',
          'resource',
          `oauth_client_credentials.resource array may have at most ${MAX_RESOURCE_ARRAY_ENTRIES} entries.`,
        ),
      };
    }
    let aggregateChars = 0;
    for (const entry of value) {
      if (typeof entry !== 'string' || entry === '') {
        return {
          error: fail(
            'invalid_field_type',
            'resource',
            'oauth_client_credentials.resource array entries must be non-empty strings.',
          ),
        };
      }
      if (entry.length > MAX_RESOURCE_ENTRY_LENGTH) {
        return { error: fail('field_too_long', 'resource', 'oauth_client_credentials.resource array entry exceeds maximum length.') };
      }
      aggregateChars += entry.length;
    }
    if (aggregateChars > MAX_RESOURCE_AGGREGATE_CHARS) {
      return {
        error: fail(
          'aggregate_too_long',
          'resource',
          `oauth_client_credentials.resource total character length across all entries must not exceed ${MAX_RESOURCE_AGGREGATE_CHARS}.`,
        ),
      };
    }
    return { value };
  }

  return { error: fail('invalid_field_type', 'resource', 'oauth_client_credentials.resource must be a string or array of strings.') };
}

function parseOptionalString(
  value: unknown,
  max: number,
  field: Extract<ParseOAuthClientCredentialsField, 'scope' | 'audience'>,
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
