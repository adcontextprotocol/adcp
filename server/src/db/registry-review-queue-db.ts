/**
 * Read/write model for the registry moderation queue (adcp#8338).
 *
 * Two kinds of work sit in this queue, and they have different sources of
 * truth on purpose:
 *
 *  - **Pending records.** `brands.review_status = 'pending'` /
 *    `hosted_properties.review_status = 'pending'` is authoritative. The
 *    record is invisible to the registry until a moderator approves it, and
 *    it is locked against further member edits. `registry_review_queue`
 *    only supplies the verdict, reason and action for the row; a record
 *    that went pending with no review row at all (the review never ran)
 *    still appears in the queue.
 *  - **Flagged edits.** The edit is already live, so there is no column to
 *    read — the open `registry_review_queue` row *is* the outstanding
 *    decision, and its `revision_number` is the revision that restores the
 *    pre-edit state (adcp#8337).
 *
 * Everything in `reason`, `edit_summary`, `record_name` and `action_taken`
 * is submitter- or model-authored. Callers render it; this module never
 * escapes it, because the right escaping depends on the surface.
 */

import { query } from './client.js';

export type RegistryEntityType = 'brand' | 'property';
export type RegistrySubmissionKind = 'new_record' | 'edit';
export type RegistryReviewVerdict = 'ok' | 'suspicious' | 'malicious' | 'needs_human_review';
export type RegistryReviewResolution = 'approved' | 'rejected' | 'reverted';

/** A row of `registry_review_queue`. */
export interface RegistryReviewQueueItem {
  id: string;
  entity_type: RegistryEntityType;
  domain: string;
  submission_kind: RegistrySubmissionKind;
  revision_number: number | null;
  submitter_user_id: string;
  submitter_email: string | null;
  edit_summary: string | null;
  verdict: RegistryReviewVerdict;
  reason: string | null;
  action_taken: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  resolution: RegistryReviewResolution | null;
  resolved_by_user_id: string | null;
  resolved_by_email: string | null;
  resolution_note: string | null;
}

export interface RecordRegistryReviewOutcomeInput {
  entity_type: RegistryEntityType;
  domain: string;
  submission_kind: RegistrySubmissionKind;
  /** Required for `edit`: the revision that restores the pre-edit state. */
  revision_number?: number | null;
  submitter_user_id: string;
  submitter_email?: string | null;
  edit_summary?: string | null;
  verdict: RegistryReviewVerdict;
  reason?: string | null;
  action_taken?: string | null;
}

/** Moderator identity recorded against every resolution. */
export interface RegistryReviewModerator {
  user_id: string;
  email?: string | null;
}

/** The backlog signal: how much is waiting, and how long the oldest has waited. */
export interface RegistryReviewBacklog {
  pending_brands: number;
  pending_properties: number;
  /** Pending records of either entity type. */
  pending_records: number;
  /** Live edits an inconclusive review left for a human. */
  flagged_edits: number;
  /** `pending_records + flagged_edits`. */
  total: number;
  oldest_created_at: string | null;
  oldest_age_hours: number | null;
  generated_at: string;
}

/** A row of the moderator-facing queue. */
export interface RegistryReviewQueueEntry {
  kind: 'pending_record' | 'flagged_edit';
  entity_type: RegistryEntityType;
  domain: string;
  /** Brand name / publisher domain. Member-supplied for community records. */
  record_name: string | null;
  source_type: string | null;
  /**
   * For a flagged edit: the revision a revert restores (adcp#8337).
   * For a pending record: the record's latest revision number.
   */
  revision_number: number | null;
  revision_count: number | null;
  submitter_user_id: string | null;
  submitter_email: string | null;
  edit_summary: string | null;
  verdict: RegistryReviewVerdict | null;
  reason: string | null;
  action_taken: string | null;
  /** Null when the record went pending without any recorded review. */
  review_item_id: string | null;
  /** When the submission landed — what the age column measures. */
  created_at: string;
  age_hours: number;
  /** Actions the moderator may take on this entry. */
  available_actions: Array<'approve' | 'reject' | 'revert'>;
}

const SELECT_COLUMNS = `
  id, entity_type, domain, submission_kind, revision_number,
  submitter_user_id, submitter_email, edit_summary,
  verdict, reason, action_taken,
  created_at, updated_at,
  resolved_at, resolution, resolved_by_user_id, resolved_by_email, resolution_note`;

