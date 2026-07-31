import { createHmac } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const {
  zoomSecret,
  workosSecret,
  originalZoomSecret,
  originalResendSecret,
  originalWorkosSecret,
  originalWorkosApiKey,
  originalWorkosClientId,
} = vi.hoisted(() => {
  const originalZoomSecret = process.env.ZOOM_WEBHOOK_SECRET;
  const originalResendSecret = process.env.RESEND_WEBHOOK_SECRET;
  const originalWorkosSecret = process.env.WORKOS_WEBHOOK_SECRET;
  const originalWorkosApiKey = process.env.WORKOS_API_KEY;
  const originalWorkosClientId = process.env.WORKOS_CLIENT_ID;
  process.env.ZOOM_WEBHOOK_SECRET = 'zoom-webhook-security-test-secret';
  process.env.WORKOS_WEBHOOK_SECRET = 'workos-webhook-security-test-secret';
  process.env.WORKOS_API_KEY = 'sk_test_security';
  process.env.WORKOS_CLIENT_ID = 'client_security';
  delete process.env.RESEND_WEBHOOK_SECRET;
  return {
    zoomSecret: process.env.ZOOM_WEBHOOK_SECRET,
    workosSecret: process.env.WORKOS_WEBHOOK_SECRET,
    originalZoomSecret,
    originalResendSecret,
    originalWorkosSecret,
    originalWorkosApiKey,
    originalWorkosClientId,
  };
});

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError: vi.fn(),
}));

import { WEBHOOK_RAW_BODY_LIMIT_BYTES } from '../../src/middleware/bounded-raw-json.js';
import {
  createWebhooksRouter,
  parseCertificationReviewEmailMetadata,
} from '../../src/routes/webhooks.js';
import { createWorkOSWebhooksRouter } from '../../src/routes/workos-webhooks.js';

function zoomSignature(rawBody: string, timestamp: string): string {
  return `v0=${createHmac('sha256', zoomSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
}

function workosSignature(rawBody: string, timestamp: string): string {
  return createHmac('sha256', workosSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function createApp() {
  const app = express();
  app.use('/api/webhooks', createWebhooksRouter());
  app.use('/api/webhooks', createWorkOSWebhooksRouter());
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

describe('webhook route security boundaries', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    if (originalZoomSecret === undefined) delete process.env.ZOOM_WEBHOOK_SECRET;
    else process.env.ZOOM_WEBHOOK_SECRET = originalZoomSecret;
    if (originalResendSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = originalResendSecret;
    if (originalWorkosSecret === undefined) delete process.env.WORKOS_WEBHOOK_SECRET;
    else process.env.WORKOS_WEBHOOK_SECRET = originalWorkosSecret;
    if (originalWorkosApiKey === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = originalWorkosApiKey;
    if (originalWorkosClientId === undefined) delete process.env.WORKOS_CLIENT_ID;
    else process.env.WORKOS_CLIENT_ID = originalWorkosClientId;
  });

  it('rejects an unsigned Zoom URL-validation challenge instead of exposing an HMAC oracle', async () => {
    const targetTimestamp = Math.floor(Date.now() / 1000).toString();
    const targetBody = JSON.stringify({ event: 'meeting.started', payload: { object: { id: 42 } } });

    const response = await request(app)
      .post('/api/webhooks/zoom')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        event: 'endpoint.url_validation',
        payload: { plainToken: `v0:${targetTimestamp}:${targetBody}` },
      }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Missing signature headers' });
    expect(response.body.encryptedToken).toBeUndefined();
  });

  it('answers a fresh, correctly signed Zoom URL-validation challenge', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = {
      event: 'endpoint.url_validation',
      payload: { plainToken: 'zoom-plain-token' },
    };
    const rawBody = JSON.stringify(body);

    const response = await request(app)
      .post('/api/webhooks/zoom')
      .set('Content-Type', 'application/json')
      .set('x-zm-request-timestamp', timestamp)
      .set('x-zm-signature', zoomSignature(rawBody, timestamp))
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      plainToken: body.payload.plainToken,
      encryptedToken: createHmac('sha256', zoomSecret).update(body.payload.plainToken).digest('hex'),
    });
  });

  it('rejects a correctly signed Zoom challenge with a stale timestamp', async () => {
    const timestamp = (Math.floor(Date.now() / 1000) - 301).toString();
    const rawBody = JSON.stringify({
      event: 'endpoint.url_validation',
      payload: { plainToken: 'zoom-plain-token' },
    });

    const response = await request(app)
      .post('/api/webhooks/zoom')
      .set('Content-Type', 'application/json')
      .set('x-zm-request-timestamp', timestamp)
      .set('x-zm-signature', zoomSignature(rawBody, timestamp))
      .send(rawBody);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Timestamp expired' });
  });

  it('fails closed when the Resend signing secret is missing', async () => {
    const response = await request(app)
      .post('/api/webhooks/resend-inbound')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'email.received', data: {} }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('parses certification metadata without regular expressions over inbound text', () => {
    const metadata = parseCertificationReviewEmailMetadata([
      'Learner ID: user-123',
      'Learner Email: learner@example.com',
      'Module: module-456',
      'Status: needs_review',
      `Untrusted trailing text: ${' '.repeat(10_000)}!`,
    ].join('\r\n'));

    expect(metadata).toEqual({
      userId: 'user-123',
      learnerEmail: 'learner@example.com',
      moduleId: 'module-456',
      status: 'needs_review',
    });
  });

  it('verifies WorkOS signatures independently over exact noncanonical raw JSON bytes', async () => {
    const rawBody = `{
  "id": "event_security",
  "event": "security.test.unhandled",
  "data": { "value": 1 },
  "created_at": "2026-07-29T00:00:00.000Z"
    }`;
    const timestamp = Date.now().toString();
    // WorkOS signs `${timestamp}.${rawBody}`. Compute the provider signature
    // independently so this test catches SDK payload-shape regressions instead
    // of signing and verifying with the same SDK helper.
    const signature = workosSignature(rawBody, timestamp);

    const response = await request(app)
      .post('/api/webhooks/workos')
      .set('Content-Type', 'application/json')
      .set('WorkOS-Signature', `t=${timestamp}, v1=${signature}`)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it.each([
    '/api/webhooks/resend-inbound',
    '/api/webhooks/resend-tracking',
    '/api/webhooks/zoom',
    '/api/webhooks/workos',
  ])('rejects an oversized raw body on %s before authentication', async (path) => {
    const oversizedBody = JSON.stringify({ data: 'x'.repeat(WEBHOOK_RAW_BODY_LIMIT_BYTES) });
    const response = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send(oversizedBody);

    expect(response.status).toBe(413);
  });
});
