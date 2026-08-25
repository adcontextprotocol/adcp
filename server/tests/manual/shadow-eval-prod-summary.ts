/**
 * Pull a summary of recent shadow-eval results from production.
 *
 * Scans recent threads without a flagged-only filter by default, filters
 * client-side to shadow_eval_status='complete', and aggregates the metrics
 * the pipeline persists. A flagged-only default would omit corrected-answer
 * no-gap completions and inflate the apparent gap rate.
 *
 * Auth: uses `ADMIN_API_KEY` env var as a Bearer token. Same env var the
 * red-team runner uses (server/src/addie/testing/redteam-runner.ts:170).
 *
 * Run:
 *   ADMIN_API_KEY=... npx tsx server/tests/manual/shadow-eval-prod-summary.ts
 *   ADMIN_API_KEY=... ADCP_BASE_URL=https://agenticadvertising.org \
 *     npx tsx server/tests/manual/shadow-eval-prod-summary.ts
 *
 * Defaults to https://agenticadvertising.org. Override with ADCP_BASE_URL
 * to point at staging or local.
 */

import { pathToFileURL } from 'node:url';
import { hasHeadlineEligibleProvenance } from '../../src/addie/jobs/shadow-eval-metadata.js';

export interface ThreadSummary {
  thread_id: string;
  context?: {
    shadow_eval_status?: string;
    shadow_eval_type?: string;
    shadow_eval_source?: string;
    shadow_eval_completed_at?: string;
    shadow_eval_question?: string;
    shadow_eval_result?: {
      knowledge_gap?: boolean;
      gap_severity?: string;
      gap_details?: string;
      shadow_quality?: string;
      evaluation_valid?: boolean;
      evaluation_skipped?: boolean;
      evaluation_error?: string;
    };
    shadow_eval_shape?: {
      shadow?: {
        word_count?: number;
        violations?: string[];
        ratio_to_expected?: number;
      };
      human?: {
        word_count?: number;
        violations?: string[];
      };
      question?: {
        word_count?: number;
        multi_part?: boolean;
        expected_max_words?: number;
      };
    };
    shadow_eval_provenance?: {
      schema_version?: number;
      source_answer?: { model?: string | null; config_version_id?: number | null };
      source_opportunity?: { config_version_id?: number | null };
      generator?: { model?: string } | null;
      judge?: { model?: string };
      self_judged?: boolean | null;
      tools?: {
        mode?: string;
        trace_or_fixture_id?: string | null;
        policy_version?: string | null;
        complete_fidelity?: boolean;
        blocked_capabilities?: string[];
        hash_key_version?: string | null;
        trace_verified?: boolean;
        system_block_hashes?: string[];
        schemas?: unknown[];
      };
    };
  };
  flag_reason?: string | null;
  channel?: string;
  last_message_at?: string;
}

interface CaptureSummary {
  days: number;
  total: number;
  outcomes: Array<{ status: string; reason: string; count: number }>;
  generations?: {
    total: number;
    input_tokens: number;
    output_tokens: number;
    outcomes: Array<{
      status: string;
      reason: string;
      count: number;
      input_tokens: number;
      output_tokens: number;
    }>;
  };
  judgments?: {
    total: number;
    input_tokens: number;
    output_tokens: number;
    outcomes: Array<{
      status: string;
      reason: string;
      count: number;
      input_tokens: number;
      output_tokens: number;
    }>;
  };
  funnel?: {
    opportunities: number;
    traces_captured: number;
    parity_verified: number;
    capture_verified: number;
    capture_pending: number;
    capture_skipped: number;
    capture_error: number;
    generation_claimed: number;
    generation_succeeded: number;
    generation_blocked: number;
    generation_error: number;
    generation_running: number;
    judgment_judged: number;
    judgment_deterministic_failure: number;
    judgment_skipped: number;
    judgment_error: number;
    judgment_missing: number;
  };
}

async function fetchCaptureSummary(baseUrl: string, apiKey: string): Promise<CaptureSummary> {
  const res = await fetch(`${baseUrl}/api/admin/addie/threads/shadow-replay-captures?days=7`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from shadow replay capture summary`);
  return res.json() as Promise<CaptureSummary>;
}

async function fetchThreads(
  baseUrl: string,
  apiKey: string,
  opts: { flaggedOnly: boolean; limit: number; offset: number },
): Promise<ThreadSummary[]> {
  const params = new URLSearchParams({
    flagged_only: String(opts.flaggedOnly),
    limit: String(opts.limit),
    offset: String(opts.offset),
  });
  const res = await fetch(`${baseUrl}/api/admin/addie/threads?${params}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} from /threads: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { threads: ThreadSummary[] };
  return data.threads;
}

