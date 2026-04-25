/**
 * Tests for the integrity-invariant runner. Verifies sequential execution,
 * isolation of failures, severity tallying, and meta-violation emission.
 */
import { describe, it, expect, vi } from 'vitest';
import { runAllInvariants, runOneInvariant } from '../../../src/audit/integrity/runner.js';
import type { Invariant, InvariantContext, InvariantResult } from '../../../src/audit/integrity/types.js';

function makeCtx(): InvariantContext {
  return {
    pool: {} as InvariantContext['pool'],
    stripe: {} as InvariantContext['stripe'],
    workos: {} as InvariantContext['workos'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as InvariantContext['logger'],
  };
}

function makeInvariant(
  name: string,
  result: InvariantResult | (() => Promise<InvariantResult>),
): Invariant {
  return {
    name,
    description: `Test invariant ${name}`,
    severity: 'critical',
    check: async () => (typeof result === 'function' ? result() : result),
  };
}

describe('runAllInvariants', () => {
  it('runs each invariant in order and aggregates violations', async () => {
    const ctx = makeCtx();
    const callOrder: string[] = [];
    const invariants: Invariant[] = [
      {
        name: 'a',
        description: 'a',
        severity: 'critical',
        check: async () => {
          callOrder.push('a');
          return { checked: 1, violations: [] };
        },
      },
      {
        name: 'b',
        description: 'b',
        severity: 'warning',
        check: async () => {
          callOrder.push('b');
          return {
            checked: 2,
            violations: [
              {
                invariant: 'b',
                severity: 'warning',
                subject_type: 'organization',
                subject_id: 'org_1',
                message: 'mismatch',
              },
            ],
          };
        },
      },
    ];

    const report = await runAllInvariants(invariants, ctx);

    expect(callOrder).toEqual(['a', 'b']);
    expect(report.total_violations).toBe(1);
    expect(report.violations_by_severity).toEqual({ critical: 0, warning: 1, info: 0 });
    expect(report.violations[0].invariant).toBe('b');
    expect(report.stats.a.checked).toBe(1);
    expect(report.stats.a.violations).toBe(0);
    expect(report.stats.b.checked).toBe(2);
    expect(report.stats.b.violations).toBe(1);
  });

  it('isolates a thrown invariant: subsequent invariants still run, throwing one becomes a meta-violation', async () => {
    const ctx = makeCtx();
    const invariants: Invariant[] = [
      makeInvariant('first', { checked: 0, violations: [] }),
      {
        name: 'broken',
        description: 'broken',
        severity: 'critical',
        check: async () => {
          throw new Error('Stripe API down');
        },
      },
      makeInvariant('after', {
        checked: 5,
        violations: [
          {
            invariant: 'after',
            severity: 'critical',
            subject_type: 'organization',
            subject_id: 'org_x',
            message: 'something',
          },
        ],
      }),
    ];

    const report = await runAllInvariants(invariants, ctx);

    expect(report.violations).toHaveLength(2); // meta-violation + after's own
    const meta = report.violations.find((v) => v.invariant === 'broken');
    expect(meta).toBeDefined();
    expect(meta!.severity).toBe('warning');
    expect(meta!.subject_type).toBe('configuration');
    expect(meta!.message).toContain('Stripe API down');
    expect(report.stats.broken.error).toBe('Stripe API down');
    expect(report.stats.after.checked).toBe(5); // ran despite earlier throw
  });

  it('counts violations by severity correctly', async () => {
    const ctx = makeCtx();
    const invariants: Invariant[] = [
      makeInvariant('a', {
        checked: 1,
        violations: [
          { invariant: 'a', severity: 'critical', subject_type: 'organization', subject_id: '1', message: 'x' },
          { invariant: 'a', severity: 'critical', subject_type: 'organization', subject_id: '2', message: 'y' },
          { invariant: 'a', severity: 'warning', subject_type: 'organization', subject_id: '3', message: 'z' },
          { invariant: 'a', severity: 'info', subject_type: 'organization', subject_id: '4', message: 'q' },
        ],
      }),
    ];

    const report = await runAllInvariants(invariants, ctx);
    expect(report.violations_by_severity).toEqual({ critical: 2, warning: 1, info: 1 });
  });

  it('records timing on each invariant', async () => {
    const ctx = makeCtx();
    const invariants: Invariant[] = [makeInvariant('a', { checked: 0, violations: [] })];
    const report = await runAllInvariants(invariants, ctx);
    expect(report.stats.a.ms).toBeGreaterThanOrEqual(0);
    expect(report.completed_at.getTime()).toBeGreaterThanOrEqual(report.started_at.getTime());
  });
});

describe('runOneInvariant', () => {
  it('runs a single invariant and returns a single-entry report', async () => {
    const ctx = makeCtx();
    const inv = makeInvariant('only', {
      checked: 3,
      violations: [{ invariant: 'only', severity: 'critical', subject_type: 'organization', subject_id: '1', message: 'x' }],
    });

    const report = await runOneInvariant(inv, ctx);

    expect(Object.keys(report.stats)).toEqual(['only']);
    expect(report.total_violations).toBe(1);
  });
});
