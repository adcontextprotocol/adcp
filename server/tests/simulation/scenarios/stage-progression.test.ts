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
} from '../engine/interceptors.js';
import { writeReport } from '../engine/report.js';
import { slackNewJoiner } from '../fixtures/profiles/archetypes.js';

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
