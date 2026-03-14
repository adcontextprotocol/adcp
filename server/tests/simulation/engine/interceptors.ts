/**
 * Interceptors — mock external services for simulation.
 *
 * Captures Slack API calls, Anthropic SDK calls, and Resend emails
 * without hitting real services. Records everything for timeline inspection.
 */

import { vi } from 'vitest';
import type { TimelineEvent, CannedResponse } from './types.js';
import type { SimulationClock } from './clock.js';

// ---------------------------------------------------------------------------
// Slack Interceptor
// ---------------------------------------------------------------------------

export interface SlackInterceptor {
  sentMessages: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
    timestamp: Date;
  }>;
  openedChannels: Map<string, string>; // userId -> channelId
  reset(): void;
}

export function createSlackInterceptor(clock: SimulationClock): SlackInterceptor {
  let messageCounter = 0;

  const interceptor: SlackInterceptor = {
    sentMessages: [],
    openedChannels: new Map(),
    reset() {
      this.sentMessages = [];
      this.openedChannels.clear();
      messageCounter = 0;
    },
  };

  // Intercept global fetch for Slack API calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('slack.com/api/conversations.open')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const userId = body.users || 'unknown';
      const channelId = `SIM_DM_${userId}`;
      interceptor.openedChannels.set(userId, channelId);

      return new Response(JSON.stringify({
        ok: true,
        channel: { id: channelId },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('slack.com/api/chat.postMessage')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      messageCounter++;
      const ts = `${Math.floor(clock.nowMs() / 1000)}.${String(messageCounter).padStart(6, '0')}`;

      interceptor.sentMessages.push({
        channel: body.channel,
        text: body.text,
        thread_ts: body.thread_ts,
        timestamp: clock.now(),
      });

      return new Response(JSON.stringify({
        ok: true,
        ts,
        channel: body.channel,
        message: { text: body.text, ts },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('slack.com/api/users.info')) {
      return new Response(JSON.stringify({
        ok: true,
        user: { tz_offset: 0, tz: 'UTC' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Pass through non-Slack requests
    return originalFetch(input, init);
  };

  return interceptor;
}

// ---------------------------------------------------------------------------
// Anthropic Interceptor
// ---------------------------------------------------------------------------

export interface AnthropicInterceptor {
  calls: Array<{
    system: string;
    userPrompt: string;
    response: string;
    timestamp: Date;
  }>;
  cannedResponses: Map<string, string>; // step -> response
  defaultResponse: string;
  reset(): void;
}

export function createAnthropicInterceptor(clock: SimulationClock): AnthropicInterceptor {
  const interceptor: AnthropicInterceptor = {
    calls: [],
    cannedResponses: new Map(),
    defaultResponse: 'Hi! Welcome to AgenticAdvertising.org. I noticed you recently joined — would love to help you get oriented. What brings you to the community?',
    reset() {
      this.calls = [];
      this.cannedResponses.clear();
    },
  };

  return interceptor;
}

/**
 * Create the Anthropic SDK mock module.
 * Call this BEFORE importing any module that uses @anthropic-ai/sdk.
 */
export function mockAnthropicModule(interceptor: AnthropicInterceptor, clock: SimulationClock) {
  vi.mock('@anthropic-ai/sdk', () => {
    return {
      default: class MockAnthropic {
        messages = {
          create: async (params: { system?: string; messages: Array<{ content: string }> }) => {
            const userPrompt = params.messages[0]?.content ?? '';
            const system = (params.system as string) ?? '';

            // Try to find a canned response based on context clues
            let response = interceptor.defaultResponse;

            // Check for stage-specific canned responses
            for (const [step, cannedText] of interceptor.cannedResponses) {
              if (userPrompt.includes(step) || system.includes(step)) {
                response = cannedText;
                break;
              }
            }

            // Check if this is an email composition (JSON format expected)
            if (userPrompt.includes('Email —')) {
              response = JSON.stringify({
                subject: 'Welcome to AgenticAdvertising.org',
                body: 'Hi! I\'m Addie, the community manager at AgenticAdvertising.org. I noticed your organization is working in ad tech and thought you might be interested in what we\'re building. Would you like to learn more about our working groups?',
              });
            }

            // If context suggests a skip (e.g., nothing meaningful)
            if (userPrompt.includes('None — they seem to have everything set up') &&
                userPrompt.includes('contributing')) {
              response = JSON.stringify({ skip: true, reason: 'Person is fully engaged, no action needed' });
            }

            interceptor.calls.push({
              system,
              userPrompt,
              response,
              timestamp: clock.now(),
            });

            return {
              content: [{ type: 'text', text: response }],
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          },
        };
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Resend (Email) Interceptor
// ---------------------------------------------------------------------------

export interface ResendInterceptor {
  sentEmails: Array<{
    to: string;
    subject: string;
    text: string;
    timestamp: Date;
  }>;
  reset(): void;
}

export function createResendInterceptor(clock: SimulationClock): ResendInterceptor {
  const interceptor: ResendInterceptor = {
    sentEmails: [],
    reset() {
      this.sentEmails = [];
    },
  };

  return interceptor;
}

export function mockResendModule(interceptor: ResendInterceptor, clock: SimulationClock) {
  vi.mock('resend', () => {
    return {
      Resend: class {
        emails = {
          send: async (params: { to: string; subject: string; text?: string }) => {
            interceptor.sentEmails.push({
              to: Array.isArray(params.to) ? params.to[0] : params.to,
              subject: params.subject,
              text: params.text ?? '',
              timestamp: clock.now(),
            });
            return { data: { id: `sim_email_${Date.now()}` }, error: null };
          },
        };
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Combine all interceptors
// ---------------------------------------------------------------------------

export interface Interceptors {
  slack: SlackInterceptor;
  anthropic: AnthropicInterceptor;
  resend: ResendInterceptor;
}

export function createInterceptors(clock: SimulationClock): Interceptors {
  return {
    slack: createSlackInterceptor(clock),
    anthropic: createAnthropicInterceptor(clock),
    resend: createResendInterceptor(clock),
  };
}
