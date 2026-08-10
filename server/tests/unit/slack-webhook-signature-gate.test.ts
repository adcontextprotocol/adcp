import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleSlashCommand: vi.fn(),
  handleSlackEvent: vi.fn(),
}));

vi.mock('../../src/slack/commands.js', () => ({
  handleSlashCommand: (...args: unknown[]) => mocks.handleSlashCommand(...args),
}));

vi.mock('../../src/slack/events.js', () => ({
  handleSlackEvent: (...args: unknown[]) => mocks.handleSlackEvent(...args),
}));

vi.mock('../../src/addie/index.js', () => ({
  getAddieBoltRouter: vi.fn(() => null),
}));

import { createSlackRouter } from '../../src/routes/slack.js';
import { createSlackSignatureVerifier } from '../../src/middleware/slack.js';

const SIGNING_SECRET = 'test_slack_signing_secret';
const originalSigningSecret = process.env.SLACK_SIGNING_SECRET;

function timestamp(secondsOffset = 0): string {
  return String(Math.floor(Date.now() / 1000) + secondsOffset);
}

function signature(body: string, requestTimestamp: string, secret = SIGNING_SECRET): string {
  return `v0=${crypto
    .createHmac('sha256', secret)
    .update(`v0:${requestTimestamp}:${body}`)
    .digest('hex')}`;
}

function mountRouter(signingSecret: string | null = SIGNING_SECRET) {
  if (signingSecret === null) {
    delete process.env.SLACK_SIGNING_SECRET;
  } else {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
  }

  const app = express();
  const { aaobotRouter } = createSlackRouter();
  app.use('/api/slack/aaobot', aaobotRouter);
  return app;
}

function signedHeaders(body: string, requestTimestamp = timestamp()) {
  return {
    requestTimestamp,
    requestSignature: signature(body, requestTimestamp),
  };
}

