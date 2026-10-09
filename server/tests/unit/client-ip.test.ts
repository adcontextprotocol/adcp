import express, { type Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { restoreClientIp } from '../../src/middleware/client-ip.js';

afterEach(() => vi.unstubAllEnvs());

function resolve(headers: Request['headers'], peer = 'fdaa:0:1234::3') {
  const req = { headers, socket: { remoteAddress: peer }, ip: '203.0.113.200' } as unknown as Request;
  const next = vi.fn();
  restoreClientIp(req, {} as express.Response, next);
  expect(next).toHaveBeenCalledOnce();
  return req.ip;
}

describe('Fly and Cloudflare client IP restoration', () => {
  it('does not trust these headers outside Fly', () => {
    vi.stubEnv('FLY_APP_NAME', '');
    expect(resolve({ 'fly-client-ip': '198.41.128.3', 'cf-connecting-ip': '192.0.2.1' })).toBe('203.0.113.200');
  });

  it('does not trust a public socket peer even when Fly is configured', () => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({ 'fly-client-ip': '198.41.128.3', 'cf-connecting-ip': '192.0.2.1' }, '203.0.113.7')).toBe('203.0.113.200');
  });

  it.each(['fdaa:0:1234::3', '127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts the immediate client supplied by the Fly proxy at %s', peer => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({ 'fly-client-ip': '192.0.2.1', 'cf-connecting-ip': '198.51.100.99' }, peer)).toBe('192.0.2.1');
  });

  it.each(['198.41.128.3', '2606:4700::1234', '::ffff:198.41.128.3'])('accepts a Cloudflare client only from the verified upstream %s', upstream => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({ 'fly-client-ip': upstream, 'cf-connecting-ip': '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('ignores spoofed forwarded prefixes and the app address at the end', () => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({
      'fly-client-ip': '198.41.128.3', 'cf-connecting-ip': '192.0.2.1',
      'x-forwarded-for': '198.51.100.99, 192.0.2.1, 198.41.128.3, 2001:db8::200',
    })).toBe('192.0.2.1');
  });

  it.each([undefined, '', 'not-an-ip', '192.0.2.1:1234', '192.0.2.1, 192.0.2.2', 'fe80::1%eth0', ['192.0.2.1', '192.0.2.2']])('ignores an invalid Fly client header %j', value => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({ 'fly-client-ip': value, 'cf-connecting-ip': '192.0.2.1' })).toBe('203.0.113.200');
  });

  it.each([undefined, '', 'not-an-ip', '192.0.2.1:1234', '192.0.2.1, 192.0.2.2', 'fe80::1%eth0', ['192.0.2.1', '192.0.2.2']])('falls back to the verified upstream for an invalid Cloudflare header %j', value => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({ 'fly-client-ip': '198.41.128.3', 'cf-connecting-ip': value })).toBe('198.41.128.3');
  });

  it('does not trust a peer just outside the published Cloudflare range', () => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    expect(resolve({ 'fly-client-ip': '198.41.127.255', 'cf-connecting-ip': '192.0.2.1' })).toBe('198.41.127.255');
  });

  it('restores req.ip without changing forwarded host or protocol handling', async () => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    const app = express();
    app.set('trust proxy', 1);
    app.use(restoreClientIp);
    app.get('/', (req, res) => res.json({ ip: req.ip, hostname: req.hostname, protocol: req.protocol }));
    const response = await request(app).get('/').set({
      'Fly-Client-IP': '198.41.128.3', 'CF-Connecting-IP': '192.0.2.1',
      'X-Forwarded-For': '192.0.2.1, 198.41.128.3, 2001:db8::200',
      'X-Forwarded-Host': 'example.test', 'X-Forwarded-Proto': 'https',
    });
    expect(response.body).toEqual({ ip: '192.0.2.1', hostname: 'example.test', protocol: 'https' });
  });

  it('keeps separate client quotas in the real OAuth registration handler behind the same proxy chain', async () => {
    vi.stubEnv('FLY_APP_NAME', 'test-app');
    const app = express();
    app.set('trust proxy', 1);
    app.use(restoreClientIp);
    const registerClient = vi.fn();
    app.use('/register', clientRegistrationHandler({
      clientsStore: { getClient: async () => undefined, registerClient },
      rateLimit: { max: 2 },
    }));
    const probe = (client: string) => request(app).post('/register').set({
      'Fly-Client-IP': '198.41.128.3', 'CF-Connecting-IP': client,
      'X-Forwarded-For': `${client}, 198.41.128.3, 2001:db8::200`,
    }).send({ redirect_uris: false });

    for (const client of ['192.0.2.1', '192.0.2.2']) {
      for (const remaining of ['1', '0']) {
        const response = await probe(client);
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_client_metadata');
        expect(response.headers['ratelimit-remaining']).toBe(remaining);
      }
    }
    const limited = await probe('192.0.2.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('too_many_requests');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await probe('192.0.2.3')).status).toBe(400);
    expect(registerClient).not.toHaveBeenCalled();
  });
});
