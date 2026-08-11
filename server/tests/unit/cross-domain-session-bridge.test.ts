import type express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { HTTPServer } from '../../src/http.js';

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
