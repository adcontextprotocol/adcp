import { describe, expect, it } from 'vitest';
import { adaptAuthForSdk, agentConfigAuthFields } from '../server/src/services/sdk-auth-adapter.js';

describe('SDK auth adapter', () => {
  it('preserves refresh-capable OAuth tokens and client registration', async () => {
    const auth = {
      type: 'oauth' as const,
      tokens: {
        access_token: 'expired-token',
        refresh_token: 'refresh-token',
        expires_at: '2026-07-23T00:00:00.000Z',
      },
      client: { client_id: 'client-id', client_secret: 'client-secret' },
    };

    const sdkAuth = await adaptAuthForSdk(auth);
    expect(sdkAuth).toEqual(auth);
    expect(agentConfigAuthFields(sdkAuth)).toEqual({
      auth_token: 'expired-token',
      oauth_tokens: auth.tokens,
      oauth_client: auth.client,
    });
  });

  it('preserves client credentials for SDK-managed exchange and retry', async () => {
    const auth = {
      type: 'oauth_client_credentials' as const,
      credentials: {
        token_endpoint: 'https://issuer.example/token',
        client_id: 'client-id',
        client_secret: 'client-secret',
        scope: 'adcp',
      },
    };

    const sdkAuth = await adaptAuthForSdk(auth);
    expect(sdkAuth).toEqual(auth);
    expect(agentConfigAuthFields(sdkAuth)).toEqual({
      oauth_client_credentials: auth.credentials,
    });
  });
});
