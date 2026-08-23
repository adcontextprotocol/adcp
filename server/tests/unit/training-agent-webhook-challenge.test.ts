import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  verifyWebhookSignature,
} from '@adcp/sdk/signing';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import {
  ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS,
  agentWebhookProofTuple,
  proveAgentWebhookControl,
  proveAccountWebhookControl,
} from '../../src/training-agent/webhook-challenge.js';
import {
  getPublicJwks,
  resetWebhookSigning,
} from '../../src/training-agent/webhooks.js';

interface CapturedChallenge {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

// Exercise a fractional issue time: the body expiry must not extend past the
// RFC 9421 signature's whole-second expiry.
const ISSUED_AT = Date.parse('2026-08-06T10:00:00.987Z');

function challengeConfig() {
  return {
    accountId: 'acc_acme_123',
    subscriberId: 'buyer-primary',
    url: 'https://buyer.example:443/hooks/../webhooks/adcp',
    eventTypes: ['creative.purged', 'creative.status_changed'],
  };
}

async function captureSuccessfulChallenge(
  config = challengeConfig(),
): Promise<{
  captured: CapturedChallenge;
  result: Awaited<ReturnType<typeof proveAccountWebhookControl>>;
}> {
  let captured: CapturedChallenge | undefined;
  const fetchStub: typeof fetch = async (input, init) => {
    const body = String(init?.body ?? '');
    captured = {
      method: String(init?.method ?? 'GET'),
      url: input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    };
    const payload = JSON.parse(body) as { challenge: string };
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await proveAccountWebhookControl(config, {
    fetch: fetchStub,
    now: () => ISSUED_AT,
    challenge: 'challenge-token-000000000000000000000000',
  });
  if (!captured) throw new Error('challenge was not sent');
  return { captured, result };
}

async function receiverAcceptsPendingTuple(
  captured: CapturedChallenge,
  expected = challengeConfig(),
): Promise<boolean> {
  await verifier(captured);
  const payload = JSON.parse(captured.body) as Record<string, unknown>;
  return captured.url === 'https://buyer.example/webhooks/adcp'
    && payload.account_id === expected.accountId
    && payload.subscriber_id === expected.subscriberId
    && JSON.stringify(payload.event_types) === JSON.stringify([...expected.eventTypes].sort());
}

function verifier(captured: CapturedChallenge, replayStore = new InMemoryReplayStore()) {
  return verifyWebhookSignature(captured, {
    jwks: new StaticJwksResolver(getPublicJwks().keys as AdcpJsonWebKey[]),
    replayStore,
    revocationStore: new InMemoryRevocationStore(),
    now: () => ISSUED_AT / 1000,
  });
}

describe('training-agent account webhook challenge', () => {
  beforeEach(() => {
    resetWebhookSigning();
  });

  it('signs and verifies a challenge bound to the full normalized registration tuple', async () => {
    const { captured, result } = await captureSuccessfulChallenge();
    expect(result).toEqual({
      ok: true,
      normalizedUrl: 'https://buyer.example/webhooks/adcp',
    });

    const payload = JSON.parse(captured.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'webhook.challenge',
      account_id: 'acc_acme_123',
      subscriber_id: 'buyer-primary',
      seller_agent_url: 'https://test-agent.adcontextprotocol.org',
      delivery_auth: { mode: 'rfc9421' },
      event_types: ['creative.purged', 'creative.status_changed'],
    });
    await expect(verifier(captured)).resolves.toMatchObject({ status: 'verified' });
  });

  it.each([
    ['URL', (captured: CapturedChallenge) => ({ ...captured, url: 'https://other.example/webhooks/adcp' })],
    ['account', (captured: CapturedChallenge) => ({
      ...captured,
      body: JSON.stringify({ ...JSON.parse(captured.body), account_id: 'acc_other' }),
    })],
    ['subscriber', (captured: CapturedChallenge) => ({
      ...captured,
      body: JSON.stringify({ ...JSON.parse(captured.body), subscriber_id: 'other-subscriber' }),
    })],
  ])('rejects %s tampering under the original signature', async (_label, mutate) => {
    const { captured } = await captureSuccessfulChallenge();
    await expect(verifier(mutate(captured))).rejects.toMatchObject({
      code: expect.stringMatching(/^webhook_signature_(invalid|digest_mismatch)$/),
    });
  });

  it.each([
    ['URL', { ...challengeConfig(), url: 'https://other.example/webhooks/adcp' }],
    ['account', { ...challengeConfig(), accountId: 'acc_other' }],
    ['subscriber', { ...challengeConfig(), subscriberId: 'other-subscriber' }],
  ])('rejects a validly signed challenge for the wrong pending %s', async (_label, signedConfig) => {
    const { captured } = await captureSuccessfulChallenge(signedConfig);
    await expect(verifier(captured)).resolves.toMatchObject({ status: 'verified' });
    await expect(receiverAcceptsPendingTuple(captured)).resolves.toBe(false);
  });

  it('rejects an invalid signature and a replayed signed challenge', async () => {
    const { captured } = await captureSuccessfulChallenge();
    const corrupted = captured.headers.signature.replace(
      /=:([A-Za-z0-9_-])/,
      (_match, first: string) => `=:${first === 'A' ? 'B' : 'A'}`,
    );
    const invalidSignature = {
      ...captured,
      headers: {
        ...captured.headers,
        signature: corrupted,
      },
    };
    await expect(verifier(invalidSignature)).rejects.toMatchObject({
      code: 'webhook_signature_invalid',
    });

    const replayStore = new InMemoryReplayStore();
    await expect(verifier(captured, replayStore)).resolves.toMatchObject({ status: 'verified' });
    await expect(verifier(captured, replayStore)).rejects.toMatchObject({
      code: 'webhook_signature_replayed',
    });
  });

  it('does not accept an echo received after the challenge expiry', async () => {
    let now = ISSUED_AT;
    const fetchStub: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? '')) as { challenge: string };
      now += ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS;
      return new Response(JSON.stringify({ challenge: payload.challenge }), { status: 200 });
    };

    await expect(proveAccountWebhookControl(challengeConfig(), {
      fetch: fetchStub,
      now: () => now,
    })).resolves.toEqual({ ok: false });
  });

  it('cancels an oversized streaming response', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array((16 * 1024) + 1));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(proveAccountWebhookControl(challengeConfig(), {
      fetch: async () => new Response(stream, { status: 200 }),
      now: () => ISSUED_AT,
    })).resolves.toEqual({ ok: false });
    expect(canceled).toBe(true);
  });

  it('cancels a streaming body on a non-success response', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('still streaming'));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(proveAccountWebhookControl(challengeConfig(), {
      fetch: async () => new Response(stream, { status: 400 }),
      now: () => ISSUED_AT,
    })).resolves.toEqual({ ok: false });
    expect(canceled).toBe(true);
  });
});

