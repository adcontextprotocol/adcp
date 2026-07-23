import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdCPClient, closeMCPConnections } from '@adcp/sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createSdkSafeFetch,
  sdkSafeFetch,
  withSdkSafeTransport,
} from '../server/src/utils/sdk-safe-fetch.js';

describe('SDK safe fetch adapter', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeMCPConnections();
  });

  it('normalizes Request POST bodies and refuses to follow their redirects', async () => {
    const safeFetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const fetchFn = createSdkSafeFetch(safeFetchImpl);
    const request = new Request('https://agent.example/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }),
    });

    await fetchFn(request);

    expect(safeFetchImpl).toHaveBeenCalledOnce();
    const [url, options] = safeFetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example/mcp');
    expect(options).toMatchObject({ method: 'POST', maxRedirects: 0 });
    expect(options?.headers?.authorization).toBe('Bearer secret');
    expect(new TextDecoder().decode(options?.body as Uint8Array)).toContain('tools/list');
  });

  it.each([
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'x-adcp-auth',
  ])('refuses GET redirects carrying the sensitive %s header', async header => {
    const safeFetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const fetchFn = createSdkSafeFetch(safeFetchImpl);

    await fetchFn('https://agent.example/metadata', {
      headers: { [header]: 'secret' },
    });

    expect(safeFetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      maxRedirects: 0,
    });
  });

  it('refuses HEAD redirects carrying credentials', async () => {
    const safeFetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const fetchFn = createSdkSafeFetch(safeFetchImpl);

    await fetchFn('https://agent.example/health', {
      method: 'HEAD',
      headers: { Authorization: 'Bearer secret' },
    });

    expect(safeFetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'HEAD',
      maxRedirects: 0,
    });
  });

  it('rejects an oversized declared body before allocating it', async () => {
    const safeFetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const fetchFn = createSdkSafeFetch(safeFetchImpl);
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    vi.stubGlobal('Request', class {
      url = 'https://agent.example/mcp';
      method = 'POST';
      headers = new Headers({ 'content-length': String(10 * 1024 * 1024 + 1) });
      body = {};
      signal = new AbortController().signal;
      arrayBuffer = arrayBuffer;
    });

    await expect(fetchFn('https://agent.example/mcp')).rejects.toThrow('exceeds 10485760 byte cap');
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(safeFetchImpl).not.toHaveBeenCalled();
  });

  it('preserves transport limits while enforcing the server fetch boundary', () => {
    const callerFetch = vi.fn();
    const merged = withSdkSafeTransport({
      debug: true,
      transport: {
        fetchFn: callerFetch as typeof fetch,
        maxResponseBytes: 1234,
        requestTimeoutMs: 5678,
      },
    });

    expect(merged.debug).toBe(true);
    expect(merged.transport).toEqual({
      fetchFn: sdkSafeFetch,
      maxResponseBytes: 1234,
      requestTimeoutMs: 5678,
    });
  });

  it('runs a real SDK OAuth refresh and MCP discovery without ambient fetch', async () => {
    const state = { refreshCalls: 0, mcpCalls: 0 };
    let origin = '';

    const server = createServer(async (req, res) => {
      const path = new URL(req.url ?? '/', origin).pathname;
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return json(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (path.startsWith('/.well-known/oauth-authorization-server')) {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          grant_types_supported: ['authorization_code', 'refresh_token'],
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (path === '/token' && req.method === 'POST') {
        const body = new URLSearchParams(await readBody(req));
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('refresh-token');
        state.refreshCalls++;
        return json(res, 200, {
          access_token: 'fresh-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (path !== '/mcp' && path !== '/mcp/') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== 'Bearer fresh-token') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        }).end('unauthorized');
        return;
      }

      state.mcpCalls++;
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined;
      const mcp = new McpServer({ name: 'server-safe-fetch-test', version: '1.0.0' });
      mcp.registerTool('ping', { inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await mcp.close();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const originalFetch = globalThis.fetch;
    const bridgedSafeFetch = createSdkSafeFetch(async (url, options) =>
      originalFetch(url, {
        method: options?.method,
        headers: options?.headers,
        body: options?.body,
        redirect: 'manual',
        signal: options?.signal,
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ambient fetch must not be used');
    }));

    try {
      const client = new AdCPClient([
        {
          id: 'refresh-test',
          name: 'Refresh Test',
          agent_uri: `${origin}/mcp`,
          protocol: 'mcp',
          oauth_tokens: {
            access_token: 'expired-token',
            refresh_token: 'refresh-token',
            token_type: 'Bearer',
            issuer: origin,
          },
          oauth_client: { client_id: 'refresh-client' },
        },
      ], { transport: { fetchFn: bridgedSafeFetch } });

      const info = await client.agent('refresh-test').getAgentInfo();
      expect(info.tools.some(tool => tool.name === 'ping')).toBe(true);
      expect(state.refreshCalls).toBe(1);
      expect(state.mcpCalls).toBeGreaterThan(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30_000);
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}
