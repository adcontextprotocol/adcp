import { describe, expect, it } from 'vitest';
import { agentConfigAuthFields } from '../../src/services/sdk-auth-adapter.js';

describe('agentConfigAuthFields', () => {
  it('maps bearer auth to the SDK auth_token field', () => {
    expect(agentConfigAuthFields({ type: 'bearer', token: 'static-token' })).toEqual({
      auth_token: 'static-token',
    });
  });

  it('maps basic auth to an Authorization header without a competing bearer token', () => {
    expect(agentConfigAuthFields({ type: 'basic', username: 'user', password: 'pass' })).toEqual({
      headers: { Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` },
    });
  });

  it('duplicates oauth access_token into auth_token for SDK endpoint discovery', () => {
    const auth = {
      type: 'oauth' as const,
      tokens: {
        access_token: 'fresh-access-token',
        refresh_token: 'refresh-token',
        expires_at: '2030-01-01T00:00:00.000Z',
      },
      client: {
        client_id: 'client-id',
        client_secret: 'client-secret',
      },
    };

    expect(agentConfigAuthFields(auth)).toEqual({
      auth_token: 'fresh-access-token',
      oauth_tokens: auth.tokens,
      oauth_client: auth.client,
    });
  });

  it('duplicates oauth access_token even when no OAuth client is saved', () => {
    const auth = {
      type: 'oauth' as const,
      tokens: {
        access_token: 'fresh-access-token',
        refresh_token: 'refresh-token',
      },
    };

    expect(agentConfigAuthFields(auth)).toEqual({
      auth_token: 'fresh-access-token',
      oauth_tokens: auth.tokens,
    });
  });
});