describe('training-agent agent-level webhook challenge', () => {
  beforeEach(() => {
    resetWebhookSigning();
  });

  it('signs a normalized challenge bound to the agent-level subscriber tuple', async () => {
    let captured: CapturedChallenge | undefined;
    const config = {
      subscriberId: 'registry-cache',
      url: 'https://registry.example:443/hooks/../webhooks/capabilities',
      eventTypes: ['capabilities.changed', 'capabilities.changed'],
      authentication: {
        schemes: ['Bearer'],
        credentials: 'write-only-bearer-credential-000000000000',
      },
    };
    const fetchStub: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? '');
      captured = {
        method: String(init?.method ?? 'GET'),
        url: input.toString(),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
      };
      const payload = JSON.parse(body) as { challenge: string };
      return new Response(JSON.stringify({ challenge: payload.challenge }), { status: 200 });
    };

    const result = await proveAgentWebhookControl(config, {
      fetch: fetchStub,
      now: () => ISSUED_AT,
      challenge: 'agent-challenge-token-00000000000000000000',
    });
    if (!captured) throw new Error('agent challenge was not sent');

    expect(result).toEqual({
      ok: true,
      normalizedUrl: 'https://registry.example/webhooks/capabilities',
    });
    expect(JSON.parse(captured.body)).toMatchObject({
      type: 'webhook.challenge',
      scope: 'agent',
      challenge: 'agent-challenge-token-00000000000000000000',
      subscriber_id: 'registry-cache',
      seller_agent_url: 'https://test-agent.adcontextprotocol.org',
      delivery_auth: {
        mode: 'Bearer',
        credential_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      event_types: ['capabilities.changed'],
    });
    expect(JSON.parse(captured.body)).not.toHaveProperty('account_id');
    expect(captured.body).not.toContain(config.authentication.credentials);
    await expect(verifier(captured)).resolves.toMatchObject({ status: 'verified' });

    expect(JSON.parse(agentWebhookProofTuple(config))).toEqual({
      scope: 'agent',
      subscriber_id: 'registry-cache',
      webhook_url: 'https://registry.example/webhooks/capabilities',
      delivery_auth: {
        mode: 'Bearer',
        credential_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      event_types: ['capabilities.changed'],
    });
  });

  it.each([
    ['a rejected response', async () => new Response('{}', { status: 403 })],
    ['the wrong echo', async () => new Response(JSON.stringify({ challenge: 'wrong' }), { status: 200 })],
  ])('fails closed on %s', async (_label, fetchStub) => {
    await expect(proveAgentWebhookControl({
      subscriberId: 'registry-cache',
      url: 'https://registry.example/webhooks/capabilities',
      eventTypes: ['capabilities.changed'],
    }, {
      fetch: fetchStub,
      now: () => ISSUED_AT,
      challenge: 'agent-challenge-token-00000000000000000000',
    })).resolves.toEqual({ ok: false });
  });
});
