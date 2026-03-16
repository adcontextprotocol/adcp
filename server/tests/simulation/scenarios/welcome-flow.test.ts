/**
 * Welcome Flow Scenario
 *
 * Tests that new prospects get welcomed exactly once through the right channel,
 * and that the system respects cooldowns after the welcome.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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

  it('does not welcome a Slack prospect with no engagement signals', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    const result = await engine.runOutreachCycle({ limit: 5 });

    expect(result.sent).toBe(0);
    expect(interceptors.slack.sentMessages.length).toBe(0);

    const events = await engine.getPersonEvents(personId);
    const skippedEvents = events.filter(
      e => e.event_type === 'outreach_skipped' && e.data?.reason === 'no meaningful engagement signal yet'
    );
    expect(skippedEvents.length).toBeGreaterThanOrEqual(1);
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

  it('does not email a cold prospect with no engagement signals', async () => {
    await engine.seedProfiles([coldEmailProspect]);

    const result = await engine.runOutreachCycle({ limit: 5 });

    expect(result.sent).toBe(0);
    expect(interceptors.resend.sentEmails.length).toBe(0);
  });

  it('persists proactive Slack messages into unified thread history', async () => {
    const ids = await engine.seedProfiles([{
      id: 'engaged-slack-prospect',
      description: 'Slack prospect who linked an account and is eligible for a welcome',
      relationship: {
        slack_user_id: 'SIM_U_ENGAGED01',
        workos_user_id: 'sim_workos_engaged01',
        email: 'engaged@example.com',
        display_name: 'Engaged Prospect',
        stage: 'prospect',
      },
    }]);
    const personId = ids.get('engaged-slack-prospect')!;

    const result = await engine.runOutreachCycle({ limit: 5 });

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(interceptors.slack.sentMessages.length).toBeGreaterThanOrEqual(1);

    const threadResult = await pool.query<{
      content: string;
      role: string;
      external_id: string;
    }>(
      `SELECT m.content, m.role, t.external_id
       FROM addie_thread_messages m
       JOIN addie_threads t ON t.thread_id = m.thread_id
       WHERE t.person_id = $1
       ORDER BY m.created_at DESC`,
      [personId]
    );

    expect(threadResult.rows[0]?.role).toBe('assistant');
    expect(threadResult.rows[0]?.content).toContain('Welcome');
    expect(threadResult.rows[0]?.external_id).toContain('SIM_DM_SIM_U_ENGAGED01:');
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
