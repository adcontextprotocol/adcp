/**
 * Random-sample Addie's actual prod responses and grade their shape.
 *
 * The shadow-evaluator and corrected-capture corpora both filter for
 * "humans intervened" threads, so they overrepresent Addie-was-imperfect
 * cases. This script samples the full distribution: pulls recent threads
 * via the admin API, walks (user → assistant) message pairs, and runs
 * `gradeShape` locally on each pair so we can see the real prevalence
 * of length blow-out, default templates, banned rituals, etc. across all
 * of Addie's recent prod responses.
 *
 * Auth: uses `ADMIN_API_KEY` env var (same as prod-summary script).
 *
 * Run:
 *   ADMIN_API_KEY=... npx tsx server/tests/manual/shape-eval-prod-sample.ts
 *   ADMIN_API_KEY=... SAMPLE_SIZE=100 npx tsx server/tests/manual/shape-eval-prod-sample.ts
 *   ADMIN_API_KEY=... ADCP_BASE_URL=https://staging.example.com \
 *     npx tsx server/tests/manual/shape-eval-prod-sample.ts
 */
import { gradeShape, type ShapeReport } from '../../src/addie/testing/shape-grader.js';

interface ThreadListItem {
  thread_id: string;
  channel?: string;
  last_message_at?: string;
  message_count?: number;
}

interface Message {
  message_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  sequence_number: number;
  created_at: string;
}

interface ThreadDetail {
  thread_id: string;
  channel?: string;
  messages: Message[];
}

interface SampledPair {
  thread_id: string;
  channel?: string;
  question: string;
  question_words: number;
  response: string;
  response_words: number;
  shape: ShapeReport;
  responded_at: string;
}

async function fetchThreadList(
  baseUrl: string,
  apiKey: string,
  opts: { limit: number; offset: number },
): Promise<ThreadListItem[]> {
  const params = new URLSearchParams({
    limit: String(opts.limit),
    offset: String(opts.offset),
    min_messages: '2',
  });
  const res = await fetch(`${baseUrl}/api/admin/addie/threads?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} from /threads: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { threads: ThreadListItem[] };
  return data.threads;
}

async function fetchThreadDetail(
  baseUrl: string,
  apiKey: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const res = await fetch(`${baseUrl}/api/admin/addie/threads/${threadId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ThreadDetail;
}

/**
 * Walk a thread's messages and emit one (question, response) pair for each
 * assistant message that has a substantive user message preceding it.
 *
 *   - "preceding" = highest sequence_number < the assistant's, role='user',
 *     content length > 20.
 *   - We skip assistant messages whose immediately-preceding turn is
 *     `tool` or `system` since those aren't natural-language questions.
 */
function extractPairs(thread: ThreadDetail): Array<{
  question: string;
  response: string;
  responded_at: string;
}> {
  const sorted = [...thread.messages].sort(
    (a, b) => a.sequence_number - b.sequence_number,
  );
  const pairs: Array<{ question: string; response: string; responded_at: string }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    if (msg.role !== 'assistant') continue;
    if (!msg.content || msg.content.length < 20) continue;
    // Walk backwards looking for the most recent user message.
    let userMsg: Message | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].role === 'user' && sorted[j].content && sorted[j].content.length > 5) {
        userMsg = sorted[j];
        break;
      }
    }
    if (!userMsg) continue;
    pairs.push({
      question: userMsg.content,
      response: msg.content,
      responded_at: msg.created_at,
    });
  }
  return pairs;
}

