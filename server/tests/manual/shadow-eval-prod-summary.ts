/**
 * Pull a summary of recent shadow-eval results from production.
 *
 * Hits `/api/admin/addie/threads` with `flagged_only=true` (which is how
 * shadow-eval-complete threads surface), filters client-side to those
 * with shadow_eval_status='complete', and aggregates the shape metrics
 * the new pipeline persists.
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

interface ThreadSummary {
  thread_id: string;
  context?: {
    shadow_eval_status?: string;
    shadow_eval_source?: string;
    shadow_eval_completed_at?: string;
    shadow_eval_question?: string;
    shadow_eval_result?: {
      knowledge_gap?: boolean;
      gap_severity?: string;
      gap_details?: string;
      shadow_quality?: string;
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
  };
  flag_reason?: string | null;
  channel?: string;
  last_message_at?: string;
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

interface Aggregate {
  total: number;
  by_source: Record<string, number>;
  knowledge_gaps: number;
  gap_severities: Record<string, number>;
  shape_violation_counts: Record<string, number>;
  word_counts: number[];
  ratios: number[];
  questions_with_any_violation: number;
}

function aggregate(threads: ThreadSummary[]): Aggregate {
  const out: Aggregate = {
    total: 0,
    by_source: {},
    knowledge_gaps: 0,
    gap_severities: {},
    shape_violation_counts: {},
    word_counts: [],
    ratios: [],
    questions_with_any_violation: 0,
  };
  for (const t of threads) {
    const ctx = t.context;
    if (!ctx || ctx.shadow_eval_status !== 'complete') continue;
    out.total++;
    const source = ctx.shadow_eval_source || 'suppressed';
    out.by_source[source] = (out.by_source[source] || 0) + 1;
    if (ctx.shadow_eval_result?.knowledge_gap) {
      out.knowledge_gaps++;
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
  const flaggedOnly = process.env.WIDE_SCAN ? false : true;
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

  // Dump the raw shadow_eval_* context fields for any non-unset thread so
  // we can see what the actual shape of the data is — useful when the
  // count is low and we want to confirm the new code path actually wrote
  // the shape field.
  const withStatus = detailed.filter((t) => t.context?.shadow_eval_status);
  if (withStatus.length > 0 && withStatus.length <= 10) {
    console.log('\nRaw shadow_eval_* fields on completed/pending threads:');
    for (const t of withStatus) {
      const ctx = t.context!;
      const shadowEvalKeys = Object.keys(ctx).filter((k) => k.startsWith('shadow_eval_'));
      console.log(`  thread ${t.thread_id.slice(0, 8)}…`);
      for (const k of shadowEvalKeys) {
        const v = (ctx as Record<string, unknown>)[k];
        const display =
          typeof v === 'string' && v.length > 80
            ? v.slice(0, 80) + '…'
            : JSON.stringify(v);
        console.log(`    ${k.padEnd(32)} ${display}`);
      }
    }
  }

  const agg = aggregate(detailed);
  console.log('');
  console.log(`Threads with shadow_eval_status='complete': ${agg.total}`);
  if (agg.total === 0) {
    console.log('No completed shadow evals in the recent flagged set. Nothing to summarize.');
    console.log('(If shadow_eval_completed_at is set on a thread that is also reviewed, it would not show up under flagged_only=true. Check the dashboard for a fuller view.)');
    return;
  }

  console.log('');
  console.log('Source split:');
  for (const [src, n] of Object.entries(agg.by_source)) {
    console.log(`  ${src.padEnd(28)} ${n}`);
  }

  console.log('');
  console.log(`Knowledge gaps: ${agg.knowledge_gaps} of ${agg.total} (${pct(agg.knowledge_gaps, agg.total)})`);
  if (agg.knowledge_gaps > 0) {
    console.log('  Severity breakdown:');
    for (const [sev, n] of Object.entries(agg.gap_severities)) {
      console.log(`    ${sev.padEnd(14)} ${n}`);
    }
  }

  console.log('');
  console.log(`Shape regressions: ${agg.questions_with_any_violation} of ${agg.total} (${pct(agg.questions_with_any_violation, agg.total)})`);
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
  console.log('Caveat: corpus is selected for human intervention (suppression-flow + corrected-capture both require humans to be involved). Counts here are not a global rate — they describe shape behavior on the flagged corpus.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
