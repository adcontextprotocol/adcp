/**
 * Stage Progression Scenario
 *
 * Tests the full person lifecycle from prospect through to active participant.
 * Validates that stage transitions happen in response to real user actions
 * and that Addie's behavior adapts to each stage.
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
import { writeReport } from '../engine/report.js';
import { slackNewJoiner } from '../fixtures/profiles/archetypes.js';

const clock = new SimulationClock(new Date('2026-03-15T10:00:00Z'));
const interceptors = createInterceptors(clock);
mockAnthropicModule(interceptors.anthropic, clock);
mockResendModule(interceptors.resend, clock);

vi.stubEnv('OUTREACH_ENABLED', 'true');
vi.stubEnv('EMAIL_OUTREACH_ENABLED', 'true');
vi.stubEnv('ADDIE_ANTHROPIC_API_KEY', 'sim-test-key');

describe('Stage progression', () => {
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

  it('advances from prospect to welcomed after first Addie message', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    // Before outreach: prospect
    let person = await engine.getRelationship(personId);
    expect(person!.stage).toBe('prospect');

    // Run outreach -> welcome message sent
    await engine.runOutreachCycle({ limit: 5 });

    // After outreach: welcomed
    person = await engine.getRelationship(personId);
    expect(person!.stage).toBe('welcomed');

    // Verify stage_changed event in person_events
    const events = await engine.getPersonEvents(personId);
    const stageEvents = events.filter(e => e.event_type === 'stage_changed');
    expect(stageEvents.some(e => {
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      return data.to === 'welcomed';
    })).toBe(true);
  });

  it('advances from welcomed to exploring when person responds', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    // Welcome
    await engine.runOutreachCycle({ limit: 5 });
    let person = await engine.getRelationship(personId);
    expect(person!.stage).toBe('welcomed');

    // Person responds
    engine.advanceTime({ days: 1 });
    await engine.simulateUserAction(personId, {
      type: 'slack_message',
      text: 'Thanks! I work in programmatic advertising and heard about AgenticAdvertising.org from a colleague.',
    });

    person = await engine.getRelationship(personId);
    expect(person!.stage).toBe('exploring');
  });

  it('advances from welcomed to exploring when person links account', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    // Welcome
    await engine.runOutreachCycle({ limit: 5 });

    // Person links their website account
    engine.advanceTime({ days: 2 });
    await engine.simulateUserAction(personId, {
      type: 'link_account',
      workosUserId: 'sim_workos_new01',
    });

    const person = await engine.getRelationship(personId);
    expect(person!.stage).toBe('exploring');
  });

  it('generates a simulation report', async () => {
    const ids = await engine.seedProfiles([slackNewJoiner]);
    const personId = ids.get('slack-new-joiner')!;

    // Simulate a multi-day journey
    await engine.runOutreachCycle({ limit: 5 }); // Day 0: welcome

    engine.advanceTime({ days: 1 });
    await engine.simulateUserAction(personId, {
      type: 'slack_message',
      text: 'Thanks! Excited to be here.',
    });

    engine.advanceTime({ days: 7 });
    await engine.runOutreachCycle({ limit: 5 }); // Day 8: follow-up

    // Generate report
    const report = await engine.generateReport();

    expect(report.profiles.length).toBe(1);
    expect(report.profiles[0]?.startStage).toBe('prospect');
    expect(report.duration.simDays).toBeGreaterThan(7);
    expect(report.timeline.length).toBeGreaterThan(0);

    // Write HTML report (inspect manually if needed)
    const filepath = await writeReport(report, 'stage-progression.html');
    expect(filepath).toContain('stage-progression.html');
  });
});
