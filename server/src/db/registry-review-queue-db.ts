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

import type { Pool, QueryResultRow } from 'pg';
import { query } from './client.js';

export type RegistryEntityType = 'brand' | 'property';
export type RegistrySubmissionKind = 'new_record' | 'edit';
export type RegistryReviewVerdict = 'ok' | 'suspicious' | 'malicious' | 'needs_human_review';
export type RegistryReviewResolution =
  | 'approved'
  | 'rejected'
  | 'reverted'
  /** Closed without being undone — vandalism with no revision to restore. */
  | 'dismissed';

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
  claimed_at: Date | null;
  claimed_by_user_id: string | null;
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
  /**
   * Records carrying at least one such edit. Stacked edits on one
   * record are one decision, so this — not `flagged_edits` — is what
   * the queue shows a row for.
   */
  flagged_edit_records: number;
  /**
   * Decisions waiting: `pending_records + flagged_edit_records`. Equal
   * to the number of rows the queue lists, so the page's "showing N of
   * M" cannot disagree with its own list.
   */
  total: number;
  oldest_created_at: string | null;
  oldest_age_hours: number | null;
  generated_at: string;
}

/** One of the edits a collapsed flagged-edit row stands for. */
export interface CoveredEdit {
  revision_number: number | null;
  submitter_email: string | null;
  edit_summary: string | null;
  verdict: RegistryReviewVerdict | null;
  reason: string | null;
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
  /**
   * The submitted record, pretty-printed and capped, so a moderator can
   * read what they are approving. Null for a flagged edit, where the
   * record is already live and the viewer page shows it.
   */
  submitted_content: string | null;
  submitted_content_truncated: boolean;
  /** Set while another moderator is mid-action on this item. */
  claimed_at: string | null;
  claimed_by_user_id: string | null;
  /**
   * For a flagged edit: how many open edits to this record the row
   * stands for. Stacked edits are one decision, not several.
   */
  covers_edits: number;
  /**
   * Every edit the row stands for, oldest revision first.
   *
   * The collapsed row asks for one verdict over all of them, so it has
   * to show all of them: landing a benign edit first and the payload
   * second would otherwise put a harmless summary on a card whose
   * "keep" button approves both.
   */
  covered_edits: CoveredEdit[];
  /** When the submission landed — what the age column measures. */
  created_at: string;
  age_hours: number;
  /** Actions the moderator may take on this entry. */
  available_actions: Array<'approve' | 'reject' | 'revert'>;
}

/**
 * A pending row is a community submission only when somebody submitted it.
 *
 * `review_status = 'pending'` is not by itself proof of a contribution
 * waiting on review. `issueDomainClaim` creates a bare `hosted_properties`
 * row — empty `adagents.json`, a claim token, no creator and no revision —
 * for a publisher who is part-way through proving origin control. That row
 * is pending too. Approving it would publish an empty document as if it
 * were the publisher's own; rejecting it would delete an in-flight claim
 * and strand its token.
 *
 * Both real submission paths leave a submitter: `createCommunityProperty`
 * and `createDiscoveredBrand` write revision 1, and `enhanceProperty`
 * (which writes no revision) sets `created_by_user_id`. A claim row has
 * neither, and has no submitter to show in the queue either.
 *
 * The listing, the backlog count and the action guard all read this rule
 * from here — if they drift, the queue starts offering actions on rows it
 * would not list.
 */
const BRAND_HAS_SUBMITTER = `EXISTS (SELECT 1 FROM brand_revisions WHERE brand_domain = b.domain)`;
const PROPERTY_HAS_SUBMITTER = `(
  p.created_by_user_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM property_revisions WHERE publisher_domain = p.publisher_domain)
)`;

const SELECT_COLUMNS = `
  id, entity_type, domain, submission_kind, revision_number,
  submitter_user_id, submitter_email, edit_summary,
  verdict, reason, action_taken,
  created_at, updated_at,
  claimed_at, claimed_by_user_id,
  resolved_at, resolution, resolved_by_user_id, resolved_by_email, resolution_note`;

