import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';
import { createModelProviderAdapterError } from '../../../src/addie/model-providers/model-provider.js';
import { GOOGLE_ROUTER_MODEL } from '../../../src/addie/model-providers/google-generate-content-provider.js';

const anthropicCall = vi.fn(() => {
  throw new Error('Anthropic SDK must not be reached while the shared circuit is open');
});

vi.mock('../../../src/addie/config-version.js', () => ({ getCurrentConfigVersionId: vi.fn(async () => null) }));

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  return {
    APIError,
    APIConnectionError,
    default: class {
      beta = { messages: { create: anthropicCall, stream: anthropicCall } };
      messages = { create: anthropicCall, stream: anthropicCall };
    },
  };
});

import { AddieClaudeClient, type StreamEvent } from '../../../src/addie/claude-client.js';
import { ProviderHealthController } from '../../../src/addie/model-providers/provider-health.js';
import { AddieRouter } from '../../../src/addie/router.js';

const capabilities: ModelProviderCapabilities = {
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  reasoningEfforts: [],
  customTools: false,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
};

class BillingExhaustedProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = capabilities;
  calls = 0;

  prepare(request: ModelRequest): PreparedModelInvocation {
    return {
      provider: this.id,
      model: request.model,
      capabilities,
      providerRequest: {},
    };
  }

  async *respond(
    _request: ModelRequest,
    _options?: ModelRespondOptions,
  ): AsyncIterable<NormalizedModelEvent> {
    this.calls++;
    throw Object.assign(new Error(
      'Your credit balance is too low to access the Anthropic API. Go to Plans & Billing.',
    ), { status: 400 });
  }
}

describe('shared Addie provider circuit', () => {
  beforeEach(() => {
    anthropicCall.mockClear();
  });

  it('returns recoverable Google billing responses and blocks subsequent streaming dispatch', async () => {
    const health = new ProviderHealthController();
    let calls = 0;
    const provider: ModelProvider = {
      id: 'google', capabilities,
      prepare: request => ({ provider: 'google', model: request.model, capabilities, providerRequest: {} }),
      async *respond() {
        calls++;
        throw createModelProviderAdapterError('provider_transport', 402);
      },
    };
    const client = new AddieClaudeClient('unused', undefined, health).forkForGeminiDirect(provider);
    const options = {
      uncapped: true, allowedToolNames: [],
      directToolSession: { visibleToolNames: () => new Set<string>(), selectedToolSetNames: () => [] },
    };
    const response = await client.processMessage('hello', undefined, undefined, undefined, options);
    expect(response).toMatchObject({
      flag_reason: 'provider_unavailable:billing_exhausted',
      model_execution: { source: 'local', requested_provider: 'google', requested_model: GOOGLE_ROUTER_MODEL, reason: 'provider_error' },
    });
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream('hello again', undefined, undefined, options)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'done', response: { flag_reason: 'provider_unavailable:billing_exhausted' } });
    expect(calls).toBe(1);
    expect(anthropicCall).not.toHaveBeenCalled();
  });

  it('propagates router billing exhaustion and gates subsequent provider dispatch', async () => {
    const health = new ProviderHealthController();
    const provider = new BillingExhaustedProvider();
    const router = new AddieRouter('unused', provider, health);

    await expect(router.route({ message: 'important question', source: 'dm' }))
      .rejects.toThrow(/credit balance/i);
    await expect(router.route({ message: 'another question', source: 'dm' }))
      .rejects.toThrow(/provider circuit is open/i);
    expect(provider.calls).toBe(1);

    const client = new AddieClaudeClient('unused', 'claude-sonnet-4-6', health);
    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response).toMatchObject({
      flagged: true,
      flag_reason: 'provider_unavailable:billing_exhausted',
      model_execution: {
        source: 'local',
        requested_provider: 'anthropic',
        requested_model: 'claude-sonnet-4-6',
        reason: 'provider_error',
      },
    });
    expect(response.text).toBe(
      'The AI service is temporarily unavailable. Please try again in about 5 minutes.',
    );
    expect(response.text).not.toMatch(/billing|credit/i);
    expect(anthropicCall).not.toHaveBeenCalled();
  });

  it('emits one done event with the same recovery copy on the stream path', async () => {
    const health = new ProviderHealthController();
    health.recordFailure('anthropic', 'chat', Object.assign(new Error(
      'Your credit balance is too low to access the Anthropic API.',
    ), { status: 400 }));
    const client = new AddieClaudeClient('unused', 'claude-sonnet-4-6', health);
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'done',
      response: {
        text: 'The AI service is temporarily unavailable. Please try again in about 5 minutes.',
        flag_reason: 'provider_unavailable:billing_exhausted',
      },
    });
    expect(anthropicCall).not.toHaveBeenCalled();
  });
});
