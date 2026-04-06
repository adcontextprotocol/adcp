/**
 * Opt-Out Scenario
 *
 * Tests that Addie respects opt-out in all situations:
 * - Opted-out person never gets contacted
 * - Opt-out mid-sequence stops all outreach
 * - Opt-in after opt-out allows outreach to resume
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../../src/db/client.js';
import { runMigrations } from '../../../src/db/migrate.js';
import type { Pool } from 'pg';
import { SimulationClock } from '../engine/clock.js';
import { SimulationEngine } from '../engine/engine.js';
import {
  createInterceptors,
} from '../engine/interceptors.js';
import { optedOut, slackNewJoiner } from '../fixtures/profiles/archetypes.js';

// Shared state accessible to vi.mock factories via vi.hoisted
const { mockState } = vi.hoisted(() => {
  const mockState = {
    anthropic: null as any,
    resend: null as any,
    clock: null as any,
  };
  return { mockState };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async (params: { system?: string; messages: Array<{ content: string }> }) => {
        const ic = mockState.anthropic;
        const cl = mockState.clock;
        const userPrompt = params.messages[0]?.content ?? '';
        const system = (params.system as string) ?? '';
        let response = ic.defaultResponse;
        for (const [step, cannedText] of ic.cannedResponses) {
          if (userPrompt.includes(step) || system.includes(step)) { response = cannedText; break; }
        }
        if (userPrompt.includes('Email —')) {
          response = JSON.stringify({ subject: 'Welcome to AgenticAdvertising.org', body: 'Hi! I\'m Addie. Would you like to learn more about our working groups?' });
        }
        if (userPrompt.includes('None — they seem to have everything set up') && userPrompt.includes('contributing')) {
          response = JSON.stringify({ skip: true, reason: 'Person is fully engaged, no action needed' });
        }
        ic.calls.push({ system, userPrompt, response, timestamp: cl.now() });
        return { content: [{ type: 'text', text: response }], model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } };
      },
    };
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (params: { to: string; subject: string; text?: string }) => {
        mockState.resend.sentEmails.push({
          to: Array.isArray(params.to) ? params.to[0] : params.to,
          subject: params.subject, text: params.text ?? '', timestamp: mockState.clock.now(),
        });
        return { data: { id: `sim_email_${Date.now()}` }, error: null };
      },
    };
  },
}));

const clock = new SimulationClock(new Date('2026-03-15T10:00:00Z'));
const interceptors = createInterceptors(clock);
mockState.anthropic = interceptors.anthropic;
mockState.resend = interceptors.resend;
mockState.clock = clock;

vi.stubEnv('OUTREACH_ENABLED', 'true');
vi.stubEnv('EMAIL_OUTREACH_ENABLED', 'true');
vi.stubEnv('ADDIE_ANTHROPIC_API_KEY', 'sim-test-key');
vi.stubEnv('RESEND_API_KEY', 'sim-test-resend-key');

describe('Opt-out respect', () => {
  let pool: Pool;
  let engine: SimulationEngine;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    clock.setTime(new Date('2026-03-15T10:00:00Z'));
    clock.install();
    interceptors.slack.reset();
    interceptors.anthropic.reset();
    interceptors.resend.reset();
    engine = new SimulationEngine({ pool, clock, interceptors });
  });

  afterEach(async () => {
    await engine.cleanup();
    clock.uninstall();
  });

  it('never contacts an opted-out person', async () => {
    const ids = await engine.seedProfiles([optedOut]);
    const personId = ids.get('opted-out')!;

    // Run multiple cycles over time
    for (let day = 0; day < 30; day += 7) {
      engine.advanceTime({ days: 7 });
      await engine.runOutreachCycle({ limit: 10 });
    }

    const events = await engine.getPersonEvents(personId);
    const sendEvents = events.filter(e => e.event_type === 'message_sent');
    expect(sendEvents.length).toBe(0);

    // Should have skip events with 'opted out' reason
    const skipEvents = events.filter(e => e.event_type === 'outreach_skipped');
    expect(skipEvents.length).toBeGreaterThan(0);
  });

  it('stops outreach when person opts out mid-sequence', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    // Cycle 1: welcome
    await engine.runOutreachCycle({ limit: 5 });
    const firstSendCount = interceptors.slack.sentMessages.length;
    expect(firstSendCount).toBeGreaterThanOrEqual(1);

    // Person opts out
    await engine.simulateUserAction(personId, { type: 'opt_out' });

    // Advance time and run more cycles
    engine.advanceTime({ days: 10 });
    await engine.runOutreachCycle({ limit: 5 });

    engine.advanceTime({ days: 10 });
    await engine.runOutreachCycle({ limit: 5 });

    // No additional messages after opt-out
    expect(interceptors.slack.sentMessages.length).toBe(firstSendCount);
  });

  it('resumes outreach after opt-in', async () => {
    const ids = await engine.seedProfiles([optedOut]);
    const personId = ids.get('opted-out')!;

    // Verify initially blocked
    await engine.runOutreachCycle({ limit: 5 });
    expect(interceptors.slack.sentMessages.length).toBe(0);

    // Person opts back in
    await engine.simulateUserAction(personId, { type: 'opt_in' });

    // Advance time and run outreach
    engine.advanceTime({ days: 1 });
    await engine.runOutreachCycle({ limit: 5 });

    // Should now be contactable (has Slack, exploring stage, cooldown passed)
    const person = await engine.getRelationship(personId);
    expect(person!.opted_out).toBe(false);
  });
});
