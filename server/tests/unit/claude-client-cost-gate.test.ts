import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordCost,
  __setCostTrackerStore,
  __createInMemoryCostStore,
} from '../../src/addie/claude-cost-tracker.js';
import { AddieClaudeClient } from '../../src/addie/claude-client.js';

/**
 * End-to-end gate test (#2790). When a user has exhausted their
 * 24-hour cost budget, `processMessage` / `processMessageStream`
 * must return a `cost_cap_exceeded` flag WITHOUT making a Claude API
 * call. That path runs entirely before any Anthropic SDK usage, so
 * the test doesn't need a mocked SDK — an unreachable apiKey is
 * enough to prove we never hit the network.
 *
 * This complements the tracker-level unit tests by pinning the
 * instrumentation in claude-client.ts that the per-caller `costScope`
 * option actually routes through `checkCostCap` + formats the
 * response correctly.
 */

// Spy that would throw if the Anthropic SDK got invoked. This is the
// integration assertion — no SDK call means the gate fired at entry.
// claude-client uses `beta.messages.create` for non-stream and
// `messages.stream` for stream, so wire both to the same spy.
const anthropicCall = vi.fn(() => {
  throw new Error('SDK should not be reached when cap is exhausted');
});
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      beta = { messages: { create: anthropicCall } };
      messages = { create: anthropicCall, stream: anthropicCall };
    },
  };
});

beforeEach(() => {
  __setCostTrackerStore(__createInMemoryCostStore());
  anthropicCall.mockClear();
});

describe('claude-client entry-gate behavior (#2790)', () => {
  it('processMessage short-circuits with cost_cap_exceeded when the user is over budget', async () => {
    // Burn the anonymous cap for `user-x`.
    await recordCost('user-x', 'claude-opus-4-7', { input_tokens: 66_667, output_tokens: 0 });

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { costScope: { userId: 'user-x', tier: 'anonymous' } },
    );

    expect(response.flagged).toBe(true);
    expect(response.flag_reason).toBe('cost_cap_exceeded');
    expect(response.text).toMatch(/usage cap/);
    // No token usage because no Claude call fired.
    expect(response.usage).toBeUndefined();
    expect(anthropicCall).not.toHaveBeenCalled();
  });

  it('processMessageStream yields a single cost_cap_exceeded done event when over budget', async () => {
    await recordCost('user-y', 'claude-opus-4-7', { input_tokens: 66_667, output_tokens: 0 });

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: Array<{ type: string; response?: { flagged: boolean; flag_reason?: string } }> = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { costScope: { userId: 'user-y', tier: 'anonymous' } },
    )) {
      events.push(event as { type: string; response?: { flagged: boolean; flag_reason?: string } });
    }

    // A single `done` event carrying the cap-exceeded flag.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(events[0].response?.flagged).toBe(true);
    expect(events[0].response?.flag_reason).toBe('cost_cap_exceeded');
    expect(anthropicCall).not.toHaveBeenCalled();
  });

  // A third case — "no costScope → runs uncapped, SDK IS reached" —
  // would need to mount the full claude-client lifecycle (config
  // version, rules loader, DB init). The two gate-hit tests above
  // prove the short-circuit happens at the right point; the
  // no-costScope path is exercised implicitly by every other
  // Addie test that doesn't pass `costScope`.
});

describe('fail-closed warn for unwired callers (#2950)', () => {
  // Claude-client logs `event: 'cost_cap_unwired'` at `warn` level
  // when neither `costScope` nor `uncapped: true` is passed. This is
  // the observability signal that a future caller shipped without
  // either — log aggregation should alert on it so unwired paths
  // don't stay unnoticed.
  //
  // We can only assert the warn fires ON ENTRY, before the SDK is
  // reached — the tracker-gate tests above already prove the
  // entry-log-plus-SDK path, so here we just verify the log shape.
  const logs: Array<{ msg: string; event?: string; method?: string }> = [];
  beforeEach(() => {
    __setCostTrackerStore(__createInMemoryCostStore());
    anthropicCall.mockClear();
    logs.length = 0;
  });

  // Lightweight stub of the logger to capture the warn. The
  // claude-client uses the module-scoped `logger` from
  // `../logger.js`; vi.spyOn on a re-imported instance is enough.
  it('emits cost_cap_unwired warn when processMessage is called without costScope or uncapped', async () => {
    const loggerModule = await import('../../src/logger.js');
    const spy = vi.spyOn(loggerModule.logger, 'warn').mockImplementation((obj: unknown, msg?: string) => {
      if (typeof obj === 'object' && obj !== null) {
        logs.push({ msg: msg ?? '', ...(obj as Record<string, string>) });
      }
      return loggerModule.logger;
    });

    try {
      const client = new AddieClaudeClient('sk-fake', 'claude-sonnet-4-6');
      // No costScope, no uncapped → should warn, then try to hit the
      // mocked SDK (which throws) — we don't care about the throw,
      // we only care that the warn fired first.
      await client.processMessage('hi').catch(() => {});

      const unwired = logs.find(l => l.event === 'cost_cap_unwired');
      expect(unwired).toBeDefined();
      expect(unwired?.method).toBe('processMessage');
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT emit cost_cap_unwired when uncapped: true is set', async () => {
    const loggerModule = await import('../../src/logger.js');
    const spy = vi.spyOn(loggerModule.logger, 'warn').mockImplementation((obj: unknown, msg?: string) => {
      if (typeof obj === 'object' && obj !== null) {
        logs.push({ msg: msg ?? '', ...(obj as Record<string, string>) });
      }
      return loggerModule.logger;
    });

    try {
      const client = new AddieClaudeClient('sk-fake', 'claude-sonnet-4-6');
      await client.processMessage('hi', undefined, undefined, undefined, { uncapped: true }).catch(() => {});
      const unwired = logs.find(l => l.event === 'cost_cap_unwired');
      expect(unwired).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