/**
 * The list endpoint queries `addie_threads_summary` (a VIEW) which doesn't
 * include the `context` JSONB column. Fetch full thread details — the
 * `/threads/:id` endpoint spreads `...thread` and exposes the context.
 */
async function fetchThreadDetail(
  baseUrl: string,
  apiKey: string,
  threadId: string,
): Promise<ThreadSummary | null> {
  const res = await fetch(`${baseUrl}/api/admin/addie/threads/${threadId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ThreadSummary;
}

export interface Aggregate {
  total: number;
  completed: number;
  eligible_total: number;
  by_source: Record<string, number>;
  by_type: Record<string, number>;
  eligible_by_type: Record<string, number>;
  knowledge_gaps_by_type: Record<string, number>;
  invalid_evaluations_by_type: Record<string, number>;
  skipped_evaluations_by_type: Record<string, number>;
  provenance_excluded_by_type: Record<string, number>;
  replay_fidelity: Record<string, number>;
  blocked_capability_counts: Record<string, number>;
  gap_severities: Record<string, number>;
  shape_violation_counts: Record<string, number>;
  word_counts: number[];
  ratios: number[];
  questions_with_any_violation: number;
}

export function aggregate(threads: ThreadSummary[]): Aggregate {
  const out: Aggregate = {
    total: 0,
    completed: 0,
    eligible_total: 0,
    by_source: {},
    by_type: {},
    eligible_by_type: {},
    knowledge_gaps_by_type: {},
    invalid_evaluations_by_type: {},
    skipped_evaluations_by_type: {},
    provenance_excluded_by_type: {},
    replay_fidelity: {},
    blocked_capability_counts: {},
    gap_severities: {},
    shape_violation_counts: {},
    word_counts: [],
    ratios: [],
    questions_with_any_violation: 0,
  };
  for (const t of threads) {
    const ctx = t.context;
    if (!ctx || !['complete', 'error', 'skipped'].includes(ctx.shadow_eval_status || '')) continue;
    out.total++;
    const source = ctx.shadow_eval_source || 'suppressed';
    out.by_source[source] = (out.by_source[source] || 0) + 1;
    const evaluationType = ctx.shadow_eval_type
      || (source === 'addie_corrected_capture'
        ? 'corrected_answer (legacy inferred)'
        : source === 'backfill'
          ? 'historical_corrected_answer (legacy inferred)'
          : 'suppressed_opportunity (legacy inferred)');
    out.by_type[evaluationType] = (out.by_type[evaluationType] || 0) + 1;
    if (ctx.shadow_eval_provenance?.tools?.mode === 'read_only_replay') {
      const fidelity = ctx.shadow_eval_provenance.tools.complete_fidelity === true
        ? 'complete'
        : 'incomplete';
      out.replay_fidelity[fidelity] = (out.replay_fidelity[fidelity] || 0) + 1;
      for (const capability of ctx.shadow_eval_provenance.tools.blocked_capabilities || []) {
        const category = capability.split(':', 1)[0] || 'unknown';
        out.blocked_capability_counts[category] =
          (out.blocked_capability_counts[category] || 0) + 1;
      }
    }
    if (ctx.shadow_eval_status === 'skipped' || ctx.shadow_eval_result?.evaluation_skipped === true) {
      out.skipped_evaluations_by_type[evaluationType] =
        (out.skipped_evaluations_by_type[evaluationType] || 0) + 1;
      continue;
    }
    if (ctx.shadow_eval_status === 'error' || ctx.shadow_eval_result?.evaluation_valid !== true) {
      out.invalid_evaluations_by_type[evaluationType] =
        (out.invalid_evaluations_by_type[evaluationType] || 0) + 1;
      continue;
    }
    out.completed++;
    if (!hasHeadlineEligibleProvenance(ctx.shadow_eval_provenance)) {
      out.provenance_excluded_by_type[evaluationType] =
        (out.provenance_excluded_by_type[evaluationType] || 0) + 1;
      continue;
    }
    out.eligible_total++;
    out.eligible_by_type[evaluationType] = (out.eligible_by_type[evaluationType] || 0) + 1;
    if (ctx.shadow_eval_result.knowledge_gap) {
      out.knowledge_gaps_by_type[evaluationType] =
        (out.knowledge_gaps_by_type[evaluationType] || 0) + 1;
      const sev = ctx.shadow_eval_result.gap_severity || 'unknown';
      out.gap_severities[sev] = (out.gap_severities[sev] || 0) + 1;
    }
    const shape = ctx.shadow_eval_shape?.shadow;
    if (shape) {
      if (typeof shape.word_count === 'number') out.word_counts.push(shape.word_count);
      if (typeof shape.ratio_to_expected === 'number') out.ratios.push(shape.ratio_to_expected);
      const violations = shape.violations || [];
      if (violations.length > 0) out.questions_with_any_violation++;
      for (const v of violations) {
        // Bucket length_cap(N>M) and ritual:phrase under their prefix so
        // counts are meaningful — otherwise every length_cap reading is
        // a unique key.
        const bucket = v.includes('(') ? v.slice(0, v.indexOf('(')) : v.split(':')[0];
        out.shape_violation_counts[bucket] = (out.shape_violation_counts[bucket] || 0) + 1;
      }
    }
  }
  return out;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pct(part: number, whole: number): string {
  if (whole === 0) return 'n/a';
  return `${((part / whole) * 100).toFixed(0)}%`;
}

async function main() {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) {
    console.error('ADMIN_API_KEY env var not set. Run with:');
    console.error('  ADMIN_API_KEY=... npx tsx server/tests/manual/shadow-eval-prod-summary.ts');
    process.exit(1);
  }
  const baseUrl = (process.env.ADCP_BASE_URL || 'https://agenticadvertising.org').replace(
    /\/$/,
    '',
  );

  // Two passes: flagged threads (where shadow-eval-complete results land
  // because the evaluator calls flagThread on every completion) and a
  // wider scan of recent threads regardless of flag state, so we can also
  // count pending / error statuses and confirm whether the job is running.
  const flaggedOnly = process.env.FLAGGED_ONLY === 'true';
  console.log(`Pulling ${flaggedOnly ? 'flagged' : 'all'} threads from ${baseUrl} ...`);
  const pageSize = 50;
  const targetMax = flaggedOnly ? 200 : 400;
  const all: ThreadSummary[] = [];
  for (let offset = 0; offset < targetMax; offset += pageSize) {
    try {
      const page = await fetchThreads(baseUrl, apiKey, {
        flaggedOnly,
        limit: pageSize,
        offset,
      });
      all.push(...page);
      if (page.length < pageSize) break;
    } catch (err) {
      console.error(`Page ${offset} failed:`, err);
      break;
    }
  }
  console.log(`Got ${all.length} thread summaries (flagged_only=${flaggedOnly}).`);

  try {
    const captureSummary = await fetchCaptureSummary(baseUrl, apiKey);
    console.log(
      `Signed capture-parity opportunities (${captureSummary.days}d): ${captureSummary.total}`,
    );
    for (const outcome of captureSummary.outcomes) {
      console.log(
        `  ${`${outcome.status}:${outcome.reason}`.padEnd(52)} ${outcome.count}`,
      );
    }
    if (captureSummary.generations) {
      console.log(
        `Generation-only replays: ${captureSummary.generations.total} `
        + `(${captureSummary.generations.input_tokens} input / `
        + `${captureSummary.generations.output_tokens} output tokens)`,
      );
      for (const outcome of captureSummary.generations.outcomes) {
        console.log(
          `  ${`${outcome.status}:${outcome.reason}`.padEnd(52)} ${outcome.count} `
          + `(${outcome.input_tokens} input / ${outcome.output_tokens} output tokens)`,
        );
      }
    }
    if (captureSummary.judgments) {
      console.log(
        `Judgment outcomes: ${captureSummary.judgments.total} `
        + `(${captureSummary.judgments.input_tokens} input / `
        + `${captureSummary.judgments.output_tokens} output tokens)`,
      );
      for (const outcome of captureSummary.judgments.outcomes) {
        console.log(
          `  ${`${outcome.status}:${outcome.reason}`.padEnd(52)} ${outcome.count} `
          + `(${outcome.input_tokens} input / ${outcome.output_tokens} output tokens)`,
        );
      }
    }
    if (captureSummary.funnel) {
      const funnel = captureSummary.funnel;
      console.log(
        'Replay funnel: '
        + `${funnel.opportunities} opportunities → ${funnel.traces_captured} signed → `
        + `${funnel.parity_verified} parity verified → `
        + `${funnel.generation_claimed} claimed → ${funnel.generation_succeeded} generated → `
        + `${funnel.judgment_judged} judged`,
      );
      console.log(
        '  exclusions/failures: '
        + `${funnel.capture_pending} capture pending, ${funnel.capture_skipped} capture skipped, `
        + `${funnel.capture_error} capture error, ${funnel.generation_blocked} generation blocked, `
        + `${funnel.generation_error} generation error, ${funnel.generation_running} generation running, `
        + `${funnel.judgment_deterministic_failure} deterministic failure, `
        + `${funnel.judgment_skipped} judgment skipped, ${funnel.judgment_error} judgment error, `
        + `${funnel.judgment_missing} judgment missing`,
      );
    }
  } catch (error) {
    console.warn(
      'Signed capture-parity summary unavailable:',
      error instanceof Error ? error.message : 'unknown error',
    );
  }

  // The list endpoint returns a summary VIEW that doesn't include the
  // context JSONB. Fan out to /threads/:id for each thread to read
  // shadow_eval_*. Cap concurrency to keep load polite.
  console.log(`Fetching context for each thread (${all.length} requests, ~5/concurrent)...`);
  const detailed: ThreadSummary[] = [];
  const concurrency = 5;
  for (let i = 0; i < all.length; i += concurrency) {
    const batch = all.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((t) => fetchThreadDetail(baseUrl, apiKey, t.thread_id)),
    );
    for (const r of results) {
      if (r) detailed.push(r);
    }
    process.stdout.write('.');
  }
  process.stdout.write(' done\n');

  // Count by shadow_eval_status so a zero-complete result tells us whether
  // the evaluator hasn't run vs nothing was queued vs deploy hasn't rolled.
  const statusCounts: Record<string, number> = {};
  for (const t of detailed) {
    const s = t.context?.shadow_eval_status || '<unset>';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  console.log('shadow_eval_status counts:');
  for (const [s, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(16)} ${n}`);
  }

  const agg = aggregate(detailed);
  console.log('');
  console.log(`Shadow-eval attempts (complete + error + skipped): ${agg.total}`);
  if (agg.total === 0) {
    console.log('No recent shadow-eval attempts. Nothing to summarize.');
    return;
  }
  console.log(`Structurally valid completions: ${agg.completed}`);
  console.log(`Headline-eligible (valid + independently judged): ${agg.eligible_total}`);

  if (Object.keys(agg.replay_fidelity).length > 0) {
    console.log('Read-only replay fidelity:');
    for (const [fidelity, n] of Object.entries(agg.replay_fidelity)) {
      console.log(`  ${fidelity.padEnd(16)} ${n}`);
    }
    for (const [category, n] of Object.entries(agg.blocked_capability_counts)) {
      console.log(`  blocked:${category.padEnd(8)} ${n}`);
    }
  }

  console.log('');
  console.log('Source split:');
  for (const [src, n] of Object.entries(agg.by_source)) {
    console.log(`  ${src.padEnd(28)} ${n}`);
  }

  console.log('');
  console.log('Evaluation-type split (report these as separate corpora):');
  for (const [evaluationType, n] of Object.entries(agg.by_type)) {
    const gaps = agg.knowledge_gaps_by_type[evaluationType] || 0;
    const eligible = agg.eligible_by_type[evaluationType] || 0;
    const invalid = agg.invalid_evaluations_by_type[evaluationType] || 0;
    const skipped = agg.skipped_evaluations_by_type[evaluationType] || 0;
    const excluded = agg.provenance_excluded_by_type[evaluationType] || 0;
    console.log(
      `  ${evaluationType.padEnd(46)} ${n} attempts; ${eligible} eligible; ` +
      `${gaps} gaps (${pct(gaps, eligible)}); ${invalid} invalid; ${skipped} skipped; ` +
      `${excluded} provenance-excluded`,
    );
  }

  if (Object.keys(agg.gap_severities).length > 0) {
    console.log('');
    console.log('  Severity breakdown:');
    for (const [sev, n] of Object.entries(agg.gap_severities)) {
      console.log(`    ${sev.padEnd(14)} ${n}`);
    }
  }

  console.log('');
  console.log(`Shape regressions among headline-eligible rows: ${agg.questions_with_any_violation} of ${agg.eligible_total} (${pct(agg.questions_with_any_violation, agg.eligible_total)})`);
  if (Object.keys(agg.shape_violation_counts).length > 0) {
    console.log('  Violation bucket counts (sum across threads):');
    const sorted = Object.entries(agg.shape_violation_counts).sort((a, b) => b[1] - a[1]);
    for (const [bucket, n] of sorted) {
      console.log(`    ${bucket.padEnd(24)} ${n}`);
    }
  }

  if (agg.word_counts.length > 0) {
    const min = Math.min(...agg.word_counts);
    const max = Math.max(...agg.word_counts);
    const med = median(agg.word_counts);
    console.log('');
    console.log(`Addie response word count — min ${min}, median ${med}, max ${max}`);
  }
  if (agg.ratios.length > 0) {
    const minR = Math.min(...agg.ratios);
    const maxR = Math.max(...agg.ratios);
    const medR = median(agg.ratios);
    console.log(`Ratio to expected — min ${minR.toFixed(2)}, median ${medR.toFixed(2)}, max ${maxR.toFixed(2)}`);
  }

  console.log('');
  console.log('Caveat: this corpus is selected for human intervention (suppression-flow + corrected-capture both require humans to be involved). Counts here are not a global rate.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
