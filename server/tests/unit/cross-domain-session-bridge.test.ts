import type express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

process.env.WORKOS_API_KEY ||= 'sk_test_bridge';
process.env.WORKOS_CLIENT_ID ||= 'client_test_bridge';
process.env.WORKOS_COOKIE_PASSWORD ||= 'bridge-test-cookie-password-32chars';

const { HTTPServer } = await import('../../src/http.js');

type BridgeInvoker = {
  bridgeIfNeeded(req: express.Request, res: express.Response): boolean;
};

function invokeBridge({
  headers = {},
  cookies = {},
  hostname = 'adcontextprotocol.org',
  originalUrl = '/',
  query = {},
}: {
  headers?: express.Request['headers'];
  cookies?: Record<string, string>;
  hostname?: string;
  originalUrl?: string;
  query?: express.Request['query'];
} = {}) {
  const server = Object.create(HTTPServer.prototype) as BridgeInvoker;
  const redirect = vi.fn();
  const req = {
    headers,
    cookies,
    hostname,
    originalUrl,
    query,
  } as unknown as express.Request;
  const res = { redirect } as unknown as express.Response;

  return {
    bridged: server.bridgeIfNeeded(req, res),
    redirect,
  };
}

describe('cross-domain session bridge', () => {
  it('accepts only credential-free HTTPS return URLs on exact AdCP hosts', () => {
    const server = HTTPServer as unknown as {
      isAllowedAdcpUrl(url: string): boolean;
    };

    expect(server.isAllowedAdcpUrl('https://adcontextprotocol.org/member-hub')).toBe(true);
    expect(server.isAllowedAdcpUrl('https://www.adcontextprotocol.org/member-hub')).toBe(true);
    expect(server.isAllowedAdcpUrl('http://adcontextprotocol.org/member-hub')).toBe(false);
    expect(server.isAllowedAdcpUrl('https://user:secret@adcontextprotocol.org/member-hub')).toBe(false);
    expect(server.isAllowedAdcpUrl('https://adcontextprotocol.org:8443/member-hub')).toBe(false);
    expect(server.isAllowedAdcpUrl('https://adcontextprotocol.org.attacker.test/member-hub')).toBe(false);
  });

  it('rejects bridge session POSTs without the exact trusted AAO Origin', async () => {
    const server = new HTTPServer();
    const app = (server as unknown as { app: Parameters<typeof request>[0] }).app;

    try {
      const missingOrigin = await request(app)
        .post('/auth/bridge-callback?return_to=https%3A%2F%2Fadcontextprotocol.org%2Fmember-hub')
        .set('Host', 'adcontextprotocol.org')
        .type('form')
        .send({ _session: 'attacker-supplied-session' });
      expect(missingOrigin.status).toBe(403);
      expect(missingOrigin.headers['set-cookie']).toBeUndefined();

      const untrustedSubdomain = await request(app)
        .post('/auth/bridge-callback?return_to=https%3A%2F%2Fadcontextprotocol.org%2Fmember-hub')
        .set('Host', 'adcontextprotocol.org')
        .set('Origin', 'https://untrusted.agenticadvertising.org')
        .type('form')
        .send({ _session: 'attacker-supplied-session' });
      expect(untrustedSubdomain.status).toBe(403);
      expect(untrustedSubdomain.headers['set-cookie']).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it('accepts a bridge session POST from the exact trusted AAO Origin', async () => {
    const server = new HTTPServer();
    const app = (server as unknown as { app: Parameters<typeof request>[0] }).app;

    try {
      const response = await request(app)
        .post('/auth/bridge-callback?return_to=https%3A%2F%2Fadcontextprotocol.org%2Fmember-hub')
        .set('Host', 'adcontextprotocol.org')
        .set('Origin', 'https://agenticadvertising.org')
        .type('form')
        .send({ _session: 'sealed-session' });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://adcontextprotocol.org/member-hub');
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringContaining('wos-session=sealed-session'),
      ]));
    } finally {
      await server.stop();
    }
  });

  it('bridges a cookie-less top-level browser navigation', () => {
    const { bridged, redirect } = invokeBridge({
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });

    expect(bridged).toBe(true);
    expect(redirect).toHaveBeenCalledWith(
      'https://agenticadvertising.org/auth/bridge?return_to=https%3A%2F%2Fadcontextprotocol.org%2F',
    );
  });

  it('does not bridge a cookie-less non-navigation client', () => {
    const { bridged, redirect } = invokeBridge();

    expect(bridged).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not bridge a cookie-less iframe navigation', () => {
    const { bridged, redirect } = invokeBridge({
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });

    expect(bridged).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('uses the callback marker to break the loop when cookies do not persist', () => {
    const server = HTTPServer as unknown as {
      markBridgeReturnTo(returnTo: string): string;
    };
    const markedReturnTo = server.markBridgeReturnTo('https://adcontextprotocol.org/membership?plan=individual');
    const markedUrl = new URL(markedReturnTo);

    expect(markedUrl.searchParams.get('_bridge_checked')).toBe('1');
    const { bridged, redirect } = invokeBridge({
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      originalUrl: `${markedUrl.pathname}${markedUrl.search}`,
      query: Object.fromEntries(markedUrl.searchParams),
    });

    expect(bridged).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('completes the no-session redirect chain without a cookie jar', async () => {
    const server = new HTTPServer();
    const app = (server as unknown as { app: Parameters<typeof request>[0] }).app;

    try {
      const initial = await request(app)
        .get('/membership')
        .set('Host', 'adcontextprotocol.org')
        .set('Sec-Fetch-Mode', 'navigate')
        .set('Sec-Fetch-Dest', 'document');
      expect(initial.status).toBe(302);

      const bridgeUrl = new URL(initial.headers.location);
      expect(`${bridgeUrl.origin}${bridgeUrl.pathname}`).toBe('https://agenticadvertising.org/auth/bridge');
      const returnTo = bridgeUrl.searchParams.get('return_to');
      expect(returnTo).toBe('https://adcontextprotocol.org/membership');

      const callback = await request(app)
        .get('/auth/bridge-callback')
        .query({ return_to: returnTo })
        .set('Host', 'adcontextprotocol.org');
      expect(callback.status).toBe(302);

      const markedReturn = new URL(callback.headers.location);
      expect(markedReturn.searchParams.get('_bridge_checked')).toBe('1');

      // Deliberately use a fresh request instead of a supertest agent so no
      // bridge-checked cookie is retained from the callback response.
      const returned = await request(app)
        .get(`${markedReturn.pathname}${markedReturn.search}`)
        .set('Host', 'adcontextprotocol.org')
        .set('Sec-Fetch-Mode', 'navigate')
        .set('Sec-Fetch-Dest', 'document');
      expect(returned.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it.each(['wos-session', 'bridge-checked'])('does not bridge when %s is present', (cookieName) => {
    const { bridged, redirect } = invokeBridge({
      headers: {
        cookie: `${cookieName}=present`,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      cookies: { [cookieName]: 'present' },
    });

    expect(bridged).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not bridge navigation on a non-AdCP hostname', () => {
    const { bridged, redirect } = invokeBridge({
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      hostname: 'agenticadvertising.org',
    });

    expect(bridged).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
});