/** Caps on model- and member-authored text we persist. */
const REASON_MAX = 1_000;
const EDIT_SUMMARY_MAX = 1_000;
const ACTION_TAKEN_MAX = 500;
const NOTE_MAX = 500;

function cap(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function hoursSince(value: Date | string): number {
  const ms = Date.now() - new Date(value).getTime();
  return Math.max(0, Math.round((ms / 3_600_000) * 10) / 10);
}

/**
 * Record that a submission needs a human, or refresh the row if one is
 * already open for it.
 *
 * `created_at` is deliberately preserved on conflict: the queue's age
 * column measures how long the *member* has waited, and a re-review must
 * not reset that clock.
 */
export async function recordRegistryReviewOutcome(
  input: RecordRegistryReviewOutcomeInput,
): Promise<RegistryReviewQueueItem> {
  if (input.submission_kind === 'edit' && !(Number(input.revision_number) >= 1)) {
    throw new Error('revision_number >= 1 is required for an edit review item');
  }

  const result = await query<RegistryReviewQueueItem>(
    `INSERT INTO registry_review_queue (
       entity_type, domain, submission_kind, revision_number,
       submitter_user_id, submitter_email, edit_summary,
       verdict, reason, action_taken
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (entity_type, domain, submission_kind, COALESCE(revision_number, 0))
       WHERE resolved_at IS NULL
     DO UPDATE SET
       submitter_user_id = EXCLUDED.submitter_user_id,
       submitter_email = EXCLUDED.submitter_email,
       edit_summary = EXCLUDED.edit_summary,
       verdict = EXCLUDED.verdict,
       reason = EXCLUDED.reason,
       action_taken = EXCLUDED.action_taken,
       updated_at = NOW()
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.entity_type,
      input.domain.toLowerCase(),
      input.submission_kind,
      input.submission_kind === 'edit' ? Number(input.revision_number) : null,
      input.submitter_user_id,
      cap(input.submitter_email, 255),
      cap(input.edit_summary, EDIT_SUMMARY_MAX),
      input.verdict,
      cap(input.reason, REASON_MAX),
      cap(input.action_taken, ACTION_TAKEN_MAX),
    ],
  );
  return result.rows[0];
}

/** One open item by id. Returns null when it is missing or already resolved. */
export async function getOpenRegistryReviewItem(id: string): Promise<RegistryReviewQueueItem | null> {
  const result = await query<RegistryReviewQueueItem>(
    `SELECT ${SELECT_COLUMNS} FROM registry_review_queue WHERE id = $1 AND resolved_at IS NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Claim an open item for a moderator.
 *
 * The `resolved_at IS NULL` guard is the concurrency control: two
 * moderators clicking the same row race here rather than both running the
 * underlying revert, and the loser gets null.
 */
export async function resolveRegistryReviewItem(
  id: string,
  resolution: RegistryReviewResolution,
  moderator: RegistryReviewModerator,
  note?: string | null,
): Promise<RegistryReviewQueueItem | null> {
  const result = await query<RegistryReviewQueueItem>(
    `UPDATE registry_review_queue
        SET resolved_at = NOW(),
            updated_at = NOW(),
            resolution = $2,
            resolved_by_user_id = $3,
            resolved_by_email = $4,
            resolution_note = $5
      WHERE id = $1 AND resolved_at IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [id, resolution, moderator.user_id, cap(moderator.email, 255), cap(note, NOTE_MAX)],
  );
  return result.rows[0] ?? null;
}

/**
 * Hand a claimed item back to the queue.
 *
 * Moderator actions claim the row first so two moderators clicking the
 * same revert race in Postgres rather than both rolling the record back.
 * When the action itself then fails, the claim has to come off — a row
 * marked resolved by an action that never happened is how live vandalism
 * gets closed as handled.
 */
export async function reopenRegistryReviewItem(id: string): Promise<void> {
  await query(
    `UPDATE registry_review_queue
        SET resolved_at = NULL,
            resolution = NULL,
            resolved_by_user_id = NULL,
            resolved_by_email = NULL,
            resolution_note = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [id],
  );
}

/**
 * Close every open item for a record. Used when the moderator acts on the
 * record itself (approve / reject a pending record) rather than on one
 * queue row, so the queue cannot keep showing work that is already done.
 */
export async function resolveOpenRegistryReviewItemsForRecord(
  entity_type: RegistryEntityType,
  domain: string,
  resolution: RegistryReviewResolution,
  moderator: RegistryReviewModerator,
  note?: string | null,
): Promise<number> {
  const result = await query(
    `UPDATE registry_review_queue
        SET resolved_at = NOW(),
            updated_at = NOW(),
            resolution = $3,
            resolved_by_user_id = $4,
            resolved_by_email = $5,
            resolution_note = $6
      WHERE entity_type = $1 AND domain = $2 AND resolved_at IS NULL`,
    [
      entity_type,
      domain.toLowerCase(),
      resolution,
      moderator.user_id,
      cap(moderator.email, 255),
      cap(note, NOTE_MAX),
    ],
  );
  return result.rowCount ?? 0;
}

interface QueueRow {
  kind: 'pending_record' | 'flagged_edit';
  entity_type: RegistryEntityType;
  domain: string;
  record_name: string | null;
  source_type: string | null;
  created_at: Date;
  submitter_user_id: string | null;
  submitter_email: string | null;
  edit_summary: string | null;
  revision_number: number | null;
  revision_count: number | null;
  review_item_id: string | null;
  verdict: RegistryReviewVerdict | null;
  reason: string | null;
  action_taken: string | null;
}

/**
 * The moderator queue in one pass, so ordering and pagination hold across
 * the three sources rather than being merged client-side.
 *
 * The two pending-record branches read `review_status`, which is
 * authoritative: a record that went pending with no recorded review still
 * appears, with a null verdict. The third branch is the flagged live edits,
 * where the open queue row *is* the outstanding decision.
 */
const QUEUE_SQL = `
  SELECT * FROM (
    SELECT
      'pending_record'::text AS kind,
      'brand'::text AS entity_type,
      b.domain AS domain,
      b.brand_name AS record_name,
      b.source_type AS source_type,
      b.created_at AS created_at,
      rev.editor_user_id AS submitter_user_id,
      rev.editor_email AS submitter_email,
      rev.edit_summary AS edit_summary,
      stats.latest_revision AS revision_number,
      stats.revision_count AS revision_count,
      q.id AS review_item_id,
      q.verdict AS verdict,
      q.reason AS reason,
      q.action_taken AS action_taken
    FROM brands b
    LEFT JOIN LATERAL (
      SELECT editor_user_id, editor_email, edit_summary
      FROM brand_revisions
      WHERE brand_domain = b.domain
      ORDER BY revision_number ASC
      LIMIT 1
    ) rev ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS revision_count, MAX(revision_number)::int AS latest_revision
      FROM brand_revisions
      WHERE brand_domain = b.domain
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, verdict, reason, action_taken
      FROM registry_review_queue
      WHERE entity_type = 'brand' AND domain = b.domain
        AND submission_kind = 'new_record' AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) q ON TRUE
    WHERE b.review_status = 'pending'

    UNION ALL

    SELECT
      'pending_record'::text AS kind,
      'property'::text AS entity_type,
      p.publisher_domain AS domain,
      p.publisher_domain AS record_name,
      p.source_type AS source_type,
      p.created_at AS created_at,
      COALESCE(rev.editor_user_id, p.created_by_user_id) AS submitter_user_id,
      COALESCE(rev.editor_email, p.created_by_email) AS submitter_email,
      rev.edit_summary AS edit_summary,
      stats.latest_revision AS revision_number,
      stats.revision_count AS revision_count,
      q.id AS review_item_id,
      q.verdict AS verdict,
      q.reason AS reason,
      q.action_taken AS action_taken
    FROM hosted_properties p
    LEFT JOIN LATERAL (
      SELECT editor_user_id, editor_email, edit_summary
      FROM property_revisions
      WHERE publisher_domain = p.publisher_domain
      ORDER BY revision_number ASC
      LIMIT 1
    ) rev ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS revision_count, MAX(revision_number)::int AS latest_revision
      FROM property_revisions
      WHERE publisher_domain = p.publisher_domain
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, verdict, reason, action_taken
      FROM registry_review_queue
      WHERE entity_type = 'property' AND domain = p.publisher_domain
        AND submission_kind = 'new_record' AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) q ON TRUE
    WHERE p.review_status = 'pending'

    UNION ALL

    SELECT
      'flagged_edit'::text AS kind,
      e.entity_type AS entity_type,
      e.domain AS domain,
      NULL::text AS record_name,
      NULL::text AS source_type,
      e.created_at AS created_at,
      e.submitter_user_id AS submitter_user_id,
      e.submitter_email AS submitter_email,
      e.edit_summary AS edit_summary,
      e.revision_number AS revision_number,
      NULL::int AS revision_count,
      e.id AS review_item_id,
      e.verdict AS verdict,
      e.reason AS reason,
      e.action_taken AS action_taken
    FROM registry_review_queue e
    WHERE e.resolved_at IS NULL AND e.submission_kind = 'edit'
  ) queue
  ORDER BY created_at ASC, domain ASC
  LIMIT $1 OFFSET $2`;

function toQueueEntry(row: QueueRow): RegistryReviewQueueEntry {
  return {
    kind: row.kind,
    entity_type: row.entity_type,
    domain: row.domain,
    record_name: row.record_name,
    source_type: row.source_type,
    revision_number: row.revision_number,
    revision_count: row.revision_count,
    submitter_user_id: row.submitter_user_id,
    submitter_email: row.submitter_email,
    edit_summary: row.edit_summary,
    verdict: row.verdict,
    reason: row.reason,
    action_taken: row.action_taken,
    review_item_id: row.review_item_id,
    created_at: new Date(row.created_at).toISOString(),
    age_hours: hoursSince(row.created_at),
    // A pending record is published or deleted; a live edit is accepted
    // as-is or rolled back to the revision the reviewer saw (adcp#8337).
    available_actions: row.kind === 'pending_record' ? ['approve', 'reject'] : ['approve', 'revert'],
  };
}

/**
 * The moderator queue: pending records plus live edits an inconclusive
 * review left for a human, oldest first.
 */
export async function listRegistryReviewQueue(options?: {
  limit?: number;
  offset?: number;
}): Promise<RegistryReviewQueueEntry[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const offset = Math.max(options?.offset ?? 0, 0);
  const result = await query<QueueRow>(QUEUE_SQL, [limit, offset]);
  return result.rows.map(toQueueEntry);
}

interface BacklogRow {
  pending_brands: string | number;
  pending_properties: string | number;
  flagged_edits: string | number;
  oldest_created_at: Date | null;
}

/**
 * Count and oldest age of everything waiting on a moderator. This is the
 * signal an outage-driven backlog shows up in — the digest job and the
 * operational-diagnostics invariant both read it.
 */
export async function getRegistryReviewBacklog(): Promise<RegistryReviewBacklog> {
  const result = await query<BacklogRow>(`
    WITH waiting AS (
      SELECT 'brand'::text AS kind, created_at FROM brands WHERE review_status = 'pending'
      UNION ALL
      SELECT 'property'::text AS kind, created_at FROM hosted_properties WHERE review_status = 'pending'
      UNION ALL
      SELECT 'edit'::text AS kind, created_at FROM registry_review_queue
        WHERE resolved_at IS NULL AND submission_kind = 'edit'
    )
    SELECT
      COUNT(*) FILTER (WHERE kind = 'brand')    AS pending_brands,
      COUNT(*) FILTER (WHERE kind = 'property') AS pending_properties,
      COUNT(*) FILTER (WHERE kind = 'edit')     AS flagged_edits,
      MIN(created_at)                           AS oldest_created_at
    FROM waiting`);

  const row = result.rows[0];
  const pendingBrands = Number(row?.pending_brands ?? 0);
  const pendingProperties = Number(row?.pending_properties ?? 0);
  const flaggedEdits = Number(row?.flagged_edits ?? 0);
  const oldest = row?.oldest_created_at ?? null;

  return {
    pending_brands: pendingBrands,
    pending_properties: pendingProperties,
    pending_records: pendingBrands + pendingProperties,
    flagged_edits: flaggedEdits,
    total: pendingBrands + pendingProperties + flaggedEdits,
    oldest_created_at: oldest ? new Date(oldest).toISOString() : null,
    oldest_age_hours: oldest ? hoursSince(oldest) : null,
    generated_at: new Date().toISOString(),
  };
}