interface Aggregate {
  sampled: number;
  channels: Record<string, number>;
  questionWordsHist: { p10: number; p50: number; p90: number; min: number; max: number };
  responseWordsHist: { p10: number; p50: number; p90: number; min: number; max: number };
  ratioHist: { p10: number; p50: number; p90: number; min: number; max: number };
  multiPartCount: number;
  explainerCount: number;
  /** length_cap fires that occurred on non-explainer questions — the
   *  metric to track for actual verbosity regressions. */
  nonExplainerLengthCap: number;
  /** length_cap fires that occurred on explainer questions — these are
   *  policy-allowed (Voice rule) but still surfaced for visibility. */
  explainerLengthCap: number;
  violationCounts: Record<string, number>;
  pairsWithAnyViolation: number;
  /** Pairs with any violation that was NOT a policy-allowed explainer
   *  length_cap. The actionable AnyViol rate. */
  pairsWithActionableViolation: number;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return 'n/a';
  return `${((part / whole) * 100).toFixed(0)}%`;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function aggregate(pairs: SampledPair[]): Aggregate {
  const out: Aggregate = {
    sampled: pairs.length,
    channels: {},
    questionWordsHist: { p10: 0, p50: 0, p90: 0, min: 0, max: 0 },
    responseWordsHist: { p10: 0, p50: 0, p90: 0, min: 0, max: 0 },
    ratioHist: { p10: 0, p50: 0, p90: 0, min: 0, max: 0 },
    multiPartCount: 0,
    explainerCount: 0,
    nonExplainerLengthCap: 0,
    explainerLengthCap: 0,
    violationCounts: {},
    pairsWithAnyViolation: 0,
    pairsWithActionableViolation: 0,
  };
  const qWords: number[] = [];
  const rWords: number[] = [];
  const ratios: number[] = [];
  for (const p of pairs) {
    out.channels[p.channel || '?'] = (out.channels[p.channel || '?'] || 0) + 1;
    qWords.push(p.question_words);
    rWords.push(p.response_words);
    ratios.push(p.shape.violations.ratioToExpected);
    if (p.shape.question.isMultiPart) out.multiPartCount++;
    if (p.shape.question.isExplainer) out.explainerCount++;
    if (p.shape.violations.exceededLengthCap) {
      if (p.shape.question.isExplainer) {
        out.explainerLengthCap++;
      } else {
        out.nonExplainerLengthCap++;
      }
    }
    if (p.shape.violationLabels.length > 0) {
      out.pairsWithAnyViolation++;
      // Actionable = at least one violation that ISN'T a policy-allowed
      // explainer length_cap. If the only violation is length_cap on an
      // explainer, the Voice rule explicitly allows it; not actionable.
      const onlyExplainerLength =
        p.shape.question.isExplainer &&
        p.shape.violationLabels.every((v) => v.startsWith('length_cap'));
      if (!onlyExplainerLength) out.pairsWithActionableViolation++;
    }
    for (const v of p.shape.violationLabels) {
      const bucket = v.includes('(') ? v.slice(0, v.indexOf('(')) : v.split(':')[0];
      out.violationCounts[bucket] = (out.violationCounts[bucket] || 0) + 1;
    }
  }
  if (qWords.length > 0) {
    out.questionWordsHist = {
      p10: pctile(qWords, 10),
      p50: pctile(qWords, 50),
      p90: pctile(qWords, 90),
      min: Math.min(...qWords),
      max: Math.max(...qWords),
    };
    out.responseWordsHist = {
      p10: pctile(rWords, 10),
      p50: pctile(rWords, 50),
      p90: pctile(rWords, 90),
      min: Math.min(...rWords),
      max: Math.max(...rWords),
    };
    out.ratioHist = {
      p10: pctile(ratios, 10),
      p50: pctile(ratios, 50),
      p90: pctile(ratios, 90),
      min: Math.min(...ratios),
      max: Math.max(...ratios),
    };
  }
  return out;
}

async function main() {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) {
    console.error('ADMIN_API_KEY env var not set.');
    process.exit(1);
  }
  const baseUrl = (process.env.ADCP_BASE_URL || 'https://agenticadvertising.org').replace(
    /\/$/,
    '',
  );
  const sampleSize = Math.max(
    1,
    parseInt(process.env.SAMPLE_SIZE ?? '50', 10) || 50,
  );

  console.log(`Pulling thread list from ${baseUrl} ...`);
  // Pull a wide pool, then sample uniformly. Default sample size 50;
  // bumping SAMPLE_SIZE pulls more threads.
  const poolTarget = Math.max(sampleSize * 4, 200);
  const pageSize = 50;
  const pool: ThreadListItem[] = [];
  for (let offset = 0; offset < poolTarget; offset += pageSize) {
    try {
      const page = await fetchThreadList(baseUrl, apiKey, {
        limit: pageSize,
        offset,
      });
      pool.push(...page);
      if (page.length < pageSize) break;
    } catch (err) {
      console.error(`Page ${offset} failed:`, err);
      break;
    }
  }
  console.log(`Pool: ${pool.length} threads (≥2 messages each).`);

  // Uniform random shuffle, then walk in order until we collect SAMPLE_SIZE
  // qualifying (user → assistant) pairs. Each thread can contribute >1 pair.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Pairs-per-thread cap. Default 1 so each (user → assistant) pair comes
  // from a distinct conversation — gives independent samples across the
  // shape grader's metrics. Bump if you want more depth per thread.
  const pairsPerThread = Math.max(
    1,
    parseInt(process.env.PAIRS_PER_THREAD ?? '1', 10) || 1,
  );

