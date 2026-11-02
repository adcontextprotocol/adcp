/**
 * Which stores the #7830 registry-key migration rewrites, and how a genuine
 * key collision in each is resolved.
 *
 * Shared by the rewrite (`migrate-registry-agent-url-keys.ts`) and the
 * read-only gate (`audit-registry-key-collisions.ts`) so the two can never
 * disagree about what the migration will touch.
 */
import type { PoolClient } from 'pg';

export const PROFILE_AGENTS_STORE = 'member_profiles.agents';

/** Quote an identifier that came from pg_catalog, never from an operator. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Identity stores: `agent_url` (or `agent_url_canonical`) is how a reader
 * finds the row, so a key left in the old form makes the row unreachable and
 * the next write creates a duplicate alongside it.
 */
export const REWRITE_STORES = new Set([
  'adagents_authorization_overrides',
  'agent_capabilities_snapshot',
  'agent_compliance_refresh_requests',
  'agent_compliance_status',
  'agent_contexts',
  'agent_grading_profile_projection_jobs',
  'agent_grading_profiles',
  'agent_health_snapshot',
  'agent_inventory_profiles',
  'agent_registry_metadata',
  'agent_storyboard_status',
  'agent_verification_badges',
  'catalog_agent_authorizations',
  'discovered_agents',
]);

/**
 * Tables that hold an `agent_url` but must NOT be rewritten, each with the
 * reason, because "why was this skipped" is the first question an operator
 * reading the report will have.
 *
 * Two shapes. Append-only history records the key that was in use when the
 * event happened — rewriting it would falsify the record, and three of these
 * tables enforce that with an append-only trigger (migration 598), so a blind
 * UPDATE would abort the run. The other shape is a reader that matches
 * `agent_url` against the caller's raw input rather than against a key.
 *
 * Not a store, but worth knowing: for `evidence='agent_claim'` rows,
 * `catalog_agent_authorizations.created_by` holds the asserting agent's URL
 * (migration 440), and it has never been canonicalized. After the rewrite it
 * and `agent_url_canonical` on the same row are in different key forms. The
 * documented revocation path matches `created_by` against a raw URL, so it
 * stays self-consistent; tracked separately rather than changed here.
 */
export const REPORT_ONLY_STORES = new Map<string, string>([
  ['agent_publisher_authorizations',
    'readers match agent_url against the caller raw input, not a key (#3177 dual-read)'],
  ['agent_property_authorizations',
    'readers match agent_url against the caller raw input, not a key (#3177 dual-read)'],
  ['agent_compliance_runs',
    'append-only run history; append-only trigger (migration 598)'],
  ['agent_compliance_step_diagnostics',
    'per-run diagnostics; child of agent_compliance_runs'],
  ['agent_grading_profile_audit',
    'append-only audit trail; append-only trigger (migration 598)'],
  ['verification_profile_role_assessments',
    'append-only assessment history; append-only trigger (migration 598)'],
  ['verification_profile_shadow_assessments',
    'shadow-mode assessment history'],
  ['addie_agent_quality_evaluations',
    'evaluation history; records the key in use at the time'],
  ['agent_outbound_requests',
    'request telemetry; high volume, no identity role'],
  ['manifest_references',
    'community manifest contributions; agent_url is a reference, not a key'],
  ['type_reclassification_log',
    'append-only reclassification log'],
]);

// =============================================================================
// Merge policy
// =============================================================================

/**
 * How one column of a merged row is composed from the rows being merged.
 *
 *   winner   the surviving row's value (the default for any column with no
 *            rule, so a merged row is one coherent observation unless a
 *            column is explicitly called out)
 *   min/max  the extreme across the group, nulls ignored
 *   anyTrue  true if any row is true — the conservative direction for a flag
 *            that suppresses, pauses or gates something
 *   maxPlusOne  one past the group's maximum, so an in-flight job holding an
 *            older generation cannot clear the merged row's gate
 *   reset    a fixed value, for leases and claims that belong to a row id
 *            that is about to stop existing
 */
