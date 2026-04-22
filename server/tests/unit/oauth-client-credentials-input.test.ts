import { describe, it, expect } from 'vitest';
import { parseOAuthClientCredentialsInput } from '../../src/routes/helpers/oauth-client-credentials-input.js';

// The real token-endpoint validator is tested elsewhere; here we just need
// predictable accept/reject behavior so the parser's branches are isolable.
const acceptAll = (url: string) => url;
const rejectAll = () => null;

describe('parseOAuthClientCredentialsInput', () => {
  const validMinimal = {
    token_endpoint: 'https://auth.example.com/oauth/token',
    client_id: 'client_abc',
    client_secret: 'literal-secret',
  };

  it('accepts a minimal valid blob', () => {
    const result = parseOAuthClientCredentialsInput(validMinimal, { validateTokenEndpoint: acceptAll });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.creds).toEqual(validMinimal);
  });

  it('accepts all optional fields when valid', () => {
    const result = parseOAuthClientCredentialsInput(
      {
        ...validMinimal,
        scope: 'adcp',
        resource: 'https://agent.example.com',
        audience: 'https://agent.example.com',
        auth_method: 'body',
      },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.creds.auth_method).toBe('body');
    expect(result.creds.scope).toBe('adcp');
  });

  it('accepts $ENV: references that match the ADCP_OAUTH_ prefix', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_secret: '$ENV:ADCP_OAUTH_SANDBOX_SECRET' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(true);
  });

  // ── Required-field errors ──────────────────────────────

  it('rejects non-object input', () => {
    const result = parseOAuthClientCredentialsInput('oops', { validateTokenEndpoint: acceptAll });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/must be an object/);
  });

  it('rejects an array input', () => {
    const result = parseOAuthClientCredentialsInput([], { validateTokenEndpoint: acceptAll });
    expect(result.ok).toBe(false);
  });

  it('rejects missing token_endpoint', () => {
    const { token_endpoint: _, ...rest } = validMinimal;
    const result = parseOAuthClientCredentialsInput(rest, { validateTokenEndpoint: acceptAll });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/token_endpoint is required/);
  });

  it('rejects missing client_id', () => {
    const { client_id: _, ...rest } = validMinimal;
    const result = parseOAuthClientCredentialsInput(rest, { validateTokenEndpoint: acceptAll });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/client_id is required/);
  });

  it('rejects missing client_secret', () => {
    const { client_secret: _, ...rest } = validMinimal;
    const result = parseOAuthClientCredentialsInput(rest, { validateTokenEndpoint: acceptAll });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/client_secret is required/);
  });

  // ── Validator rejection (SSRF / scheme) ────────────────

  it('rejects when the token_endpoint validator returns null (SSRF / scheme failure)', () => {
    const result = parseOAuthClientCredentialsInput(validMinimal, { validateTokenEndpoint: rejectAll });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/failed URL validation/);
  });

  // ── $ENV: allowlist (security must-fix) ────────────────

  it('rejects $ENV: references in client_secret that do not match the ADCP_OAUTH_ prefix', () => {
    // This is the server-secret exfiltration vector: a member saves
    // `$ENV:DATABASE_URL` and the SDK sends the DATABASE_URL to a
    // member-chosen token endpoint. The allowlist must block this.
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_secret: '$ENV:DATABASE_URL' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/\$ENV references must match/);
  });

  it('rejects $ENV: references in client_id that do not match the ADCP_OAUTH_ prefix', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_id: '$ENV:ENCRYPTION_SECRET' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/\$ENV references must match/);
  });

  it('rejects lowercase in the $ENV: variable name', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_secret: '$ENV:ADCP_OAUTH_lowercase' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a bare $ENV: prefix with no variable name', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_secret: '$ENV:' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
  });

  it('accepts literal secret values that happen to start with a dollar sign', () => {
    // A literal secret like "$8s0meR@nd0m!" must pass through — only strings
    // starting with "$ENV:" are treated as references.
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_secret: '$8s0meR@nd0m!' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(true);
  });

  // ── Type / length ──────────────────────────────────────

  it('rejects a client_id that exceeds the length limit', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_id: 'x'.repeat(2049) },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/client_id exceeds maximum length/);
  });

  it('rejects a client_secret that exceeds the length limit', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, client_secret: 'x'.repeat(8193) },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string scope', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, scope: 42 },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/scope must be a string/);
  });

  it('treats empty optional strings as absent (does not reject, does not persist)', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, scope: '', resource: '', audience: '' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.creds.scope).toBeUndefined();
    expect(result.creds.resource).toBeUndefined();
    expect(result.creds.audience).toBeUndefined();
  });

  it('rejects an auth_method outside the enum', () => {
    const result = parseOAuthClientCredentialsInput(
      { ...validMinimal, auth_method: 'client_secret_post' },
      { validateTokenEndpoint: acceptAll },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/auth_method must be "basic" or "body"/);
  });

  it('treats auth_method = undefined / null / "" as absent', () => {
    for (const value of [undefined, null, '']) {
      const result = parseOAuthClientCredentialsInput(
        { ...validMinimal, auth_method: value },
        { validateTokenEndpoint: acceptAll },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.creds.auth_method).toBeUndefined();
    }
  });

  // ── Structured error codes (closes #2810) ───────────────────────────

  describe('failure result carries structured { code, field }', () => {
    // Each case exercises one rejection branch and locks both the stable
    // code tag (for UI localization + telemetry) and the field pointer
    // (for scroll-into-view + red outline).
    const cases: Array<{
      name: string;
      input: unknown;
      options?: { validateTokenEndpoint: (url: string) => string | null };
      code: string;
      field: string;
    }> = [
      { name: 'non-object input', input: 'oops', code: 'invalid_blob_shape', field: 'oauth_client_credentials' },
      { name: 'array input', input: [], code: 'invalid_blob_shape', field: 'oauth_client_credentials' },
      { name: 'missing token_endpoint', input: { client_id: 'x', client_secret: 'y' }, code: 'missing_field', field: 'token_endpoint' },
      { name: 'missing client_id', input: { token_endpoint: 'https://a/t', client_secret: 'y' }, code: 'missing_field', field: 'client_id' },
      { name: 'missing client_secret', input: { token_endpoint: 'https://a/t', client_id: 'x' }, code: 'missing_field', field: 'client_secret' },
      { name: 'validator-rejected token_endpoint', input: validMinimal, options: { validateTokenEndpoint: rejectAll }, code: 'invalid_url', field: 'token_endpoint' },
      { name: 'over-long client_id', input: { ...validMinimal, client_id: 'x'.repeat(2049) }, code: 'field_too_long', field: 'client_id' },
      { name: 'over-long client_secret', input: { ...validMinimal, client_secret: 'x'.repeat(8193) }, code: 'field_too_long', field: 'client_secret' },
      { name: 'bad $ENV ref in client_id', input: { ...validMinimal, client_id: '$ENV:DATABASE_URL' }, code: 'invalid_env_reference', field: 'client_id' },
      { name: 'bad $ENV ref in client_secret', input: { ...validMinimal, client_secret: '$ENV:DATABASE_URL' }, code: 'invalid_env_reference', field: 'client_secret' },
      { name: 'non-string scope', input: { ...validMinimal, scope: 42 }, code: 'invalid_field_type', field: 'scope' },
      { name: 'non-string resource', input: { ...validMinimal, resource: {} }, code: 'invalid_field_type', field: 'resource' },
      { name: 'non-string audience', input: { ...validMinimal, audience: false }, code: 'invalid_field_type', field: 'audience' },
      { name: 'over-long scope', input: { ...validMinimal, scope: 'x'.repeat(1025) }, code: 'field_too_long', field: 'scope' },
      { name: 'over-long resource', input: { ...validMinimal, resource: 'x'.repeat(2049) }, code: 'field_too_long', field: 'resource' },
      { name: 'over-long audience', input: { ...validMinimal, audience: 'x'.repeat(2049) }, code: 'field_too_long', field: 'audience' },
      { name: 'invalid auth_method', input: { ...validMinimal, auth_method: 'client_secret_post' }, code: 'invalid_auth_method_value', field: 'auth_method' },
    ];

    for (const c of cases) {
      it(`${c.name} → code=${c.code}, field=${c.field}`, () => {
        const result = parseOAuthClientCredentialsInput(c.input, c.options || { validateTokenEndpoint: acceptAll });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe(c.code);
        expect(result.field).toBe(c.field);
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      });
    }
  });
});