  const sampled: SampledPair[] = [];
  console.log(
    `Walking threads to extract (user → assistant) pairs (target: ${sampleSize}, ≤${pairsPerThread} per thread) ...`,
  );
  let processed = 0;
  for (const t of pool) {
    if (sampled.length >= sampleSize) break;
    const detail = await fetchThreadDetail(baseUrl, apiKey, t.thread_id);
    processed++;
    if (!detail) continue;
    const pairs = extractPairs(detail);
    // Pick a random subset of pairs per thread when more exist than the cap,
    // so we don't always grab the first pair of every thread.
    const shuffled = [...pairs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let takenFromThread = 0;
    for (const pair of shuffled) {
      if (sampled.length >= sampleSize) break;
      if (takenFromThread >= pairsPerThread) break;
      const shape = gradeShape(pair.question, pair.response);
      sampled.push({
        thread_id: t.thread_id,
        channel: t.channel,
        question: pair.question,
        question_words: shape.question.wordCount,
        response: pair.response,
        response_words: shape.response.wordCount,
        shape,
        responded_at: pair.responded_at,
      });
      takenFromThread++;
    }
    if (processed % 10 === 0) process.stdout.write('.');
  }
  process.stdout.write(' done\n');
  const distinctThreads = new Set(sampled.map((s) => s.thread_id)).size;
  console.log(
    `Processed ${processed} threads, sampled ${sampled.length} (user → assistant) pairs from ${distinctThreads} distinct threads.\n`,
  );

  if (sampled.length === 0) {
    console.log('No pairs sampled. Either no recent threads with both user + assistant messages, or fetch failures.');
    return;
  }

  const agg = aggregate(sampled);

  console.log('='.repeat(80));
  console.log(' RANDOM SAMPLE — ADDIE PROD SHAPE');
  console.log('='.repeat(80));
  console.log(`Sampled ${agg.sampled} (user → assistant) pairs.`);
  console.log('Channels:');
  for (const [c, n] of Object.entries(agg.channels).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(12)} ${n}`);
  }
  console.log('');
  console.log(`Question words   p10/p50/p90/max: ${agg.questionWordsHist.p10}/${agg.questionWordsHist.p50}/${agg.questionWordsHist.p90}/${agg.questionWordsHist.max}`);
  console.log(`Response words   p10/p50/p90/max: ${agg.responseWordsHist.p10}/${agg.responseWordsHist.p50}/${agg.responseWordsHist.p90}/${agg.responseWordsHist.max}`);
  console.log(`Ratio to cap     p10/p50/p90/max: ${agg.ratioHist.p10.toFixed(2)}/${agg.ratioHist.p50.toFixed(2)}/${agg.ratioHist.p90.toFixed(2)}/${agg.ratioHist.max.toFixed(2)}`);
  console.log(`Multi-part questions: ${agg.multiPartCount} of ${agg.sampled} (${pct(agg.multiPartCount, agg.sampled)})`);
  console.log(`Explainer questions:  ${agg.explainerCount} of ${agg.sampled} (${pct(agg.explainerCount, agg.sampled)}) — these get the wider 500-word cap`);
  console.log('');
  console.log(`Pairs with ANY shape violation: ${agg.pairsWithAnyViolation} of ${agg.sampled} (${pct(agg.pairsWithAnyViolation, agg.sampled)})`);
  console.log(`Pairs with ACTIONABLE violation: ${agg.pairsWithActionableViolation} of ${agg.sampled} (${pct(agg.pairsWithActionableViolation, agg.sampled)}) — excludes policy-allowed explainer length_cap`);
  console.log(`Length cap on non-explainer questions: ${agg.nonExplainerLengthCap} (${pct(agg.nonExplainerLengthCap, agg.sampled - agg.explainerCount)} of non-explainers)`);
  if (agg.explainerLengthCap > 0) {
    console.log(`Length cap on explainer questions: ${agg.explainerLengthCap} (${pct(agg.explainerLengthCap, agg.explainerCount)} of explainers — these are policy-allowed but flagged for visibility)`);
  }
  if (Object.keys(agg.violationCounts).length > 0) {
    console.log('Violation bucket counts:');
    const sorted = Object.entries(agg.violationCounts).sort((a, b) => b[1] - a[1]);
    for (const [bucket, n] of sorted) {
      console.log(`  ${bucket.padEnd(24)} ${n}  (${pct(n, agg.sampled)})`);
    }
  }
  console.log('');
  console.log('This is a UNIFORM random sample — unlike the corrected/suppression');
  console.log('corpora it includes the cases Addie handled fine, so the prevalence');
  console.log('rates here ARE meaningful as a global rate (within sampling error).');

  // Worst offenders: top 5 by ratio-to-cap, with the actual question and
  // response truncated. Useful for seeing where the cap is being missed.
  const worst = [...sampled]
    .filter((p) => p.shape.violations.exceededLengthCap)
    .sort((a, b) => b.shape.violations.ratioToExpected - a.shape.violations.ratioToExpected)
    .slice(0, 5);
  if (worst.length > 0) {
    console.log('');
    console.log('='.repeat(80));
    console.log(' TOP 5 WORST OFFENDERS BY RATIO-TO-CAP');
    console.log('='.repeat(80));
    for (const p of worst) {
      console.log('');
      console.log(`thread ${p.thread_id.slice(0, 8)}…  channel=${p.channel}  ratio=${p.shape.violations.ratioToExpected.toFixed(2)}`);
      console.log(`question (${p.question_words}w, multi-part=${p.shape.question.isMultiPart}): ${p.question.replace(/\s+/g, ' ').slice(0, 200)}${p.question.length > 200 ? '…' : ''}`);
      console.log(`response (${p.response_words}w; cap=${p.shape.question.expectedMaxWords}; violations=${p.shape.violationLabels.join(', ')}):`);
      console.log(`  ${p.response.replace(/\n/g, '\n  ').slice(0, 300)}${p.response.length > 300 ? '…' : ''}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