export type CombineRule =
  | { kind: 'min' | 'max' | 'anyTrue' | 'maxPlusOne' }
  | { kind: 'reset'; value: unknown };

export interface MergePolicy {
  /**
   * Orders the group best-first; `rows[0]` survives. Every rule is applied
   * in order, and a final tiebreak on the row identity keeps the choice
   * deterministic across runs.
   */
  readonly rank: ReadonlyArray<{
    column: string;
    direction: 'asc' | 'desc';
    /** Rank order for an enum column, best last. Compared by index. */
    order?: readonly string[];
  }>;
  readonly combine: Readonly<Record<string, CombineRule>>;
  /** Why this policy is the right answer for this table. */
  readonly rationale: string;
}

/**
 * Tables whose collisions the migration resolves automatically.
 *
 * The line is deliberate: a policy exists only where the row is a DERIVED or
 * OBSERVATIONAL record — a status, a snapshot, a badge, a queue entry — where
 * "two spellings of one agent" means two observations of one thing and
 * composing them loses nothing a human would have decided differently.
 *
 * There is NO policy, and a collision therefore blocks, for the two stores
 * where a wrong merge would hand an agent someone else's credentials or
 * someone else's ownership: `agent_contexts` (per-org OAuth tokens) and
 * `member_profiles.agents`. Production has no collisions in either today; if
 * one appears it wants a human, not a default.
 *
 * Whatever the policy, no value is dropped quietly: the dry run lists every
 * losing row and every field whose value the merged row does not carry.
 */
