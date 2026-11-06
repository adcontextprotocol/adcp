/**
 * The hold ledger: per-caller state for experimental 3.3 holds, kept in the
 * caller's compact proposal session (every account the caller acts for shares
 * it, so two buyers on one sandbox token queue on the same inventory).
 *
 * - `drafts`: the binding `hold_policy` of each draft served to a 3.3 caller,
 *   fixed when the draft was first returned (drafts are immutable).
 * - `holds`: one record per committed proposal the ledger tracks: its policy,
 *   `hold_placed_at`, `expires_at`, the slots it contends for, its queue
 *   position (`seq`), and the snapshot positions it reported. An extension
 *   supersedes the source's record and transfers the hold, with its queue
 *   position, to the successor's.
 * - `forced`: `force_hold_unavailable` directives waiting for a finalize.
 *
 * Lists, not maps keyed by proposal ID, so no caller-supplied ID becomes a
 * property name. As with account-sandbox.ts, every holder of the shared
 * public sandbox token is one caller; do not copy that keying into a
 * production seller.
 */

import type { SessionState } from '../types.js';
import type { HoldPolicy } from './policy.js';

export const HOLDS_DOC_KEY = 'holds\u001fledger';
const MAX_DRAFTS = 1000;
const MAX_HOLDS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstallmentHoldEntry {
  product_id: string;
  installment_ref: { collection_ref: { publisher_domain: string; collection_id: string }; installment_id: string };
  hold_rank?: number;
}

export interface HoldRecord {
  /** The committed proposal that carries the hold now. */
  proposal_id: string;
  /** The draft whose finalize placed the hold. */
  draft_id: string;
  owner_account_id?: string;
  policy: HoldPolicy;
  /** Absent for a terms-only commitment, which holds nothing. */
  placed_at?: string;
  expires_at: string;
  /** Queue position: lower places first. Kept across extensions. */
  seq: number;
  /** Contended slots: `p:<product_id>` or `i:<product_id>#<collection>/<installment>`. */
  slots: string[];
  rank?: number;
  holds?: InstallmentHoldEntry[];
  /**
   * live: unexpired and unaccepted. accepted: booked by accept_proposal; it
   * stays ahead of later holds until the hold would have lapsed, then frees
   * the slot so a shared sandbox never runs out of fixture inventory.
   * released: declined. superseded: transferred to an extension successor.
   */
  state: 'live' | 'accepted' | 'released' | 'superseded';
  superseded_by?: string;
}

export interface ForcedHoldUnavailable {
  proposal_id: string;
}

export interface HoldDocument extends Record<string, unknown> {
  next_seq: number;
  drafts: Array<{ proposal_id: string; policy: HoldPolicy }>;
  holds: HoldRecord[];
  forced: ForcedHoldUnavailable[];
}

export function loadHoldDocument(session: SessionState): HoldDocument {
  const stored = session.principalConfigurations.get(HOLDS_DOC_KEY) as Partial<HoldDocument> | undefined;
  return {
    next_seq: typeof stored?.next_seq === 'number' ? stored.next_seq : 1,
    drafts: Array.isArray(stored?.drafts) ? structuredClone(stored.drafts) : [],
    holds: Array.isArray(stored?.holds) ? structuredClone(stored.holds) : [],
    forced: Array.isArray(stored?.forced) ? structuredClone(stored.forced) : [],
  };
}

export function saveHoldDocument(session: SessionState, doc: HoldDocument, nowMs: number): void {
  // Records that can no longer affect a position, an acceptance, or a read
  // are pruned a week after they lapse; the lists stay bounded.
  const holds = doc.holds.filter(record => (
    record.state === 'superseded'
      ? Date.parse(record.expires_at) > nowMs - 7 * DAY_MS
      : record.state === 'live' || Date.parse(record.expires_at) > nowMs - 7 * DAY_MS
  ));
  session.principalConfigurations.set(HOLDS_DOC_KEY, structuredClone({
    next_seq: doc.next_seq,
    drafts: doc.drafts.slice(-MAX_DRAFTS),
    holds: holds.slice(-MAX_HOLDS),
    forced: doc.forced.slice(-MAX_DRAFTS),
  }));
}

export function draftPolicyRecord(doc: HoldDocument, proposalId: string): HoldPolicy | undefined {
  return doc.drafts.find(entry => entry.proposal_id === proposalId)?.policy;
}

/** The record for the committed proposal, in any state. */
export function holdRecord(doc: HoldDocument, proposalId: string): HoldRecord | undefined {
  return doc.holds.find(record => record.proposal_id === proposalId);
}

/** Whether a record still stands on its slots at `nowMs`. */
export function occupiesSlots(record: HoldRecord, nowMs: number): boolean {
  return record.placed_at !== undefined
    && (record.state === 'live' || record.state === 'accepted')
    && Date.parse(record.expires_at) > nowMs;
}

/** 1 + the holds ahead of queue position `seq` on `slot`. Only the count is
 * ever disclosed. */
export function positionOn(doc: HoldDocument, slot: string, seq: number, nowMs: number): number {
  return 1 + doc.holds.filter(record => (
    record.seq < seq && record.slots.includes(slot) && occupiesSlots(record, nowMs)
  )).length;
}
