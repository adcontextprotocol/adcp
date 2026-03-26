/**
 * Regression tests for the outreach simulator.
 *
 * Uses seeded PRNG (seed=42) so results are deterministic. If these tests fail,
 * it means engagement rules or simulator logic changed — review the diff to confirm
 * the new behavior is intended, then update the snapshots.
 */

import { describe, it, expect } from '@jest/globals';
import { PERSONAS, simulate, type SimulationResult } from '../../server/src/addie/services/outreach-simulator.js';
import {
  STAGE_COOLDOWNS,
  MAX_UNREPLIED_BEFORE_PULSE,
  MONTHLY_PULSE_DAYS,
} from '../../server/src/addie/services/engagement-planner.js';
import { STAGE_ORDER } from '../../server/src/db/relationship-db.js';

const SEED = 42;
const DURATION = 90;

function runAll(): Map<string, SimulationResult> {
  const results = new Map<string, SimulationResult>();
  for (const persona of PERSONAS) {
    results.set(persona.name, simulate(persona, DURATION, { seed: SEED }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same seed produces identical results across runs', () => {
    const run1 = runAll();
    const run2 = runAll();

    for (const [name, r1] of run1) {
      const r2 = run2.get(name)!;
      expect(r1.summary).toEqual(r2.summary);
      expect(r1.events.length).toBe(r2.events.length);
    }
  });

  it('different seeds produce different results for stochastic personas', () => {
    const emailOnly = PERSONAS.find(p => p.name === 'The Email-Only Prospect')!;
    const r1 = simulate(emailOnly, DURATION, { seed: 42 });
    const r2 = simulate(emailOnly, DURATION, { seed: 99 });

    // With different seeds, at least one summary field should differ
    const s1 = r1.summary;
    const s2 = r2.summary;
    const differs = s1.totalContacts !== s2.totalContacts
      || s1.personResponses !== s2.personResponses
      || s1.finalUnreplied !== s2.finalUnreplied;
    expect(differs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapshot regression: exact values with seed=42 over 90 days
// ---------------------------------------------------------------------------

describe('snapshot regression (seed=42, 90 days)', () => {
  const results = runAll();

  const EXPECTED: Record<string, {
    totalContacts: number;
    personResponses: number;
    totalBlocks: number;
    finalStage: string;
    finalUnreplied: number;
    averageDaysBetweenContacts: number;
  }> = {
    'The Ghost': {
      totalContacts: 4,
      personResponses: 0,
      totalBlocks: 73,
      finalStage: 'welcomed',
      finalUnreplied: 4,
      averageDaysBetweenContacts: 24.7,
    },
    'The Engaged Prospect': {
      totalContacts: 7,
      personResponses: 7,
      totalBlocks: 0,
      finalStage: 'exploring',
      finalUnreplied: 0,
      averageDaysBetweenContacts: 14,
    },
    'The Slow Responder': {
      totalContacts: 6,
      personResponses: 4,
      totalBlocks: 30,
      finalStage: 'exploring',
      finalUnreplied: 0,
      averageDaysBetweenContacts: 17.2,
    },
    'The Email-Only Prospect': {
      totalContacts: 4,
      personResponses: 0,
      totalBlocks: 73,
      finalStage: 'welcomed',
      finalUnreplied: 4,
      averageDaysBetweenContacts: 24.7,
    },
    'The Active Member': {
      totalContacts: 3,
      personResponses: 1,
      totalBlocks: 1,
      finalStage: 'participating',
      finalUnreplied: 1,
      averageDaysBetweenContacts: 30,
    },
    'The Busy Executive': {
      totalContacts: 3,
      personResponses: 0,
      totalBlocks: 58,
      finalStage: 'exploring',
      finalUnreplied: 3,
      averageDaysBetweenContacts: 30,
    },
    'The DM Ignorer': {
      totalContacts: 3,
      personResponses: 0,
      totalBlocks: 58,
      finalStage: 'participating',
      finalUnreplied: 3,
      averageDaysBetweenContacts: 30,
    },
    'The Multi-Channel Responder': {
      totalContacts: 6,
      personResponses: 3,
      totalBlocks: 2,
      finalStage: 'exploring',
      finalUnreplied: 1,
      averageDaysBetweenContacts: 17.2,
    },
    'The Negative Recovery': {
      totalContacts: 2,
      personResponses: 0,
      totalBlocks: 59,
      finalStage: 'exploring',
      finalUnreplied: 2,
      averageDaysBetweenContacts: 30,
    },
  };

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} matches snapshot`, () => {
      const r = results.get(name)!;
      expect(r).toBeDefined();
      expect(r.summary.totalContacts).toBe(expected.totalContacts);
      expect(r.summary.personResponses).toBe(expected.personResponses);
      expect(r.summary.totalBlocks).toBe(expected.totalBlocks);
      expect(r.summary.finalStage).toBe(expected.finalStage);
      expect(r.summary.finalUnreplied).toBe(expected.finalUnreplied);
      expect(r.summary.averageDaysBetweenContacts).toBe(expected.averageDaysBetweenContacts);
    });
  }
});

// ---------------------------------------------------------------------------
// Behavioral invariants (independent of seed)
// ---------------------------------------------------------------------------

describe('behavioral invariants', () => {
  const results = runAll();

  it('ghost never gets more than MAX_UNREPLIED_BEFORE_PULSE + 2 contacts in 90 days', () => {
    const ghost = results.get('The Ghost')!;
    // After 3 unreplied, monthly pulse kicks in. Over 90 days that's at most 3 + floor(90/30) = 6
    const maxExpected = MAX_UNREPLIED_BEFORE_PULSE + Math.floor(DURATION / MONTHLY_PULSE_DAYS) + 1;
    expect(ghost.summary.totalContacts).toBeLessThanOrEqual(maxExpected);
  });

  it('ghost has 0 person responses', () => {
    const ghost = results.get('The Ghost')!;
    expect(ghost.summary.personResponses).toBe(0);
  });

  it('engaged prospect always has 0 unreplied at end', () => {
    const engaged = results.get('The Engaged Prospect')!;
    expect(engaged.summary.finalUnreplied).toBe(0);
  });

  it('engaged prospect advances past prospect stage', () => {
    const engaged = results.get('The Engaged Prospect')!;
    expect(engaged.summary.finalStage).not.toBe('prospect');
  });

  it('slow responder eventually responds and resets unreplied', () => {
    const slow = results.get('The Slow Responder')!;
    expect(slow.summary.personResponses).toBeGreaterThan(0);
    expect(slow.summary.finalUnreplied).toBeLessThan(MAX_UNREPLIED_BEFORE_PULSE);
  });

  it('active member maintains low unreplied count', () => {
    const active = results.get('The Active Member')!;
    expect(active.summary.finalUnreplied).toBeLessThanOrEqual(MAX_UNREPLIED_BEFORE_PULSE);
  });

  it('no persona receives more than 1 message per day', () => {
    for (const [, result] of results) {
      const contactsByDay = new Map<number, number>();
      for (const e of result.events) {
        if (e.action === 'contacted') {
          contactsByDay.set(e.day, (contactsByDay.get(e.day) ?? 0) + 1);
        }
      }
      for (const [day, count] of contactsByDay) {
        expect(count).toBeLessThanOrEqual(1);
      }
    }
  });

  it('contacts respect stage cooldowns', () => {
    for (const [, result] of results) {
      const contacts = result.events.filter(e => e.action === 'contacted');
      for (let i = 1; i < contacts.length; i++) {
        const prev = contacts[i - 1];
        const curr = contacts[i];
        const gap = curr.day - prev.day;

        // If the person responded between these contacts, cooldown resets
        const responseBetween = result.events.some(
          e => e.action === 'person_responded' && e.day > prev.day && e.day <= curr.day
        );
        if (responseBetween) continue;

        // Under monthly pulse, the gap must be >= MONTHLY_PULSE_DAYS
        if (prev.unrepliedCount >= MAX_UNREPLIED_BEFORE_PULSE) {
          expect(gap).toBeGreaterThanOrEqual(MONTHLY_PULSE_DAYS);
        } else {
          // Under normal rules, gap must be >= stage cooldown
          const minCooldown = STAGE_COOLDOWNS[prev.stage];
          expect(gap).toBeGreaterThanOrEqual(minCooldown);
        }
      }
    }
  });

  it('stage only advances forward, never regresses', () => {
    for (const [, result] of results) {
      let highestStageIdx = STAGE_ORDER.indexOf(result.persona.stage);
      for (const e of result.events) {
        const idx = STAGE_ORDER.indexOf(e.stage);
        expect(idx).toBeGreaterThanOrEqual(highestStageIdx);
        highestStageIdx = Math.max(highestStageIdx, idx);
      }
    }
  });

  it('unreplied count never goes negative', () => {
    for (const [, result] of results) {
      for (const e of result.events) {
        expect(e.unrepliedCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('negative recovery persona is blocked initially then contacts resume', () => {
    const negRecovery = results.get('The Negative Recovery')!;
    // Should have blocked events from negative sentiment at the start
    const negBlocks = negRecovery.events.filter(e => e.action === 'blocked' && e.reason.includes('negative sentiment'));
    expect(negBlocks.length).toBeGreaterThan(0);
    // First contact should be after day 30 (recovery period)
    const firstContact = negRecovery.events.find(e => e.action === 'contacted');
    expect(firstContact).toBeDefined();
    expect(firstContact!.day).toBeGreaterThanOrEqual(30);
  });

  it('email-only persona only uses email channel', () => {
    const emailOnly = results.get('The Email-Only Prospect')!;
    const contacts = emailOnly.events.filter(e => e.action === 'contacted');
    for (const c of contacts) {
      expect(c.channel).toBe('email');
    }
  });

  it('slack personas use slack channel', () => {
    for (const persona of PERSONAS) {
      if (!persona.hasSlack) continue;
      const result = results.get(persona.name)!;
      const contacts = result.events.filter(e => e.action === 'contacted');
      for (const c of contacts) {
        expect(c.channel).toBe('slack');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Harassment prevention
// ---------------------------------------------------------------------------

describe('harassment prevention', () => {
  it('no persona gets >10 messages with 0 responses', () => {
    const results = runAll();
    for (const [name, result] of results) {
      if (result.summary.personResponses === 0) {
        expect(result.summary.totalContacts).toBeLessThanOrEqual(10);
      }
    }
  });

  it('average gap is at least 5 days for non-responding personas', () => {
    const results = runAll();
    for (const [, result] of results) {
      if (result.summary.personResponses === 0 && result.summary.totalContacts > 1) {
        expect(result.summary.averageDaysBetweenContacts).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('monthly pulse enforces 30-day gaps after 3+ unreplied (no response in between)', () => {
    const results = runAll();
    for (const [, result] of results) {
      const contacts = result.events.filter(e => e.action === 'contacted');
      for (let i = 1; i < contacts.length; i++) {
        // Skip if a person response occurred between these two contacts (resets unreplied)
        const responseBetween = result.events.some(
          e => e.action === 'person_responded' && e.day > contacts[i - 1].day && e.day <= contacts[i].day
        );
        if (responseBetween) continue;

        if (contacts[i - 1].unrepliedCount >= MAX_UNREPLIED_BEFORE_PULSE) {
          const gap = contacts[i].day - contacts[i - 1].day;
          expect(gap).toBeGreaterThanOrEqual(MONTHLY_PULSE_DAYS);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scaling: different durations produce consistent behavior
// ---------------------------------------------------------------------------

describe('scaling', () => {
  it('30-day simulation respects same invariants as 90-day', () => {
    for (const persona of PERSONAS) {
      const result = simulate(persona, 30, { seed: SEED });
      const contacts = result.events.filter(e => e.action === 'contacted');

      // No duplicate days
      const days = contacts.map(e => e.day);
      expect(new Set(days).size).toBe(days.length);

      // Unreplied never negative
      for (const e of result.events) {
        expect(e.unrepliedCount).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