export const MERGE_POLICIES: Readonly<Record<string, MergePolicy>> = {
  agent_registry_metadata: {
    rank: [{ column: 'updated_at', direction: 'desc' }],
    combine: {
      created_at: { kind: 'min' },
      updated_at: { kind: 'max' },
      compliance_opt_out: { kind: 'anyTrue' },
      monitoring_paused: { kind: 'anyTrue' },
      monitoring_paused_at: { kind: 'max' },
      badge_requalification_required: { kind: 'anyTrue' },
      badge_requalification_generation: { kind: 'maxPlusOne' },
      check_interval_hours: { kind: 'min' },
      next_compliance_check_at: { kind: 'min' },
      requeued_at: { kind: 'max' },
      compliance_inconclusive_streak: { kind: 'max' },
      // A heartbeat lease belongs to the row id the runner claimed. That row
      // may be the one being deleted, so clear the lease and let the next
      // heartbeat claim the survivor cleanly.
      heartbeat_claim_owner: { kind: 'reset', value: null },
      heartbeat_started_at: { kind: 'reset', value: null },
      heartbeat_orphan_streak: { kind: 'reset', value: 0 },
    },
    rationale:
      'Lifecycle comes from the most recently updated row; every flag that '
      + 'suppresses, pauses or gates takes the conservative value, so a merge '
      + 'can never re-enable monitoring an operator turned off or clear a '
      + 'requalification gate.',
  },
  agent_compliance_status: {
    rank: [
      { column: 'last_checked_at', direction: 'desc' },
      { column: 'updated_at', direction: 'desc' },
    ],
    combine: {
      last_checked_at: { kind: 'max' },
      last_passed_at: { kind: 'max' },
      last_failed_at: { kind: 'max' },
      status_changed_at: { kind: 'max' },
      updated_at: { kind: 'max' },
    },
    rationale:
      'The freshest check decides the current status, headline and streak — '
      + 'those belong to one lineage. The last-passed/last-failed timestamps '
      + 'are facts about the agent rather than about the row, so they take '
      + 'the latest across spellings.',
  },
  agent_verification_badges: {
    rank: [
      { column: 'status', direction: 'desc', order: ['revoked', 'degraded', 'active'] },
      { column: 'verified_at', direction: 'desc' },
    ],
    combine: {
      created_at: { kind: 'min' },
      updated_at: { kind: 'max' },
      token_expires_at: { kind: 'max' },
    },
    rationale:
      'An active badge outranks a degraded one and a degraded one outranks a '
      + 'revoked one, then the most recent verification wins. A badge is never '
      + 'silently lost: the losers are listed in the report, and a revoked '
      + 'badge cannot displace an active one for the same role and version.',
  },
  agent_capabilities_snapshot: {
    rank: [{ column: 'last_discovered', direction: 'desc' }],
    combine: {
      last_discovered: { kind: 'max' },
      updated_at: { kind: 'max' },
      last_probe_attempt_at: { kind: 'max' },
      next_probe_after: { kind: 'min' },
      unknown_probe_attempt_count: { kind: 'max' },
    },
    rationale:
      'A snapshot is one discovery; the newest one survives whole, so the '
      + 'tool list and the inferred type stay consistent with each other. '
      + 'Probe backoff takes the conservative values — attempt soonest, count '
      + 'highest — so a merge cannot reset a backoff.',
  },
  agent_health_snapshot: {
    rank: [{ column: 'checked_at', direction: 'desc' }],
    combine: { checked_at: { kind: 'max' }, updated_at: { kind: 'max' } },
    rationale: 'Newest health check wins whole; a health row has no state to carry forward.',
  },
  agent_storyboard_status: {
    rank: [
      { column: 'last_tested_at', direction: 'desc' },
      { column: 'updated_at', direction: 'desc' },
    ],
    combine: {
      last_tested_at: { kind: 'max' },
      last_passed_at: { kind: 'max' },
      last_failed_at: { kind: 'max' },
      updated_at: { kind: 'max' },
    },
    rationale:
      'Status, run_id, step counts and the first-failure detail all describe '
      + 'one run, so they move together from the most recently tested row — '
      + 'the merged row follows the winning run rather than splicing two.',
  },
  agent_compliance_refresh_requests: {
    rank: [{ column: 'created_at', direction: 'desc' }],
    combine: { created_at: { kind: 'min' } },
    rationale:
      'The unique index covers queued and running requests only, so a '
      + 'collision is two queued refreshes of one agent. The newer request '
      + 'survives; the older is redundant work.',
  },
  agent_grading_profiles: {
    rank: [{ column: 'updated_at', direction: 'desc' }],
    combine: { created_at: { kind: 'min' }, updated_at: { kind: 'max' } },
    rationale: 'Most recently updated selection wins; a profile selection is one decision.',
  },
  agent_grading_profile_projection_jobs: {
    rank: [{ column: 'created_at', direction: 'desc' }],
    combine: { created_at: { kind: 'min' } },
    rationale: 'A projection job is idempotent work; the newer enqueue survives.',
  },
  agent_inventory_profiles: {
    rank: [{ column: 'updated_at', direction: 'desc' }],
    combine: { updated_at: { kind: 'max' } },
    rationale: 'An inventory profile is a rebuild output; the newest rebuild wins whole.',
  },
  catalog_agent_authorizations: {
    rank: [{ column: 'updated_at', direction: 'desc' }],
    combine: {
      created_at: { kind: 'min' },
      updated_at: { kind: 'max' },
      // Union of the validity windows, and a dispute raised against either
      // spelling stays raised.
      expires_at: { kind: 'max' },
      disputed: { kind: 'anyTrue' },
    },
    rationale:
      'A collision here is two rows already identical in scope — same '
      + 'publisher or property, same evidence — so the merge is a union of '
      + 'their validity, not of their grant. Deliberately NOT unioned: '
      + 'signing_keys, collections and authorized_for come from the most '
      + 'recently updated row alone, because unioning a pinned key set or a '
      + 'collection selector would widen what the agent may do, and a '
      + 'key-spelling merge must never widen an authorization.',
  },
  adagents_authorization_overrides: {
    rank: [
      // A ban outranks every other reason: merging two overrides must not be
      // able to downgrade bad_actor to a correction that later auto-expires.
      { column: 'override_reason', direction: 'desc',
        order: ['file_broken', 'correction', 'bad_actor'] },
      { column: 'created_at', direction: 'desc' },
    ],
    combine: { created_at: { kind: 'min' } },
    rationale:
      'The strongest reason survives and the row is taken whole, so the '
      + 'expiry rules the schema enforces per reason (chk_aao_bad_actor_no_'
      + 'expiry) stay satisfied. first-seen is the earliest of the group.',
  },
  discovered_agents: {
    rank: [
      { column: 'last_validated', direction: 'desc' },
      { column: 'discovered_at', direction: 'desc' },
    ],
    combine: {
      discovered_at: { kind: 'min' },
      last_validated: { kind: 'max' },
      expires_at: { kind: 'max' },
      next_probe_after: { kind: 'min' },
      // A success against either spelling means the agent answered.
      probe_failure_count: { kind: 'min' },
    },
    rationale:
      'The most recently validated discovery wins; first-seen is the earliest '
      + 'across spellings and the expiry is the furthest out, so a merge never '
      + 'expires an agent sooner than it would have been.',
  },
};

