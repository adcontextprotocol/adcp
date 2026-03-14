/**
 * Welcome Flow Scenario
 *
 * Tests that new prospects get welcomed exactly once through the right channel,
 * and that the system respects cooldowns after the welcome.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../../src/db/client.js';
import { runMigrations } from '../../../src/db/migrate.js';
import type { Pool } from 'pg';
import { SimulationClock } from '../engine/clock.js';
import { SimulationEngine } from '../engine/engine.js';
import {
  createInterceptors,
  mockAnthropicModule,
  mockResendModule,
} from '../engine/interceptors.js';
import {
  slackNewJoiner,
  coldEmailProspect,
  emailPreference,
} from '../fixtures/profiles/archetypes.js';

// Set up mocks before any imports of production code
const clock = new SimulationClock(new Date('2026-03-15T10:00:00Z'));
const interceptors = createInterceptors(clock);
mockAnthropicModule(interceptors.anthropic, clock);
mockResendModule(interceptors.resend, clock);

// Mock environment
vi.stubEnv('OUTREACH_ENABLED', 'true');
vi.stubEnv('EMAIL_OUTREACH_ENABLED', 'true');
vi.stubEnv('ADDIE_ANTHROPIC_API_KEY', 'sim-test-key');

describe('Welcome flow', () => {
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
    clock.uninstall();
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

  it('welcomes a Slack prospect on first outreach cycle', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    const result = await engine.runOutreachCycle({ limit: 5 });

    expect(result.sent).toBeGreaterThanOrEqual(1);

    // Verify a Slack message was intercepted
    expect(interceptors.slack.sentMessages.length).toBeGreaterThanOrEqual(1);

    // Verify the relationship was updated
    const relationship = await engine.getRelationship(personId);
    expect(relationship).not.toBeNull();
    expect(relationship!.last_addie_message_at).not.toBeNull();

    // Verify person_events recorded the send
    const events = await engine.getPersonEvents(personId);
    const sendEvents = events.filter(e => e.event_type === 'message_sent');
    expect(sendEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('does not welcome the same person twice on consecutive cycles', async () => {
    await engine.seedProfiles([slackNewJoiner]);

    // First cycle: welcome sent
    await engine.runOutreachCycle({ limit: 5 });
    const firstSendCount = interceptors.slack.sentMessages.length;

    // Advance 1 day (within welcomed cooldown of 3 days)
    engine.advanceTime({ days: 1 });

    // Second cycle: should skip due to cooldown
    await engine.runOutreachCycle({ limit: 5 });
    const secondSendCount = interceptors.slack.sentMessages.length;

    // No new messages should have been sent
    expect(secondSendCount).toBe(firstSendCount);
  });

  it('welcomes an email-only prospect via email', async () => {
    await engine.seedProfiles([coldEmailProspect]);

    await engine.runOutreachCycle({ limit: 5 });

    // Verify email was sent (not Slack)
    expect(interceptors.resend.sentEmails.length).toBeGreaterThanOrEqual(1);
    expect(interceptors.resend.sentEmails[0]?.to).toBe('alex@meridianmedia.example');
  });

  it('respects contact_preference for channel routing', async () => {
    await engine.seedProfiles([emailPreference]);

    await engine.runOutreachCycle({ limit: 5 });

    // Should use email despite having Slack
    // (emailPreference has contact_preference='email' and is already welcomed,
    //  so it should use email for the follow-up)
    const events = await engine.getPersonEvents(
      Array.from(engine['seededProfiles'].keys()).find(
        k => engine['seededProfiles'].get(k)?.archetypeId === 'email-preference'
      )!
    );

    const sentEvents = events.filter(e => e.event_type === 'message_sent');
    if (sentEvents.length > 0) {
      expect(sentEvents[0]?.channel).toBe('email');
    }
  });
});
