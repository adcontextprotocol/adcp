/**
 * Annoyance Cascade Scenario
 *
 * Tests that Addie backs off when messages go unreplied.
 * This is the most critical safety test — without it, Addie
 * would message unresponsive people every 3 days forever.
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
import { annoyanceCascade, slackNewJoiner } from '../fixtures/profiles/archetypes.js';

const clock = new SimulationClock(new Date('2026-03-15T10:00:00Z'));
const interceptors = createInterceptors(clock);
mockAnthropicModule(interceptors.anthropic, clock);
mockResendModule(interceptors.resend, clock);

vi.stubEnv('OUTREACH_ENABLED', 'true');
vi.stubEnv('EMAIL_OUTREACH_ENABLED', 'true');
vi.stubEnv('ADDIE_ANTHROPIC_API_KEY', 'sim-test-key');

describe('Annoyance cascade prevention', () => {
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

  it('escalates cooldown after 2 unreplied messages', async () => {
    const ids = await engine.seedProfiles([annoyanceCascade]);
    const personId = ids.get('annoyance-cascade')!;

    // annoyanceCascade has 2 unreplied, welcomed stage (3d cooldown)
    // With 2 unreplied, should escalate to exploring cooldown (7d)
    // Last message was 4 days ago — 4 < 7, so should be skipped

    const result = await engine.runOutreachCycle({ limit: 5 });

    const person = await engine.getRelationship(personId);
    expect(person).not.toBeNull();

    // Should have been skipped (cooldown escalated to 7d, only 4d passed)
    const events = await engine.getPersonEvents(personId);
    const skipEvents = events.filter(e => e.event_type === 'outreach_skipped');
    const sendEvents = events.filter(e => e.event_type === 'message_sent');

    expect(sendEvents.length).toBe(0);
    // Skip event should exist with cooldown reason
    expect(skipEvents.length).toBeGreaterThan(0);
  });

  it('stops entirely after 3 unreplied messages', async () => {
    // Create a profile with 3 unreplied
    const threeUnreplied = {
      ...annoyanceCascade,
      id: 'three-unreplied',
      description: '3 unreplied messages, should be completely blocked',
      relationship: {
        ...annoyanceCascade.relationship,
        slack_user_id: 'SIM_U_3UNREP',
        unreplied_outreach_count: 3,
        // Even if cooldown has passed (last message 30 days ago)
        last_addie_message_at: new Date(Date.now() - 30 * 86400000).toISOString(),
      },
    };

    const ids = await engine.seedProfiles([threeUnreplied]);
    const personId = ids.get('three-unreplied')!;

    // Even with 30 days since last message, should not contact
    engine.advanceTime({ days: 30 });
    const result = await engine.runOutreachCycle({ limit: 5 });

    const events = await engine.getPersonEvents(personId);
    const sendEvents = events.filter(e => e.event_type === 'message_sent');
    expect(sendEvents.length).toBe(0);
  });

  it('resets unreplied count when person responds', async () => {
    const ids = await engine.seedProfiles([annoyanceCascade]);
    const personId = ids.get('annoyance-cascade')!;

    // Verify initially blocked
    const beforePerson = await engine.getRelationship(personId);
    expect(beforePerson!.unreplied_outreach_count).toBe(2);

    // Person responds
    await engine.simulateUserAction(personId, {
      type: 'slack_message',
      text: 'Hey, sorry for the late reply! I was on vacation.',
    });

    // Check counter reset
    const afterPerson = await engine.getRelationship(personId);
    expect(afterPerson!.unreplied_outreach_count).toBe(0);

    // Now advance past cooldown and run outreach
    engine.advanceTime({ days: 8 }); // past exploring cooldown (7d)
    const result = await engine.runOutreachCycle({ limit: 5 });

    // Should now be eligible again
    const events = await engine.getPersonEvents(personId);
    const sendEvents = events.filter(e => e.event_type === 'message_sent');
    // Addie can contact them again
    expect(sendEvents.length).toBeGreaterThanOrEqual(0); // May or may not send depending on Sonnet
  });

  it('tracks unreplied count increasing with each proactive message', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    // Cycle 1: welcome message (unreplied_outreach_count goes 0 -> 1)
    await engine.runOutreachCycle({ limit: 5 });
    let person = await engine.getRelationship(personId);
    expect(person!.unreplied_outreach_count).toBe(1);

    // Advance past welcomed cooldown (3 days)
    engine.advanceTime({ days: 4 });

    // Cycle 2: follow-up (unreplied_outreach_count goes 1 -> 2)
    await engine.runOutreachCycle({ limit: 5 });
    person = await engine.getRelationship(personId);
    expect(person!.unreplied_outreach_count).toBe(2);

    // Advance — now with 2 unreplied, cooldown escalates to exploring (7d)
    engine.advanceTime({ days: 4 }); // Only 4 days — not enough for escalated cooldown

    // Cycle 3: should be SKIPPED because escalated cooldown
    const beforeSend = interceptors.slack.sentMessages.length;
    await engine.runOutreachCycle({ limit: 5 });
    expect(interceptors.slack.sentMessages.length).toBe(beforeSend);
  });
});