// =============================================================================
// Unique-index discovery
// =============================================================================

export interface KeyScope {
  indexName: string;
  /** Scope columns, excluding the key column itself. May be empty. */
  columns: string[];
  /** Partial-index predicate, or null. */
  predicate: string | null;
}

/**
 * Active-set uniqueness for the two derived-key tables, whose unique indexes
 * are partial AND expression-based (COALESCE over nullable scope columns), so
 * the generic pg_index walk cannot model them. Mirrors idx_caa_unique_active
 * (migration 440) and idx_aao_unique_active (migration 432).
 */
export const DERIVED_KEY_SCOPES: Readonly<Record<string, KeyScope>> = {
  catalog_agent_authorizations: {
    indexName: 'idx_caa_unique_active',
    columns: ['property_rid', 'publisher_domain', 'evidence'],
    predicate: 'deleted_at IS NULL',
  },
  adagents_authorization_overrides: {
    indexName: 'idx_aao_unique_active',
    columns: ['host_domain', 'property_id', 'override_type'],
    predicate: 'superseded_at IS NULL',
  },
};

/**
 * Unique indexes `keyColumn` participates in, with the key column removed
 * from each scope. Throws when an index cannot be modelled — an index with an
 * expression key column would make collision detection blind to it, which is
 * the one failure this whole exercise exists to prevent.
 */
export async function keyScopesFor(
  client: PoolClient,
  table: string,
  keyColumn: string,
): Promise<KeyScope[]> {
  const explicit = DERIVED_KEY_SCOPES[table];
  if (explicit) return [explicit];
  const { rows } = await client.query<{
    index_name: string; key_columns: string[] | null; key_count: number; predicate: string | null;
  }>(`
    SELECT ic.relname AS index_name,
           i.indnkeyatts AS key_count,
           -- ::text matters: array_agg over the name type yields name[],
           -- which the pg driver hands back as the string '{agent_url}'.
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE k.ord <= i.indnkeyatts) AS key_columns,
           pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE i.indisunique AND i.indisvalid AND i.indislive AND c.relname = $1
  `, [table]);

  const scopes: KeyScope[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.key_columns) || !row.key_columns.includes(keyColumn)) continue;
    if (row.key_columns.length !== row.key_count) {
      throw new Error(
        `Unique index ${table}.${row.index_name} has an expression key column, so its `
        + 'uniqueness scope cannot be modelled and collision detection would be blind to '
        + 'it. Add it to DERIVED_KEY_SCOPES in server/src/scripts/registry-key-stores.ts.',
      );
    }
    scopes.push({
      indexName: row.index_name,
      columns: row.key_columns.filter(column => column !== keyColumn),
      predicate: row.predicate,
    });
  }
  return scopes;
}
