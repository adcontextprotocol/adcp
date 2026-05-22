/**
 * `pickFromInput` lifts named fields off the v6 framework's `ctx.input`
 * envelope so v5 handlers see modifiers the v6 typed signature drops
 * (adcp-client#1842).
 */

import { describe, expect, it } from 'vitest';
import { pickFromInput } from '../../src/training-agent/v6-input-helpers.js';

describe('pickFromInput', () => {
  it('returns named fields when present', () => {
    const out = pickFromInput(
      { dry_run: true, assignments: [{ creative_id: 'c1', package_id: 'p1' }], extra: 'ignored' },
      ['dry_run', 'assignments'] as const,
    );
    expect(out).toEqual({
      dry_run: true,
      assignments: [{ creative_id: 'c1', package_id: 'p1' }],
    });
  });

  it('omits fields that are not present (no undefined leakage)', () => {
    const out = pickFromInput({ dry_run: true }, ['dry_run', 'assignments'] as const);
    expect(out).toEqual({ dry_run: true });
    expect('assignments' in out).toBe(false);
  });

  it('preserves falsy values that are explicitly set', () => {
    const out = pickFromInput({ dry_run: false }, ['dry_run'] as const);
    expect(out).toEqual({ dry_run: false });
    expect('dry_run' in out).toBe(true);
  });

  it('returns empty when ctx.input is undefined', () => {
    expect(pickFromInput(undefined, ['dry_run'] as const)).toEqual({});
  });

  it('returns empty when no requested fields are present', () => {
    expect(pickFromInput({ unrelated: 1 }, ['dry_run'] as const)).toEqual({});
  });
});