describe('AAO Slack webhook signature gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleSlashCommand.mockResolvedValue({ response_type: 'ephemeral', text: 'ok' });
    mocks.handleSlackEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalSigningSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = originalSigningSecret;
    }
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects commands and events when the signing secret is %s', async (_name, signingSecret) => {
    const app = mountRouter(signingSecret);

    const commandResponse = await request(app)
      .post('/api/slack/aaobot/commands')
      .type('form')
      .send('command=%2Faao&text=status');
    const eventResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .send({ type: 'event_callback', event: { type: 'team_join' } });

    expect(commandResponse.status).toBe(503);
    expect(eventResponse.status).toBe(503);
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('rejects missing signature headers before either handler', async () => {
    const app = mountRouter();

    const commandResponse = await request(app)
      .post('/api/slack/aaobot/commands')
      .type('form')
      .send('command=%2Faao&text=status');
    const eventResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .send({ type: 'event_callback', event: { type: 'team_join' } });

    expect(commandResponse.status).toBe(401);
    expect(eventResponse.status).toBe(401);
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures before either handler', async () => {
    const app = mountRouter();
    const requestTimestamp = timestamp();

    const commandResponse = await request(app)
      .post('/api/slack/aaobot/commands')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', 'v0=invalid')
      .type('form')
      .send('command=%2Faao&text=status');
    const eventResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', 'v0=invalid')
      .send({ type: 'event_callback', event: { type: 'team_join' } });

    expect(commandResponse.status).toBe(401);
    expect(eventResponse.status).toBe(401);
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('rejects otherwise valid stale signatures before either handler', async () => {
    const app = mountRouter();
    const requestTimestamp = timestamp(-360);
    const commandBody = 'command=%2Faao&text=status';
    const eventPayload = { type: 'event_callback', event: { type: 'team_join' } };
    const eventBody = JSON.stringify(eventPayload);

    const commandResponse = await request(app)
      .post('/api/slack/aaobot/commands')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature(commandBody, requestTimestamp))
      .type('form')
      .send(commandBody);
    const eventResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature(eventBody, requestTimestamp))
      .send(eventPayload);

    expect(commandResponse.status).toBe(401);
    expect(eventResponse.status).toBe(401);
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('rejects bodies changed after their signatures were created', async () => {
    const app = mountRouter();
    const requestTimestamp = timestamp();
    const signedCommandBody = 'command=%2Faao&text=status';
    const sentCommandBody = 'command=%2Faao&text=admin';
    const signedEventBody = JSON.stringify({
      type: 'event_callback',
      event: { type: 'team_join', user: { id: 'U_SAFE' } },
    });
    const sentEventPayload = {
      type: 'event_callback',
      event: { type: 'team_join', user: { id: 'U_ATTACKER' } },
    };

    const commandResponse = await request(app)
      .post('/api/slack/aaobot/commands')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature(signedCommandBody, requestTimestamp))
      .type('form')
      .send(sentCommandBody);
    const eventResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature(signedEventBody, requestTimestamp))
      .send(sentEventPayload);

    expect(commandResponse.status).toBe(401);
    expect(eventResponse.status).toBe(401);
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('rejects semantically equivalent JSON when the transmitted bytes differ', async () => {
    const app = mountRouter();
    const requestTimestamp = timestamp();
    const compactBody = '{"type":"event_callback","event":{"type":"app_mention","text":"hello"}}';
    const whitespaceChangedBody = '{\n  "type": "event_callback",\n  "event": { "type": "app_mention", "text": "hello" }\n}';

    const response = await request(app)
      .post('/api/slack/aaobot/events')
      .set('Content-Type', 'application/json')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature(compactBody, requestTimestamp))
      .send(whitespaceChangedBody);

    expect(response.status).toBe(401);
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('rejects semantically equivalent URL encoding when the transmitted bytes differ', async () => {
    const app = mountRouter();
    const requestTimestamp = timestamp();
    const percentEncodedBody = 'command=%2Faao&text=a%20b';
    const plusEncodedBody = 'command=%2Faao&text=a+b';

    const response = await request(app)
      .post('/api/slack/aaobot/commands')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature(percentEncodedBody, requestTimestamp))
      .type('form')
      .send(plusEncodedBody);

    expect(response.status).toBe(401);
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
  });

  it('accepts a valid signed command using the exact URL-encoded body', async () => {
    const app = mountRouter();
    const body = 'command=%2Faao&text=a+b%2Bc&note=%E2%9C%93&user_id=U123';
    const headers = signedHeaders(body);

    const response = await request(app)
      .post('/api/slack/aaobot/commands')
      .set('X-Slack-Request-Timestamp', headers.requestTimestamp)
      .set('X-Slack-Signature', headers.requestSignature)
      .type('form')
      .send(body);

    expect(response.status).toBe(200);
    expect(mocks.handleSlashCommand).toHaveBeenCalledOnce();
    expect(mocks.handleSlashCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: '/aao',
      text: 'a b+c',
      note: '✓',
      user_id: 'U123',
    }));
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });

  it('accepts a valid signed event using the exact JSON body', async () => {
    const app = mountRouter();
    const body = '{\n  "event": { "text": "Café ☕", "type": "app_mention" },\n  "type": "event_callback"\n}';
    const headers = signedHeaders(body);

    const response = await request(app)
      .post('/api/slack/aaobot/events')
      .set('Content-Type', 'application/json')
      .set('X-Slack-Request-Timestamp', headers.requestTimestamp)
      .set('X-Slack-Signature', headers.requestSignature)
      .send(body);

    expect(response.status).toBe(200);
    expect(mocks.handleSlackEvent).toHaveBeenCalledOnce();
    expect(mocks.handleSlackEvent).toHaveBeenCalledWith({
      event: { text: 'Café ☕', type: 'app_mention' },
      type: 'event_callback',
    });
    expect(mocks.handleSlashCommand).not.toHaveBeenCalled();
  });

  it('rejects a valid signature when exact raw-body capture middleware is missing', async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const app = express();
    const reachedHandler = vi.fn((_req, res) => res.status(204).send());
    const requestTimestamp = timestamp();
    app.post(
      '/without-parser',
      createSlackSignatureVerifier(SIGNING_SECRET, 'Test Slack app'),
      reachedHandler,
    );

    const response = await request(app)
      .post('/without-parser')
      .set('X-Slack-Request-Timestamp', requestTimestamp)
      .set('X-Slack-Signature', signature('', requestTimestamp));

    expect(response.status).toBe(500);
    expect(reachedHandler).not.toHaveBeenCalled();
  });

  it('answers only valid signed URL verification challenges', async () => {
    const app = mountRouter();
    const payload = { type: 'url_verification', challenge: 'verified-challenge' };
    const body = JSON.stringify(payload);
    const headers = signedHeaders(body);

    const unsignedResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .send(payload);
    const invalidResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .set('X-Slack-Request-Timestamp', headers.requestTimestamp)
      .set('X-Slack-Signature', 'v0=invalid')
      .send(payload);
    const validResponse = await request(app)
      .post('/api/slack/aaobot/events')
      .set('X-Slack-Request-Timestamp', headers.requestTimestamp)
      .set('X-Slack-Signature', headers.requestSignature)
      .send(payload);

    expect(unsignedResponse.status).toBe(401);
    expect(invalidResponse.status).toBe(401);
    expect(validResponse.status).toBe(200);
    expect(validResponse.body).toEqual({ challenge: 'verified-challenge' });
    expect(mocks.handleSlackEvent).not.toHaveBeenCalled();
  });
});
