import { describe, it, expect, vi } from 'vitest';
import { enforceSigningWhenWebhookAuthPresent } from '../../src/training-agent/request-signing.js';
import { AuthError } from '@adcp/sdk/server';
import { RequestSignatureError } from '@adcp/sdk/signing';
import type { Authenticator } from '@adcp/sdk/server';

function makeRequest(body: unknown, headers: Record<string, string> = {}): Parameters<Authenticator>[0] {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'POST',
    url: '/mcp-strict',
    headers,
    rawBody: raw,
  } as unknown as Parameters<Authenticator>[0];
}

function toolsCall(name: string, args: unknown) {
  return { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name, arguments: args } };
}

describe('enforceSigningWhenWebhookAuthPresent', () => {
  it('delegates to inner when no signature header and no webhook authentication', async () => {
    const inner: Authenticator = vi.fn(async () => ({ principal: 'bearer:ok' }));
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(toolsCall('create_media_buy', { plan_id: 'p1' }));
    await expect(wrapped(req)).resolves.toEqual({ principal: 'bearer:ok' });
    expect(inner).toHaveBeenCalledOnce();
  });

  it('throws request_signature_required when webhook authentication is present and unsigned', async () => {
    const inner: Authenticator = vi.fn();
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(toolsCall('update_media_buy', {
      media_buy_id: 'mb_1',
      push_notification_config: {
        url: 'https://buyer.example.com/webhook',
        authentication: { scheme: 'HMAC-SHA256', credentials: 'secret' },
      },
    }));
    await expect(wrapped(req)).rejects.toMatchObject({
      name: 'AuthError',
      cause: expect.objectContaining({ code: 'request_signature_required' }),
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it('wraps the RFC 9421 error in AuthError so serve() unwraps the challenge scheme', async () => {
    const inner: Authenticator = vi.fn();
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(toolsCall('create_media_buy', {
      push_notification_config: {
        url: 'https://buyer.example.com/webhook',
        authentication: { scheme: 'Bearer', credentials: 'tok' },
      },
    }));
    let caught: unknown;
    try {
      await wrapped(req);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as AuthError).cause).toBeInstanceOf(RequestSignatureError);
  });

  it('defers to inner when a signature header is present', async () => {
    const inner: Authenticator = vi.fn(async () => ({ principal: 'signing:kid' }));
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(
      toolsCall('update_media_buy', {
        push_notification_config: {
          url: 'https://buyer.example.com/webhook',
          authentication: { scheme: 'HMAC-SHA256', credentials: 'secret' },
        },
      }),
      { 'signature-input': 'sig1=("@method");created=1;keyid="k"', signature: 'sig1=:AAAA:' },
    );
    await expect(wrapped(req)).resolves.toEqual({ principal: 'signing:kid' });
    expect(inner).toHaveBeenCalledOnce();
  });

  it('detects webhook authentication nested inside arrays (per-package configs)', async () => {
    const inner: Authenticator = vi.fn();
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(toolsCall('create_media_buy', {
      plan_id: 'p1',
      packages: [
        { package_id: 'pkg_1', budget: { amount: 100, currency: 'USD' } },
        {
          package_id: 'pkg_2',
          push_notification_config: {
            url: 'https://buyer.example.com/webhook',
            authentication: { scheme: 'HMAC-SHA256', credentials: 'secret' },
          },
        },
      ],
    }));
    await expect(wrapped(req)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'request_signature_required' }),
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it('ignores empty authentication objects', async () => {
    const inner: Authenticator = vi.fn(async () => ({ principal: 'bearer:ok' }));
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(toolsCall('create_media_buy', {
      push_notification_config: {
        url: 'https://buyer.example.com/webhook',
        authentication: {},
      },
    }));
    await expect(wrapped(req)).resolves.toEqual({ principal: 'bearer:ok' });
  });

  it('delegates to inner when rawBody is missing', async () => {
    const inner: Authenticator = vi.fn(async () => null);
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = { method: 'GET', url: '/mcp-strict', headers: {} } as unknown as Parameters<Authenticator>[0];
    await expect(wrapped(req)).resolves.toBeNull();
    expect(inner).toHaveBeenCalledOnce();
  });

  it('delegates to inner on malformed JSON bodies', async () => {
    const inner: Authenticator = vi.fn(async () => null);
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest('{not valid json');
    await expect(wrapped(req)).resolves.toBeNull();
    expect(inner).toHaveBeenCalledOnce();
  });

  it('propagates inner signature-verifier errors on signed requests with webhook auth', async () => {
    const signatureInvalid = new RequestSignatureError('request_signature_invalid', 10, 'bad sig');
    const inner: Authenticator = vi.fn(async () => {
      throw new AuthError('Signature rejected.', { cause: signatureInvalid });
    });
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    const req = makeRequest(
      toolsCall('update_media_buy', {
        push_notification_config: {
          url: 'https://buyer.example.com/webhook',
          authentication: { scheme: 'HMAC-SHA256', credentials: 'secret' },
        },
      }),
      { 'signature-input': 'sig1=("@method");created=1;keyid="k"', signature: 'sig1=:AAAA:' },
    );
    await expect(wrapped(req)).rejects.toMatchObject({
      name: 'AuthError',
      cause: expect.objectContaining({ code: 'request_signature_invalid' }),
    });
  });

  it('detects webhook authentication at depths up to the object-hop cap', async () => {
    const inner: Authenticator = vi.fn();
    const wrapped = enforceSigningWhenWebhookAuthPresent(inner);
    // 9 object hops from params.arguments (depth 0) to the push_notification_config
    // owner, plus one for authentication's parent — exactly at MAX_OBJECT_DEPTH.
    // Arrays do not consume the budget, so packages[] is free.
    const deep: Record<string, unknown> = {
      packages: [{
        campaign: {
          delivery: {
            targeting: {
              frequency: {
                tracking: {
                  notifications: {
                    push_notification_config: {
                      url: 'https://buyer.example.com/webhook',
                      authentication: { scheme: 'HMAC-SHA256', credentials: 'secret' },
                    },
                  },
                },
              },
            },
          },
        },
      }],
    };
    const req = makeRequest(toolsCall('create_media_buy', deep));
    await expect(wrapped(req)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'request_signature_required' }),
    });
  });
});
