/**
 * Integrity-invariant framework types.
 *
 * Each invariant is a self-contained assertion about state across WorkOS,
 * Stripe, and AAO Postgres. Violations are reported per offending entity,
 * not in aggregate, so operators can act on them individually.
 */
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import type { WorkOS } from '@workos-inc/node';
import type { Logger } from 'pino';

export type Severity = 'critical' | 'warning' | 'info';

/**
 * What kind of entity the violation is about. Used for grouping in admin UI
 * and for narrowing remediation actions. Add new subject types here when a
 * new invariant needs one — keeping this tight prevents drift.
 */
export type SubjectType =
  | 'organization'
  | 'user'
  | 'subscription'
  | 'customer'
  | 'membership'
  | 'configuration';

export interface Violation {
  /** Identifier of the invariant that fired this violation. */
  invariant: string;
  severity: Severity;
  subject_type: SubjectType;
  /** Stable identifier of the offending entity (org id, customer id, etc.). */
  subject_id: string;
  /** Human-readable summary, safe to show in admin UI. */
  message: string;
  /** Structured details for programmatic remediation. */
  details?: Record<string, unknown>;
  /** Optional admin-facing fix suggestion. */
  remediation_hint?: string;
}

export interface InvariantOptions {
  /**
   * For invariants that walk a sampled subset of entities, the maximum
   * number to check in one run. Sampled invariants are responsible for
   * cycling through different rows over multiple runs.
   */
  sampleSize?: number;
  /**
   * Skip rows whose `updated_at` is before this date. Lets a periodic
   * runner focus on recently-changed entities.
   */
  sinceUpdated?: Date;
}

export interface InvariantContext {
  pool: Pool;
  stripe: Stripe;
  workos: WorkOS;
  logger: Logger;
  options?: InvariantOptions;
}

export interface InvariantResult {
  /** Number of entities the invariant inspected this run. */
  checked: number;
  violations: Violation[];
}

export interface Invariant {
  /** Stable, URL-safe identifier. Used in routes, logs, persisted reports. */
  name: string;
  /** One-paragraph explanation surfaced in admin UI / dashboards. */
  description: string;
  /** Default severity for this invariant's violations. */
  severity: Severity;
  check: (ctx: InvariantContext) => Promise<InvariantResult>;
}

export interface InvariantRunStats {
  ms: number;
  checked: number;
  violations: number;
  /** Set when the invariant's check function threw. */
  error?: string;
}

export interface InvariantRunReport {
  started_at: Date;
  completed_at: Date;
  total_violations: number;
  violations_by_severity: Record<Severity, number>;
  violations: Violation[];
  /** Per-invariant timing + counts for performance tracking. */
  stats: Record<string, InvariantRunStats>;
}
