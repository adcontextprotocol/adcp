import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { chatRequestCorrelation, correlateChatStreamError } from '../../src/middleware/chat-request-correlation.js';
import { csrfProtection } from '../../src/middleware/csrf.js';

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../src/logger.js', () => ({ createLogger: () => logs }));
const id = 'a94c88c0-f379-4a1d-826d-4d9b251838e0';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
beforeEach(() => vi.clearAllMocks());

function app(csrf = false) {
  const app = express();
  app.use('/api/addie/chat', chatRequestCorrelation);
  app.use(express.json());
  app.use(cookieParser());
  if (csrf) app.use(csrfProtection);
  const router = express.Router();
  router.use(chatRequestCorrelation);
  router.post('/stream', (_req, res) => res.status(403).json({ error: 'An unambiguous organization selection is required' }));
  router.post('/sse', (_req, res) => {
    res.type('text/event-stream');
    res.end(`event: stream_error\ndata: ${JSON.stringify(correlateChatStreamError(res, { error: 'Internal server error', recoverable: true }))}\n\n`);
  });
  app.use('/api/addie/chat', router);
  app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'Malformed request body' });
  });
  return app;
}

describe('chat transport request correlation', () => {
  it('preserves a validated UUID across header, JSON and one structured failure log', async () => {
    const response = await request(app()).post('/api/addie/chat/stream?secret=never-log')
      .set('X-Request-ID', id.toUpperCase()).send({ message: 'private text' });
    expect(response.status).toBe(403);
    expect(response.headers['x-request-id']).toBe(id);
    expect(response.body.request_id).toBe(id);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({
      request_id: id, status: 403, event: 'addie_chat_request_failed', error_code: 'organization_selection_conflict',
    }), expect.any(String));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toMatch(/never-log|private text/);
  });

  it.each([undefined, 'sam@example.test', 'x'.repeat(500), `${id},${id}`, 'not-a-uuid'])('generates an ID for missing/unsafe input %s', async (supplied) => {
    const call = request(app()).post('/api/addie/chat/stream');
    if (supplied !== undefined) call.set('X-Request-ID', supplied);
    const response = await call.send({});
    expect(response.headers['x-request-id']).toMatch(uuid);
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
    expect(response.body.request_id).not.toBe(supplied);
    if (supplied) expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(supplied);
  });

  it('correlates early CSRF rejection and preserves the fresh-token retry contract', async () => {
    const response = await request(app(true)).post('/api/addie/chat/stream').set('X-Request-ID', id).send({});
    expect(response.status).toBe(403);
    expect(response.headers['x-csrf-retry']).toBe('true');
    expect(response.body).toMatchObject({ error: 'CSRF validation failed', request_id: id });
    expect(response.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ request_id: id, status: 403 }), expect.any(String));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(response.body.token);
  });

  it('correlates malformed JSON before the chat router runs', async () => {
    const response = await request(app()).post('/api/addie/chat/stream').set('Content-Type', 'application/json').send('{');
    expect(response.status).toBe(400);
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
  });

  it('correlates SSE errors without logging provider details or changing recoverability', async () => {
    const response = await request(app()).post('/api/addie/chat/sse').set('X-Request-ID', id).send({});
    const data = JSON.parse(response.text.split('data: ')[1]);
    expect(data).toMatchObject({ request_id: id, recoverable: true });
    expect(response.headers['x-request-id']).toBe(id);
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ request_id: id, event: 'addie_chat_stream_failed' }), expect.any(String));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('Internal server error');
  });

  it('mounts correlation ahead of parser and CSRF in the actual HTTP host', () => {
    const source = readFileSync('server/src/http.ts', 'utf8');
    const correlation = source.indexOf("this.app.use('/api/addie/chat', chatRequestCorrelation)");
    expect(correlation).toBeGreaterThan(-1);
    expect(correlation).toBeLessThan(source.indexOf('express.json({'));
    expect(correlation).toBeLessThan(source.indexOf('this.app.use(csrfProtection)'));
  });
});