/** Caps on model- and member-authored text we persist. */
const REASON_MAX = 1_000;
const EDIT_SUMMARY_MAX = 1_000;
const ACTION_TAKEN_MAX = 500;
const NOTE_MAX = 500;
/**
 * How much of a pending record the queue renders inline. A moderator who
 * needs more than this opens the record; the cap keeps one oversized
 * manifest from dominating the page.
 */
const SUBMITTED_CONTENT_MAX = 4_000;
/**
 * How long a moderator's claim holds before another may take the item.
 * Long enough that two people don't collide on one click, short enough
 * that a crashed process does not park vandalism in the queue.
 */
const CLAIM_TTL_MS = 5 * 60_000;

function cap(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function hoursSince(value: Date | string): number {
  const ms = Date.now() - new Date(value).getTime();
  return Math.max(0, Math.round((ms / 3_600_000) * 10) / 10);
}

/** What the action endpoints need to know before touching a record. */
export interface RegistryRecordModerationState {
  exists: boolean;
  review_status: string | null;
  /** False for a bare domain-claim row — see {@link PROPERTY_HAS_SUBMITTER}. */
  has_submitter: boolean;
}

/**
 * Whether a record is one the moderation queue may act on, read through
 * the same predicate the listing uses.
 */
export async function getRegistryRecordModerationState(
  entity_type: RegistryEntityType,
  domain: string,
): Promise<RegistryRecordModerationState> {
  const sql = entity_type === 'brand'
    ? `SELECT b.review_status, ${BRAND_HAS_SUBMITTER} AS has_submitter
         FROM brands b WHERE b.domain = $1`
    : `SELECT p.review_status, ${PROPERTY_HAS_SUBMITTER} AS has_submitter
         FROM hosted_properties p WHERE p.publisher_domain = $1`;

  const result = await query<{ review_status: string | null; has_submitter: boolean }>(
    sql, [domain.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) return { exists: false, review_status: null, has_submitter: false };
  return { exists: true, review_status: row.review_status, has_submitter: row.has_submitter === true };
}

/**
 * Whether a rollback has landed on this record since `revision`.
 *
 * The automated review is asynchronous — it runs behind a Slack
 * round-trip and a model call — so an edit's queue item can be written
 * *after* a moderator has already reverted the record. Revision N's
 * snapshot is then the pre-rollback state, and "undo edit N" would put
 * back exactly what the revert removed. An item in that position has no
 * safe revert target and is stored without one.
 */
export async function rollbackLandedAfter(
  entity_type: RegistryEntityType,
  domain: string,
  revision: number,
): Promise<boolean> {
  const sql = entity_type === 'brand'
    ? `SELECT 1 FROM brand_revisions
        WHERE brand_domain = $1 AND is_rollback AND revision_number > $2 LIMIT 1`
    : `SELECT 1 FROM property_revisions
        WHERE publisher_domain = $1 AND is_rollback AND revision_number > $2 LIMIT 1`;
  const result = await query(sql, [domain.toLowerCase(), revision]);
  return (result.rowCount ?? 0) > 0;
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
  // An edit whose revision we do not know is still queued — it is
  // vandalism left live that nothing can revert automatically, so hiding
  // it is the one outcome this queue exists to prevent. It is stored with
  // a null revision and offers no revert action. A *present* revision
  // still has to name a real one.
  const revision = input.submission_kind === 'edit' && input.revision_number !== null
    && input.revision_number !== undefined
    ? Number(input.revision_number)
    : null;
  if (revision !== null && !(Number.isInteger(revision) && revision >= 1)) {
    throw new Error('revision_number must be a positive integer when present');
  }
  const revertTo = revision !== null
    && !(await rollbackLandedAfter(input.entity_type, input.domain, revision))
    ? revision
    : null;

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
      revertTo,
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

/**
 * Take an open item so one moderator at a time acts on it.
 *
 * Claiming is deliberately NOT resolving. The action — a rollback — can
 * fail, and the process running it can die between the two writes; a row
 * marked `reverted` by a revert that never ran is how live vandalism
 * gets closed as handled. A claimed item therefore stays in the queue,
 * in the backlog count and in the diagnostic until an action actually
 * completes, and a claim older than {@link CLAIM_TTL_MS} is reclaimable
 * so a lost process cannot park the item forever.
 *
 * Returns null when the item is gone, already resolved, or freshly
 * claimed by somebody else.
 */
export async function claimRegistryReviewItem(
  id: string,
  moderator: RegistryReviewModerator,
): Promise<RegistryReviewQueueItem | null> {
  const result = await query<RegistryReviewQueueItem>(
    `UPDATE registry_review_queue
        SET claimed_at = NOW(),
            claimed_by_user_id = $2,
            updated_at = NOW()
      WHERE id = $1
        AND resolved_at IS NULL
        AND (claimed_at IS NULL
             OR claimed_by_user_id = $2
             OR claimed_at < NOW() - ($3 || ' milliseconds')::interval)
      RETURNING ${SELECT_COLUMNS}`,
    [id, moderator.user_id, String(CLAIM_TTL_MS)],
  );
  return result.rows[0] ?? null;
}

/** Drop a claim after the action behind it failed. */
export async function releaseRegistryReviewItemClaim(id: string): Promise<void> {
  await query(
    `UPDATE registry_review_queue
        SET claimed_at = NULL, claimed_by_user_id = NULL, updated_at = NOW()
      WHERE id = $1 AND resolved_at IS NULL`,
    [id],
  );
}

/**
 * The open flagged edits for one record, oldest revision first.
 *
 * A revert has to be a decision about the *record*, not about one row.
 * An inconclusive verdict bans nobody and leaves the record editable, so
 * the same member can stack edits 5, 6 and 7, each getting its own open
 * item. Undoing edit 5 also undoes 6 and 7 — and a moderator who then
 * clicks "revert" on item 7 would restore the state *before* edit 7,
 * which is the vandalism from 5 and 6 put straight back.
 *
 * Items with no revision number come back too, but a rollback cannot be
 * said to have covered them — see
 * {@link resolveRevertedRegistryEditItems}.
 */
export async function listOpenRegistryEditItemsForRecord(
  entity_type: RegistryEntityType,
  domain: string,
): Promise<RegistryReviewQueueItem[]> {
  const result = await query<RegistryReviewQueueItem>(
    `SELECT ${SELECT_COLUMNS} FROM registry_review_queue
      WHERE entity_type = $1 AND domain = $2
        AND submission_kind = 'edit' AND resolved_at IS NULL
      ORDER BY revision_number ASC NULLS LAST, created_at ASC`,
    [entity_type, domain.toLowerCase()],
  );
  return result.rows;
}

/**
 * Close every open edit on a record because the moderator accepted the
 * record as it stands.
 *
 * Record-scoped for the same reason the revert is: the queue shows one
 * row per record, so "keep" is a decision about all of that record's
 * flagged edits, not about whichever one the moderator happened to
 * click.
 *
 * Unlike the revert, this honours a live claim held by somebody else,
 * and closes nothing when one exists. A revert is a fact about the
 * record — those items are decided whoever was holding them. Keeping is
 * a decision *not* to act, and it can race one that does: without this,
 * a moderator could close the rows under an in-flight rollback and
 * leave an audit trail saying the edits were kept while the record was
 * being reverted.
 *
 * Returns 0 when another moderator holds one of the record's open
 * edits; the caller should treat that as a conflict rather than as
 * "already resolved".
 */
export async function resolveOpenRegistryEditItemsForRecord(
  entity_type: RegistryEntityType,
  domain: string,
  resolution: Extract<RegistryReviewResolution, 'approved' | 'dismissed'>,
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
            resolution_note = $6,
            claimed_at = NULL,
            claimed_by_user_id = NULL
      WHERE entity_type = $1 AND domain = $2
        AND submission_kind = 'edit'
        AND resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM registry_review_queue held
           WHERE held.entity_type = $1 AND held.domain = $2
             AND held.submission_kind = 'edit'
             AND held.resolved_at IS NULL
             AND held.claimed_by_user_id IS NOT NULL
             AND held.claimed_by_user_id <> $4
             AND held.claimed_at > NOW() - ($7 || ' milliseconds')::interval
        )`,
    [
      entity_type,
      domain.toLowerCase(),
      resolution,
      moderator.user_id,
      cap(moderator.email, 255),
      cap(note, NOTE_MAX),
      String(CLAIM_TTL_MS),
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * Close every open edit on a record that a completed rollback undid.
 *
 * `belowRevision` is the revision number the rollback itself created.
 * Every edit recorded before it has had its content restored away, so
 * every open item below it is decided — including one that arrived
 * between reading the queue and the rollback committing. That is why
 * the bound comes from the rollback's own result rather than from a
 * list read beforehand: an edit that lands in that window would
 * otherwise stay open carrying a revert target that now restores the
 * vandalism.
 *
 * Items with no revision number stay open: nothing can assert what
 * state an unknown revision belongs to.
 *
 * Deliberately ignores claims. The rollback is a fact about the record,
 * so an item another moderator was holding is decided whether or not
 * they were the one who decided it.
 */
export async function resolveRevertedRegistryEditItems(
  entity_type: RegistryEntityType,
  domain: string,
  belowRevision: number,
  moderator: RegistryReviewModerator,
  note?: string | null,
): Promise<number> {
  const result = await query(
    `UPDATE registry_review_queue
        SET resolved_at = NOW(),
            updated_at = NOW(),
            resolution = 'reverted',
            resolved_by_user_id = $4,
            resolved_by_email = $5,
            resolution_note = $6,
            claimed_at = NULL,
            claimed_by_user_id = NULL
      WHERE entity_type = $1 AND domain = $2
        AND submission_kind = 'edit'
        AND resolved_at IS NULL
        AND revision_number IS NOT NULL
        AND revision_number < $3`,
    [
      entity_type,
      domain.toLowerCase(),
      belowRevision,
      moderator.user_id,
      cap(moderator.email, 255),
      cap(note, NOTE_MAX),
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * Close the open `new_record` items for a record. Used when the
 * moderator acts on the record itself (approve / reject a pending
 * record) rather than on one queue row, so the queue cannot keep showing
 * work that is already done.
 *
 * Scoped to `new_record` on purpose: a decision about whether to publish
 * a record is not a decision about a flagged edit to it, and marking one
 * `approved` against a moderator who never saw it would be a false audit
 * trail. The two cannot coexist today — a pending record is locked
 * against edits — but the scope should not depend on that staying true.
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
      WHERE entity_type = $1 AND domain = $2
        AND submission_kind = 'new_record' AND resolved_at IS NULL`,
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
  submitted_content: unknown;
  claimed_at: Date | null;
  claimed_by_user_id: string | null;
  covers_edits: number | null;
  covered_edits: unknown;
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
      q.action_taken AS action_taken,
      q.claimed_at AS claimed_at,
      q.claimed_by_user_id AS claimed_by_user_id,
      1 AS covers_edits,
      NULL::jsonb AS covered_edits,
      -- A pending record IS the submission, so read the content from the
      -- row rather than from revision 1: enhanceProperty writes no
      -- revision, and a property revision snapshot carries the row's
      -- claim and verification tokens.
      jsonb_strip_nulls(jsonb_build_object(
        'brand_name', b.brand_name,
        'brand_names', b.brand_names,
        'house_domain', b.house_domain,
        'keller_type', b.keller_type,
        'parent_brand', b.parent_brand,
        'brand_agent_url', b.brand_agent_url,
        'brand_manifest', b.brand_manifest
      )) AS submitted_content
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
      SELECT id, verdict, reason, action_taken, claimed_at, claimed_by_user_id
      FROM registry_review_queue
      WHERE entity_type = 'brand' AND domain = b.domain
        AND submission_kind = 'new_record' AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) q ON TRUE
    WHERE b.review_status = 'pending' AND ${BRAND_HAS_SUBMITTER}

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
      q.action_taken AS action_taken,
      q.claimed_at AS claimed_at,
      q.claimed_by_user_id AS claimed_by_user_id,
      1 AS covers_edits,
      NULL::jsonb AS covered_edits,
      p.adagents_json AS submitted_content
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
      SELECT id, verdict, reason, action_taken, claimed_at, claimed_by_user_id
      FROM registry_review_queue
      WHERE entity_type = 'property' AND domain = p.publisher_domain
        AND submission_kind = 'new_record' AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) q ON TRUE
    WHERE p.review_status = 'pending' AND ${PROPERTY_HAS_SUBMITTER}

    UNION ALL

    -- One row per record, not per edit. Nothing bans or locks the editor
    -- after an inconclusive verdict, so one member can leave edits 5, 6
    -- and 7 all flagged — and those are not separable decisions:
    -- restoring revision 5 undoes 6 and 7 as well. Three rows with
    -- their own buttons would invite a moderator to keep one and then
    -- revert another, silently discarding the edit they just kept. The
    -- row carries the earliest open revision, which is what a revert
    -- restores, and a count of what it stands for.
    SELECT * FROM (
      SELECT DISTINCT ON (e.entity_type, e.domain)
      'flagged_edit'::text AS kind,
      e.entity_type AS entity_type,
      e.domain AS domain,
      NULL::text AS record_name,
      NULL::text AS source_type,
      MIN(e.created_at) OVER (PARTITION BY e.entity_type, e.domain) AS created_at,
      e.submitter_user_id AS submitter_user_id,
      e.submitter_email AS submitter_email,
      e.edit_summary AS edit_summary,
      e.revision_number AS revision_number,
      NULL::int AS revision_count,
      e.id AS review_item_id,
      e.verdict AS verdict,
      e.reason AS reason,
      e.action_taken AS action_taken,
      e.claimed_at AS claimed_at,
      e.claimed_by_user_id AS claimed_by_user_id,
      COUNT(*) OVER (PARTITION BY e.entity_type, e.domain)::int AS covers_edits,
      -- One verdict covers them all, so the card has to carry them all.
      jsonb_agg(jsonb_build_object(
        'revision_number', e.revision_number,
        'submitter_email', e.submitter_email,
        'edit_summary', e.edit_summary,
        'verdict', e.verdict,
        'reason', e.reason
      )) OVER (
        PARTITION BY e.entity_type, e.domain
        ORDER BY e.revision_number ASC NULLS LAST, e.created_at ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      ) AS covered_edits,
      NULL::jsonb AS submitted_content
      FROM registry_review_queue e
      WHERE e.resolved_at IS NULL AND e.submission_kind = 'edit'
      ORDER BY e.entity_type, e.domain, e.revision_number ASC NULLS LAST, e.created_at ASC
    ) collapsed_edits
  ) queue
  ORDER BY created_at ASC, kind ASC, entity_type ASC, domain ASC
  LIMIT $1 OFFSET $2`;

/** How many covered edits a single card renders before it says so. */
const MAX_COVERED_EDITS = 25;

/** Normalise and bound the edits a collapsed row stands for. */
function renderCoveredEdits(value: unknown): CoveredEdit[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COVERED_EDITS).map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const revision = Number(row.revision_number);
    return {
      revision_number: Number.isInteger(revision) ? revision : null,
      submitter_email: cap(row.submitter_email as string | null, 255),
      edit_summary: cap(row.edit_summary as string | null, EDIT_SUMMARY_MAX),
      verdict: (row.verdict as RegistryReviewVerdict | null) ?? null,
      reason: cap(row.reason as string | null, REASON_MAX),
    };
  });
}

/** Pretty-print the submitted record for the queue, capped. */
function renderSubmittedContent(value: unknown): {
  submitted_content: string | null;
  submitted_content_truncated: boolean;
} {
  if (value === null || value === undefined) {
    return { submitted_content: null, submitted_content_truncated: false };
  }
  let rendered: string;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return { submitted_content: null, submitted_content_truncated: false };
  }
  if (!rendered || /^\{\s*\}$/.test(rendered)) {
    return { submitted_content: null, submitted_content_truncated: false };
  }
  return rendered.length > SUBMITTED_CONTENT_MAX
    ? { submitted_content: rendered.slice(0, SUBMITTED_CONTENT_MAX), submitted_content_truncated: true }
    : { submitted_content: rendered, submitted_content_truncated: false };
}

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
    ...renderSubmittedContent(row.submitted_content),
    claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    claimed_by_user_id: row.claimed_by_user_id,
    covers_edits: Number(row.covers_edits ?? 1),
    covered_edits: renderCoveredEdits(row.covered_edits),
    // The queue's age column measures how long the member has waited.
    // For a pending record that is the row's own `created_at`, which is
    // the same instant it entered review: community records are born
    // pending and are locked against edits until a decision is made.
    created_at: new Date(row.created_at).toISOString(),
    age_hours: hoursSince(row.created_at),
    // A pending record is published or deleted. A live edit is kept as
    // submitted, or rolled back to the revision the reviewer saw
    // (adcp#8337) — which needs a revision to exist.
    available_actions: row.kind === 'pending_record'
      ? ['approve', 'reject']
      : (Number(row.revision_number) >= 1 ? ['approve', 'revert'] : ['approve']),
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
  flagged_edit_records: string | number;
  oldest_created_at: Date | null;
}

/**
 * Count and oldest age of everything waiting on a moderator. This is the
 * signal an outage-driven backlog shows up in — the digest job and the
 * operational-diagnostics invariant both read it.
 */
export async function getRegistryReviewBacklog(pool?: Pool): Promise<RegistryReviewBacklog> {
  // The integrity diagnostic runs with the pool its framework hands it;
  // everything else uses the shared client. Same SQL either way, so the
  // admin page, the digest and the diagnostic cannot disagree about what
  // is waiting.
  const run = <T extends QueryResultRow>(sql: string) =>
    (pool ? pool.query<T>(sql) : query<T>(sql));

  const result = await run<BacklogRow>(`
    WITH waiting AS (
      SELECT 'brand'::text AS kind, b.created_at FROM brands b
        WHERE b.review_status = 'pending' AND ${BRAND_HAS_SUBMITTER}
      UNION ALL
      SELECT 'property'::text AS kind, p.created_at FROM hosted_properties p
        WHERE p.review_status = 'pending' AND ${PROPERTY_HAS_SUBMITTER}
      UNION ALL
      SELECT 'edit'::text AS kind, created_at FROM registry_review_queue
        WHERE resolved_at IS NULL AND submission_kind = 'edit'
    ),
    -- Stacked edits on one record are one decision and one queue row.
    flagged_records AS (
      SELECT COUNT(DISTINCT (entity_type, domain)) AS n
      FROM registry_review_queue
      WHERE resolved_at IS NULL AND submission_kind = 'edit'
    )
    SELECT
      COUNT(*) FILTER (WHERE kind = 'brand')    AS pending_brands,
      COUNT(*) FILTER (WHERE kind = 'property') AS pending_properties,
      COUNT(*) FILTER (WHERE kind = 'edit')     AS flagged_edits,
      (SELECT n FROM flagged_records)           AS flagged_edit_records,
      MIN(created_at)                           AS oldest_created_at
    FROM waiting`);

  const row = result.rows[0];
  const pendingBrands = Number(row?.pending_brands ?? 0);
  const pendingProperties = Number(row?.pending_properties ?? 0);
  const flaggedEdits = Number(row?.flagged_edits ?? 0);
  const flaggedEditRecords = Number(row?.flagged_edit_records ?? 0);
  const oldest = row?.oldest_created_at ?? null;

  return {
    pending_brands: pendingBrands,
    pending_properties: pendingProperties,
    pending_records: pendingBrands + pendingProperties,
    flagged_edits: flaggedEdits,
    flagged_edit_records: flaggedEditRecords,
    total: pendingBrands + pendingProperties + flaggedEditRecords,
    oldest_created_at: oldest ? new Date(oldest).toISOString() : null,
    oldest_age_hours: oldest ? hoursSince(oldest) : null,
    generated_at: new Date().toISOString(),
  };
}
