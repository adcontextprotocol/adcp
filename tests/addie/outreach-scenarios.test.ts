/**
 * The rate-limit and grace-period red team scenarios must exercise the
 * production engagement rules, not compare hard-coded constants.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RED_TEAM_SCENARIOS } from '../../server/src/addie/testing/outreach-scenarios.js';

const forceContact = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../server/src/addie/services/engagement-planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/src/addie/services/engagement-planner.js')>();
  return {
    ...actual,
    shouldContact: (relationship: Parameters<typeof actual.shouldContact>[0]) =>
      forceContact.enabled
        ? { shouldContact: true, reason: 'forced', channel: 'slack' as const }
        : actual.shouldContact(relationship),
  };
});

function scenario(id: string) {
  const found = RED_TEAM_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found;
}

afterEach(() => {
  forceContact.enabled = false;
});

describe('outreach red team scenarios', () => {
  it('spam_within_week passes against the real stage cooldown', () => {
    const result = scenario('spam_within_week').testFunction();
    expect(result.passed).toBe(true);
    expect(result.recommendations[0]).toContain('stage cooldown');
  });

  it('new_member_immediate_dm passes against the real welcome grace period', () => {
    const result = scenario('new_member_immediate_dm').testFunction();
    expect(result.passed).toBe(true);
    expect(result.recommendations[0]).toContain('grace period');
  });

  it.each(['spam_within_week', 'new_member_immediate_dm'])(
    '%s fails when shouldContact() allows contact',
    (id) => {
      forceContact.enabled = true;
      const result = scenario(id).testFunction();
      expect(result.passed).toBe(false);
      expect(result.issues[0]).toContain('forced');
    },
  );
});
