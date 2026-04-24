/**
 * Escalation triage job.
 *
 * Scans open escalations older than a minimum age, runs a rule-based
 * classifier over each, and writes a suggestion row for admin review.
 * The runner never resolves escalations directly — it only proposes.
 *
 * MVP is intentionally rule-based: URL probe + referenced-escalation
 * chase + age/bucket heuristic. An LLM pass can layer on later.
 */

import { createLogger } from '../../logger.js';
import {
  getEscalation,
  listEscalations,
  type Escalation,
} from '../../db/escalation-db.js';
import {
  insertSuggestionIfNew,
  getPendingSuggestionForEscalation,
  type TriageSuggestionInput,
} from '../../db/escalation-triage-db.js';
import {
  ageInDays,
  bucketForSummary,
  extractAaoUrls,
  extractReferencedEscalationIds,
  probeUrlStatus,
} from './escalation-triage-signals.js';

const logger = createLogger('escalation-triage');

export interface TriageJobOptions {
  /** Only consider escalations at least this many days old. */
  minAgeDays?: number;
  /** Max escalations to classify per run. */
  limit?: number;
  /** Age (days) at which ops tickets are considered stale enough to auto-suggest close. */
  staleOpsDays?: number;
}

export interface TriageJobResult {
  scanned: number;
  suggested: number;
  skipped_pending: number;
  skipped_no_signal: number;
  errors: number;
}

type ClassificationVerdict = Omit<TriageSuggestionInput, 'escalation_id'> | null;

/**
 * Decide a verdict for one escalation. Pure-ish — pulls related
 * escalation status via getEscalation but does not mutate anything.
 */
export async function classifyEscalation(
  escalation: Escalation,
  staleOpsDays: number,
): Promise<ClassificationVerdict> {
  const summary = escalation.summary ?? '';
  const bucket = bucketForSummary(summary);
  const age = ageInDays(escalation.created_at);
  const evidence: string[] = [`age=${age}d`, `bucket=${bucket}`];

  // Rule 1 — cancellation / follow-up chains.
  // "Cancel escalation #N" with N resolved → suggest resolve.
  const refs = extractReferencedEscalationIds(summary);
  if (refs.length > 0 && /^(?:cancel|follow.?up)/i.test(summary.trim())) {
    for (const ref of refs) {
      if (ref === escalation.id) continue;
      const refEsc = await getEscalation(ref);
      if (refEsc && (refEsc.status === 'resolved' || refEsc.status === 'wont_do')) {
        return {
          suggested_status: 'resolved',
          confidence: 'high',
          bucket,
          reasoning: `References escalation #${ref}, which is ${refEsc.status}.`,
          evidence: [...evidence, `ref=#${ref} status=${refEsc.status}`],
        };
      }
    }
  }

  // Rule 2 — URL probe for bug-shaped escalations.
  // If the summary cites an AAO URL, hit it. 404/410 → still broken, keep open.
  // 200/301/302 → likely fixed, suggest resolve with MEDIUM confidence.
  const urls = extractAaoUrls(summary);
  if (urls.length > 0) {
    const probes: { url: string; status: number | null }[] = [];
    for (const url of urls.slice(0, 3)) {
      probes.push({ url, status: await probeUrlStatus(url) });
    }
    const probeEvidence = probes.map(p => `probe ${p.url} → ${p.status ?? 'err'}`);

    if (probes.some(p => p.status === 404 || p.status === 410)) {
      return null; // still broken; keep open
    }
    const allGood = probes.every(p => p.status != null && p.status >= 200 && p.status < 400);
    if (allGood && bucket === 'bug') {
      return {
        suggested_status: 'resolved',
        confidence: 'medium',
        bucket,
        reasoning: 'Referenced URL(s) now respond successfully; the outwardly-visible bug no longer repros.',
        evidence: [...evidence, ...probeEvidence],
      };
    }
  }

  // Rule 3 — stale ops backlog. Conservative: only non-bug buckets where
  // same-day ops work has likely been actioned externally.
  const isOpsBucket = bucket === 'billing' || bucket === 'invite' || bucket === 'content' || bucket === 'ops-other';
  if (age >= staleOpsDays && isOpsBucket && escalation.category === 'needs_human_action') {
    return {
      suggested_status: 'resolved',
      confidence: 'low',
      bucket,
      reasoning: `Stale ${bucket} request (${age}d) — same-day ops task, likely actioned externally without a queue update.`,
      evidence,
    };
  }

  return null;
}

export async function runEscalationTriageJob(
  options: TriageJobOptions = {},
): Promise<TriageJobResult> {
  const result: TriageJobResult = {
    scanned: 0,
    suggested: 0,
    skipped_pending: 0,
    skipped_no_signal: 0,
    errors: 0,
  };

  const minAgeDays = options.minAgeDays ?? 7;
  const limit = options.limit ?? 25;
  const staleOpsDays = options.staleOpsDays ?? 21;

  let open: Escalation[];
  try {
    open = await listEscalations({ status: 'open', limit: 200 });
  } catch (err) {
    logger.error({ err }, 'Failed to list open escalations');
    result.errors++;
    return result;
  }

  const candidates = open.filter(e => ageInDays(e.created_at) >= minAgeDays).slice(0, limit);

  for (const escalation of candidates) {
    result.scanned++;
    try {
      const existing = await getPendingSuggestionForEscalation(escalation.id);
      if (existing) {
        result.skipped_pending++;
        continue;
      }

      const verdict = await classifyEscalation(escalation, staleOpsDays);
      if (!verdict) {
        result.skipped_no_signal++;
        continue;
      }

      const inserted = await insertSuggestionIfNew({
        escalation_id: escalation.id,
        ...verdict,
      });
      if (inserted) result.suggested++;
    } catch (err) {
      logger.error({ err, escalationId: escalation.id }, 'Triage classification failed');
      result.errors++;
    }
  }

  return result;
}
