import { createServer, type Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedWebhookReceiverRouter } from '../../src/routes/hosted-webhook-receiver.js';

const TOKEN = 'a'.repeat(64);
const MACHINE_ID = '784dd123abcd45';
const SDK_RECEIVER_ID = '123e4567-e89b-42d3-a456-426614174000';
const PATH = `/api/compliance-receiver/${TOKEN}/_adcp_receiver/${SDK_RECEIVER_ID}/step/submit_buy/operation-1`;

afterEach(() => vi.unstubAllEnvs());

async function listenOnReceiverPort(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  for (let port = 18080; port <= 18127; port++) {
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return { server, port };
    } catch {
      server.close();
    }
  }
  throw new Error('No test receiver port available');
}

describe('hosted webhook receiver ingress', () => {
  it('relays exact body, public authority, path, and signing headers to the private listener', async () => {
    vi.stubEnv('BASE_URL', 'https://agenticadvertising.org');
    const received: { url?: string; headers?: Record<string, unknown>; body?: Buffer } = {};
    const { server, port } = await listenOnReceiverPort((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received.url = req.url;
        received.headers = req.headers;
        received.body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"challenge":"ok"}');
      });
    });

    try {
      const app = express();
      app.use('/api/compliance-receiver', createHostedWebhookReceiverRouter(
        async () => ({ machineId: MACHINE_ID, port }),
        async () => '127.0.0.1',
      ));
      const body = '{ "event": "ready", "note": "café" }\n';
      const callbackUrl = `${PATH}?proof=value%2Fexact`;
      const result = await request(app).post(callbackUrl)
        .set('Host', 'agenticadvertising.org')
        .set('Content-Type', 'application/json')
        .set('Content-Digest', 'sha-256=:example:')
        .set('Signature-Input', 'sig1=("@target-uri" "content-digest");created=1')
        .set('Signature', 'sig1=:example:')
        .send(body);

      expect(result.status).toBe(200);
      expect(result.text).toBe('{"challenge":"ok"}');
      expect(received.url).toBe(callbackUrl);
      expect(received.headers?.host).toBe('agenticadvertising.org');
      expect(received.headers?.['content-digest']).toBe('sha-256=:example:');
      expect(received.headers?.['signature-input']).toBe('sig1=("@target-uri" "content-digest");created=1');
      expect(received.headers?.signature).toBe('sig1=:example:');
      expect(received.body?.toString('utf8')).toBe(body);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects unknown, malformed, or expired route capabilities before private forwarding', async () => {
    vi.stubEnv('BASE_URL', 'https://agenticadvertising.org');
    const findTarget = vi.fn().mockResolvedValue(null);
    const resolveAddress = vi.fn();
    const downstream = vi.fn();
    const app = express();
    app.use('/api/compliance-receiver', createHostedWebhookReceiverRouter(findTarget, resolveAddress));
    app.use((_req, res) => { downstream(); res.status(500).end(); });

    expect((await request(app).post(PATH).set('Host', 'agenticadvertising.org').send('{}')).status).toBe(404);
    expect((await request(app).post(`${PATH}?redirect=http://internal`).send('{}')).status).toBe(404);
    expect((await request(app).get(PATH)).status).toBe(404);
    expect((await request(app).post(PATH).send('x'.repeat(1_048_577))).status).toBe(413);
    expect(resolveAddress).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it('rejects a forged lease target outside the reserved port range', async () => {
    const resolveAddress = vi.fn();
    const app = express();
    app.use('/api/compliance-receiver', createHostedWebhookReceiverRouter(
      async () => ({ machineId: MACHINE_ID, port: 8080 }),
      resolveAddress,
    ));

    expect((await request(app).post(PATH).send('{}')).status).toBe(503);
    expect(resolveAddress).not.toHaveBeenCalled();
  });
});
