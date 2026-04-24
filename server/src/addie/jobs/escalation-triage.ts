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
import { query } from '../../db/client.js';
import {
  getEscalation,
  type Escalation,
} from '../../db/escalation-db.js';
import {
  insertSuggestionIfNew,
  getPendingSuggestionForEscalation,
  type ProposedGithubIssue,
  type TriageSuggestionInput,
} from '../../db/escalation-triage-db.js';
import {
  OPS_BUCKETS,
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
 * Neutralise GitHub markdown constructs that could surprise readers of
 * the filed issue. `@mentions` would ping real users when the draft is
 * pasted; markdown images pull remote content that could track IPs.
 * We break the syntax without destroying the readable text.
 */
function sanitiseForGithubBody(text: string): string {
  return text
    .replace(/(^|\s)@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g, '$1`@$2`')
    .replace(/!\[/g, '[');
}

/**
 * Build a GitHub issue draft from an escalation. PII is excluded on
 * purpose: the dedicated contact columns (`user_email`, `user_slack_handle`,
 * `user_display_name`) never enter the body, and `original_request` is
 * skipped because it tends to quote the user's raw message. The summary
 * is Addie's own scrubbed rewrite, and we additionally neutralise any
 * `@mentions` or image tags she may have carried through.
 *
 * NOTE: callers writing into `addie_escalations.summary` or `.addie_context`
 * are expected to keep them PII-free — a future intake that pipes raw user
 * text into those columns would silently ship PII onto a public issue.
 */
export function buildGithubIssueDraft(
  escalation: Escalation,
  brokenUrls: string[],
): ProposedGithubIssue {
  const titleBase = (escalation.summary ?? 'Untitled escalation').trim();
  const title = titleBase.length > 80
    ? `${titleBase.slice(0, 77).replace(/\s+\S*$/, '')}...`
    : titleBase;

  const lines: string[] = [];
  lines.push('Filed from an AAO member escalation via Addie triage.');
  lines.push('');
  lines.push('## Summary');
  lines.push(sanitiseForGithubBody(escalation.summary ?? ''));
  if (escalation.addie_context) {
    lines.push('');
    lines.push('## Context');
    lines.push(sanitiseForGithubBody(escalation.addie_context));
  }
  if (brokenUrls.length > 0) {
    lines.push('');
    lines.push('## Repro');
    for (const u of brokenUrls) lines.push(`- ${u}`);
  }
  lines.push('');
  lines.push(`---`);
  const createdIso = (() => {
    const t = escalation.created_at ? new Date(escalation.created_at).getTime() : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'unknown';
  })();
  lines.push(`Escalation #${escalation.id} · ${createdIso}`);

  return {
    title,
    body: lines.join('\n'),
    repo: process.env.GITHUB_REPO ?? 'adcontextprotocol/adcp',
    labels: ['from-escalation', 'needs-triage'],
  };
}

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
  //   404/410 → bug still repros; suggest filing a GitHub issue.
  //   200/301/302 → likely fixed; suggest resolve at MEDIUM confidence.
  //   all-null (network error) → no signal; don't fall through.
  const urls = extractAaoUrls(summary);
  if (urls.length > 0) {
    const sliced = urls.slice(0, 3);
    const probes = await Promise.all(
      sliced.map(async url => ({ url, status: await probeUrlStatus(url) })),
    );
    const probeEvidence = probes.map(p => `probe ${p.url} → ${p.status ?? 'err'}`);

    const brokenUrls = probes.filter(p => p.status === 404 || p.status === 410).map(p => p.url);
    if (brokenUrls.length > 0 && bucket === 'bug' && !escalation.github_issue_url) {
      return {
        suggested_status: 'file_as_issue',
        confidence: 'medium',
        bucket,
        reasoning: 'Bug still repros (URL returns 404/410). Propose filing as a GitHub issue so it lands in engineering triage.',
        evidence: [...evidence, ...probeEvidence],
        proposed_github_issue: buildGithubIssueDraft(escalation, brokenUrls),
      };
    }
    if (brokenUrls.length > 0) {
      return null; // still broken but already linked or not bug-shaped — leave for human
    }
    if (probes.every(p => p.status === null)) {
      return null;
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
  if (age >= staleOpsDays && OPS_BUCKETS.has(bucket) && escalation.category === 'needs_human_action') {
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

  // Fetch oldest-first so a queue >limit items doesn't silently skip the
  // staler (higher-priority) tail — the default list helper sorts newest-first.
  let candidates: Escalation[];
  try {
    const res = await query<Escalation>(
      `SELECT * FROM addie_escalations
       WHERE status = 'open'
         AND created_at <= NOW() - ($1 || ' days')::INTERVAL
       ORDER BY created_at ASC
       LIMIT $2`,
      [minAgeDays, limit],
    );
    candidates = res.rows;
  } catch (err) {
    logger.error({ err }, 'Failed to list open escalations for triage');
    result.errors++;
    return result;
  }

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
