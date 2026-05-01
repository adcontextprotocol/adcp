import { describe, it, expect } from 'vitest';
import { isOAuthRequiredErrorMessage } from '../../src/routes/helpers/oauth-error-detection.js';

describe('isOAuthRequiredErrorMessage', () => {
  it('matches the SDK NeedsAuthorizationError message', () => {
    const msg = 'Agent https://agents.scope3.com/spotify requires OAuth authorization. '
      + 'Authorization server: https://agents.scope3.com/spotify. '
      + 'Server said: Missing Authorization header. '
      + 'Provide an OAuthFlowHandler or run an interactive flow to complete authorization.';
    expect(isOAuthRequiredErrorMessage(msg)).toBe(true);
  });

  it('matches an AdCP AUTH_REQUIRED protocol error payload (deprecated)', () => {
    expect(isOAuthRequiredErrorMessage('AUTH_REQUIRED: Unauthorized')).toBe(true);
    expect(isOAuthRequiredErrorMessage('task failed with AUTH_REQUIRED')).toBe(true);
    // Embedded in a sentence with trailing punctuation
    expect(isOAuthRequiredErrorMessage('Request failed: AUTH_REQUIRED.')).toBe(true);
    expect(isOAuthRequiredErrorMessage('AUTH_REQUIRED, please reauthorize')).toBe(true);
  });

  it('matches an AdCP AUTH_MISSING protocol error payload', () => {
    expect(isOAuthRequiredErrorMessage('AUTH_MISSING: No credentials provided')).toBe(true);
    expect(isOAuthRequiredErrorMessage('task failed with AUTH_MISSING')).toBe(true);
    expect(isOAuthRequiredErrorMessage('Request failed: AUTH_MISSING.')).toBe(true);
    expect(isOAuthRequiredErrorMessage('AUTH_MISSING, please authenticate')).toBe(true);
  });

  it('does not match AUTH_INVALID (terminal — human rotation required, not re-auth prompt)', () => {
    expect(isOAuthRequiredErrorMessage('AUTH_INVALID: Token revoked')).toBe(false);
    expect(isOAuthRequiredErrorMessage('task failed with AUTH_INVALID')).toBe(false);
  });

  it('does not match a transport-level connection failure', () => {
    expect(isOAuthRequiredErrorMessage(
      'Failed to discover MCP endpoint. Tried: https://example.com None responded to MCP protocol.',
    )).toBe(false);
  });

  it('does not match a generic 5xx / timeout error', () => {
    expect(isOAuthRequiredErrorMessage('Request timed out after 90000ms')).toBe(false);
    expect(isOAuthRequiredErrorMessage('Agent returned 503 Service Unavailable')).toBe(false);
  });

  it('does not match a schema validation failure that happens to mention authorization', () => {
    // Looks similar but isn't a NeedsAuthorization signal — the SDK never
    // emits this phrase in other error paths.
    expect(isOAuthRequiredErrorMessage(
      'Schema validation failed: field `authorization` must be a string',
    )).toBe(false);
  });

  it('does not false-positive on field names or identifiers containing the substring', () => {
    expect(isOAuthRequiredErrorMessage('response.context.AUTH_REQUIREDMENTS invalid')).toBe(false);
    expect(isOAuthRequiredErrorMessage('MY_AUTH_REQUIRED_OTHER error')).toBe(false);
  });

  it('handles null and undefined without throwing', () => {
    expect(isOAuthRequiredErrorMessage(null)).toBe(false);
    expect(isOAuthRequiredErrorMessage(undefined)).toBe(false);
    expect(isOAuthRequiredErrorMessage('')).toBe(false);
  });
});
