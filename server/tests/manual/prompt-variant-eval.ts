/**
 * Prompt variant A/B eval.
 *
 * Uses the shape grader and the production prompt assembly to test what
 * structural changes to Addie's rule stack actually move the shape-
 * regression rate. Each variant defines a transformation on the assembled
 * system prompt; the runner sends a fixed question battery to each variant
 * via the live Anthropic API and grades the response shape deterministically.
 *
 * Variants (see the `VARIANTS` array below for the full list):
 *   A — Baseline: current production prompt as-is.
 *   B — Style-last: response-style.md moved to AFTER the tool reference.
 *   C — Dedupe: remove the duplicate "Response length" section in the tool
 *       reference body.
 *   D — B + C combined.
 *   E — Drop the "Spec Exploration Follow-Up" rule in behaviors.md.
 *   F — Drop the "Conversation Pivot — While I Have You" rule.
 *   G — Drop both follow-up rules (E + F combined).
 *
 * Question battery: Katie's registry thread + a curated subset of the
 * red-team scenarios + a handful of high-traffic AAO questions that tend to
 * trigger structured answers.
 *
 * Defaults to Haiku for cost ($0.001/call). Run with SHADOW_EVAL_MODEL=primary
 * to use the production Sonnet model — same env var the shadow evaluator
 * uses, so settings stay aligned across the eval pipeline.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-… npx tsx server/tests/manual/prompt-variant-eval.ts
 *   SHADOW_EVAL_MODEL=primary ANTHROPIC_API_KEY=sk-… npx tsx server/tests/manual/prompt-variant-eval.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { gradeShape, type ShapeReport } from '../../src/addie/testing/shape-grader.js';
import { loadRules, loadResponseStyle } from '../../src/addie/rules/index.js';
import { ADDIE_TOOL_REFERENCE } from '../../src/addie/prompts.js';
import { resolveShadowModel } from '../../src/addie/jobs/shadow-evaluator.js';
import { RED_TEAM_SCENARIOS } from '../../src/addie/testing/redteam-scenarios.js';

// ---------------------------------------------------------------------------
// Variant transformations
// ---------------------------------------------------------------------------

type SystemPromptBuilder = () => string;

/**
 * Build the current production prompt: base rules + tool reference +
 * response-style.md. As of the rules/index.ts refactor that shipped
 * variant B, response-style.md is loaded separately and appended last.
 *
 * To reproduce the OLD ordering (style before tool reference), use the
 * `style-before-tools` variant defined below.
 */
function buildBaselinePrompt(): string {
  return `${loadRules()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}\n\n---\n\n${loadResponseStyle()}`;
}

/**
 * Reproduce the pre-shape-grader-eval ordering (style sandwiched between
 * the base rules and the tool reference). Kept as a regression-check
 * variant — re-running the eval against this should reproduce the
 * worse-shape numbers we saw before the move.
 */
function buildLegacyOrderPrompt(): string {
  // loadRules() now returns rules WITHOUT response-style.md, so we have
  // to splice it back in to reproduce the legacy order.
  return `${loadRules()}\n\n---\n\n${loadResponseStyle()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
}


/**
 * Strip the duplicate "Response length — be conversational, not encyclopedic"
 * section from the tool reference body. response-style.md already covers
 * the same ground at higher fidelity; the duplicate competes for attention.
 */
function applyToolRefDedupe(prompt: string): string {
  // The duplicate section sits inside ADDIE_TOOL_REFERENCE_BODY at
  // prompts.ts:330-337. Anchored bold-headed section followed by a bulleted
  // list; ends at the next blank-line + bold heading.
  const marker = '**Response length — be conversational, not encyclopedic:**';
  const start = prompt.indexOf(marker);
  if (start === -1) return prompt;
  // Find the next standalone `**...**` heading after a blank line.
  const after = prompt.indexOf('\n\n**', start + marker.length);
  if (after === -1) return prompt;
  return prompt.slice(0, start) + prompt.slice(after + 2);
}

/**
 * Strip the named `## ...` section from behaviors.md content inside the
 * assembled prompt. Anchored to the heading; ends at the next `## ` or
 * the document separator.
 */
function stripBehaviorsSection(prompt: string, heading: string): string {
  const anchor = `## ${heading}`;
  const start = prompt.indexOf(anchor);
  if (start === -1) return prompt;
  // Next `## ` (sibling heading) or `\n---\n` (file-separator we use)
  const restAfter = prompt.slice(start + anchor.length);
  const nextSection = restAfter.search(/\n## [^\n]+|\n---\n/);
  if (nextSection === -1) return prompt; // section is at the end of the file
  const end = start + anchor.length + nextSection;
  return prompt.slice(0, start) + prompt.slice(end);
}

interface Variant {
  id: string;
  name: string;
  description: string;
  build: SystemPromptBuilder;
  /**
   * How the variant's prompt size should differ from the baseline. Checked
   * before any API calls so a no-op transform fails loud instead of
   * producing misleading "no signal" eval results — silent no-ops are the
   * specific failure mode flagged by the prompt-engineer review on
   * PR #3601 (e.g., a future rule edit renames a heading the strip
   * targeted).
   *
   *  - `same`: variant must produce the same byte size as baseline (pure
   *    reorders fall here — Variant A and Z).
   *  - `smaller`: variant must produce a prompt strictly smaller than
   *    baseline (every strip / dedupe transform).
   *  - `larger`: variant must produce a prompt strictly larger than
   *    baseline (placeholder for future "add a section" experiments).
   *  - `any`: skip the check (only set this with a comment explaining why).
   */
  expectedSizeVsBaseline: 'same' | 'smaller' | 'larger' | 'any';
}

const VARIANTS: Variant[] = [
  {
    id: 'A',
    name: 'Baseline (style-last)',
    description: 'Current production prompt: base rules + tool reference + response-style.md.',
    build: buildBaselinePrompt,
    expectedSizeVsBaseline: 'same',
  },
  {
    id: 'Z',
    name: 'Legacy order',
    description:
      'Pre-eval prompt order (style sandwiched between rules and tool ref). Regression check.',
    build: buildLegacyOrderPrompt,
    expectedSizeVsBaseline: 'same',
  },
  {
    id: 'C',
    name: 'Dedupe',
    description: 'Remove duplicate Response length section in tool reference.',
    build: () => applyToolRefDedupe(buildBaselinePrompt()),
    expectedSizeVsBaseline: 'smaller',
  },
  {
    id: 'E',
    name: 'Drop spec-exploration',
    description: 'Drop "Spec Exploration Follow-Up" section in behaviors.md.',
    build: () => stripBehaviorsSection(buildBaselinePrompt(), 'Spec Exploration Follow-Up'),
    expectedSizeVsBaseline: 'smaller',
  },
  {
    id: 'F',
    name: 'Drop conv-pivot',
    description: 'Drop Conversation Pivot + Opportunistic Information Gathering sections.',
    build: () => {
      // The two sections are consecutive (## Conv Pivot then ## Opp Info
      // Gathering with the actual content under the second heading); strip
      // both so the rule is fully removed.
      let p = buildBaselinePrompt();
      p = stripBehaviorsSection(p, 'Conversation Pivot - While I Have You');
      p = stripBehaviorsSection(p, 'Opportunistic Information Gathering');
      return p;
    },
    expectedSizeVsBaseline: 'smaller',
  },
  {
    id: 'G',
    name: 'Drop both follow-ups',
    description: 'E + F combined.',
    build: () => {
      let p = buildBaselinePrompt();
      p = stripBehaviorsSection(p, 'Spec Exploration Follow-Up');
      p = stripBehaviorsSection(p, 'Conversation Pivot - While I Have You');
      p = stripBehaviorsSection(p, 'Opportunistic Information Gathering');
      return p;
    },
    expectedSizeVsBaseline: 'smaller',
  },
];

/**
 * Validate every variant's prompt builder before any API calls. A silent
 * no-op transform (e.g., a future rule edit renames a heading the strip
 * targeted) would otherwise produce a "no signal" eval result that looks
 * like the change didn't matter. Failing loud here forces the runner to
 * be updated alongside the rule edit.
 *
 * Returns the list of validation errors. Empty list = all variants OK.
 */
function validateVariants(): string[] {
  const errors: string[] = [];
  const baseline = VARIANTS.find((v) => v.id === 'A');
  if (!baseline) {
    errors.push('Could not establish baseline size — A variant missing.');
    return errors;
  }
  let baselineSize: number;
  try {
    baselineSize = baseline.build().length;
  } catch (err) {
    errors.push(`Baseline (A) build failed: ${err}`);
    return errors;
  }
  for (const v of VARIANTS) {
    if (v.expectedSizeVsBaseline === 'any') continue;
    let size: number;
    try {
      size = v.build().length;
    } catch (err) {
      errors.push(`Variant ${v.id} (${v.name}): build threw — ${err}`);
      continue;
    }
    const cmp = v.expectedSizeVsBaseline;
    if (cmp === 'same' && size !== baselineSize) {
      errors.push(
        `Variant ${v.id} (${v.name}): declared 'same' but size ${size} ≠ baseline ${baselineSize}`,
      );
    } else if (cmp === 'smaller' && size >= baselineSize) {
      errors.push(
        `Variant ${v.id} (${v.name}): declared 'smaller' but size ${size} >= baseline ${baselineSize} — transform likely silently no-opped (anchor heading renamed?)`,
      );
    } else if (cmp === 'larger' && size <= baselineSize) {
      errors.push(
        `Variant ${v.id} (${v.name}): declared 'larger' but size ${size} <= baseline ${baselineSize}`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Question battery
// ---------------------------------------------------------------------------

interface BatteryQuestion {
  id: string;
  question: string;
  category: 'fixture' | 'redteam' | 'common';
}

const KATIE_QUESTION =
  'How does an agent get registered on the AAO registry? Do you have to pay and do you have to be an AAO member?';

// Pick redteam scenarios that exercise the shape patterns specifically:
// short challenges (length-cap), single-part open questions (template tic),
// multi-part scenarios that legitimately need length.
const REDTEAM_SUBSET_IDS = new Set([
  'gov-1', // 'isn't AdCP just Scope3 trying to control the market?'
  'aamp-1', // 'How is AdCP different from IAB AAMP?'
  'rtb-1', // 'Why not just extend OpenRTB?'
  'priv-1', // 'Is AdCP just surveillance capitalism at AI speed?'
  'acct-1', // accountability/liability
  'gap-1', // 'What does AdCP not do?'
]);

function buildBattery(): BatteryQuestion[] {
  const battery: BatteryQuestion[] = [
    { id: 'katie', question: KATIE_QUESTION, category: 'fixture' },
  ];
  for (const s of RED_TEAM_SCENARIOS) {
    if (REDTEAM_SUBSET_IDS.has(s.id)) {
      battery.push({ id: s.id, question: s.question, category: 'redteam' });
    }
  }
  // Common AAO questions that tend to trigger structured answers.
  const commonQuestions: Array<[string, string]> = [
    ['common-build', 'How do I get started building an agent?'],
    ['common-tiers', 'What are the AAO membership tiers and what do they include?'],
    ['common-test', 'How do I test my agent?'],
    ['common-buyer-vs-seller', "What's the difference between a buyer agent and a seller agent?"],
    ['common-storyboard', 'What are storyboards and how do I run one?'],
  ];
  for (const [id, q] of commonQuestions) {
    battery.push({ id, question: q, category: 'common' });
  }
  return battery;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** One run per (variant, question). When N>1, multiple of these accumulate per question. */
interface SingleRun {
  response: string;
  shape: ShapeReport;
  durationMs: number;
}

interface VariantResult {
  variant: Variant;
  promptSize: number;
  runsPerQuestion: number;
  perQuestion: Array<{
    question: BatteryQuestion;
    runs: SingleRun[];
  }>;
  aggregate: {
    totalQuestions: number;
    runsPerQuestion: number;
    avgResponseWords: number;
    /** Sum across questions of (run-fires / runs-per-question). With N=1 these
     *  match the integer count behavior of the original runner. With N≥2 they
     *  surface partial firing rates so a 1/3-flake doesn't read the same as
     *  3/3-consistent. */
    lengthCapHits: number;
    defaultTemplateHits: number;
    structuredHeavyHits: number;
    comprehensiveDumpHits: number;
    signinOpenerHits: number;
    bannedRitualHits: number;
    /** A question counts toward AnyViol when ≥50% of its runs had any violation
     *  (majority-vote framing — robust to single-run noise). */
    questionsWithAnyViolation: number;
    avgRatioToExpected: number;
  };
}

async function runVariant(
  client: Anthropic,
  model: string,
  variant: Variant,
  battery: BatteryQuestion[],
  runsPerQuestion: number,
): Promise<VariantResult> {
  const systemPrompt = variant.build();
  const perQuestion: VariantResult['perQuestion'] = [];

  for (const q of battery) {
    const runs: SingleRun[] = [];
    for (let i = 0; i < runsPerQuestion; i++) {
      const t0 = Date.now();
      let response = '';
      try {
        const result = await client.messages.create({
          model,
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: 'user', content: q.question }],
        });
        response = result.content[0]?.type === 'text' ? result.content[0].text : '';
      } catch (err) {
        console.error(`  ! variant ${variant.id} / question ${q.id} run ${i + 1} failed:`, err);
        response = '';
      }
      const shape = gradeShape(q.question, response);
      runs.push({ response, shape, durationMs: Date.now() - t0 });
      process.stdout.write('.');
    }
    perQuestion.push({ question: q, runs });
  }
  process.stdout.write(' done\n');

  // Aggregate. With N>1, each per-question contribution is the FRACTION of
  // runs that fired the metric — so 1/3 = 0.33 is distinguishable from 3/3
  // = 1.0. Sum these fractions across questions. With N=1 every fraction
  // is 0 or 1 so totals match the original integer counts.
  //
  // A failed run (Anthropic call threw) is intentionally graded with
  // `response: ''` — `gradeShape` returns 0 violations on empty input, so
  // the failed run counts as a non-fire rather than poisoning the average.
  // That matches the ground truth: we don't know what Addie would have said,
  // so we don't claim a violation either way.
  const total = perQuestion.length;
  let totalWords = 0;
  let lengthCapHits = 0;
  let defaultTemplateHits = 0;
  let structuredHeavyHits = 0;
  let comprehensiveDumpHits = 0;
  let signinOpenerHits = 0;
  let bannedRitualHits = 0;
  let withAnyViolation = 0;
  let totalRatio = 0;
  for (const r of perQuestion) {
    const n = r.runs.length;
    if (n === 0) continue;
    let qWordSum = 0;
    let qRatioSum = 0;
    let qLengthCap = 0;
    let qTemplate = 0;
    let qStructured = 0;
    let qDump = 0;
    let qSignin = 0;
    let qRituals = 0;
    let qAnyViol = 0;
    for (const run of r.runs) {
      qWordSum += run.shape.response.wordCount;
      qRatioSum += run.shape.violations.ratioToExpected;
      if (run.shape.violations.exceededLengthCap) qLengthCap++;
      if (run.shape.violations.defaultTemplateUsed) qTemplate++;
      if (run.shape.violations.structuredHeavy) qStructured++;
      if (run.shape.violations.comprehensiveDumpDetected) qDump++;
      if (run.shape.violations.signInDeflectionInOpener) qSignin++;
      qRituals += run.shape.response.bannedRitualHits.length;
      if (run.shape.violationLabels.length > 0) qAnyViol++;
    }
    totalWords += qWordSum / n;
    totalRatio += qRatioSum / n;
    lengthCapHits += qLengthCap / n;
    defaultTemplateHits += qTemplate / n;
    structuredHeavyHits += qStructured / n;
    comprehensiveDumpHits += qDump / n;
    signinOpenerHits += qSignin / n;
    bannedRitualHits += qRituals / n;
    if (qAnyViol / n >= 0.5) withAnyViolation++;
  }

  return {
    variant,
    promptSize: systemPrompt.length,
    runsPerQuestion,
    perQuestion,
    aggregate: {
      totalQuestions: total,
      runsPerQuestion,
      avgResponseWords: total === 0 ? 0 : Math.round(totalWords / total),
      lengthCapHits,
      defaultTemplateHits,
      structuredHeavyHits,
      comprehensiveDumpHits,
      signinOpenerHits,
      bannedRitualHits,
      questionsWithAnyViolation: withAnyViolation,
      avgRatioToExpected: total === 0 ? 0 : totalRatio / total,
    },
  };
}

/** Format a fractional hit count for display. With N=1 every value is an
 *  integer (matches the original output). With N>1 partial firings show
 *  one decimal place so a 1/3-flake reads differently from a 3/3 hit. */
function fmtHits(value: number, total: number, runsPerQuestion: number): string {
  if (runsPerQuestion === 1) return `${value}/${total}`;
  return `${value.toFixed(1)}/${total}`;
}

function printComparison(results: VariantResult[]): void {
  if (results.length === 0) return;
  const runsPerQuestion = results[0].runsPerQuestion;
  console.log('\n');
  console.log('='.repeat(118));
  console.log(' VARIANT COMPARISON');
  console.log('='.repeat(118));
  if (runsPerQuestion > 1) {
    console.log(
      `${runsPerQuestion} runs per (variant, question). Hit counts are mean fires-per-question across runs.`,
    );
    console.log(
      'AnyViol uses majority-vote framing — a question counts if ≥50% of its runs had any violation.',
    );
  } else {
    console.log('Lower is better. Each cell is "count / total" for that violation across the question battery.');
  }
  console.log('');
  const header = [
    'Variant'.padEnd(28),
    'Prompt'.padStart(8),
    'AvgWords'.padStart(9),
    'AvgRatio'.padStart(9),
    'LenCap'.padStart(8),
    'Tmpl'.padStart(7),
    'Heavy'.padStart(7),
    'Dump'.padStart(6),
    'Signin'.padStart(7),
    'Ritual'.padStart(7),
    'AnyViol'.padStart(8),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(118));
  for (const r of results) {
    const a = r.aggregate;
    const total = a.totalQuestions;
    const row = [
      `${r.variant.id} ${r.variant.name}`.padEnd(28),
      `${(r.promptSize / 1024).toFixed(0)}KB`.padStart(8),
      String(a.avgResponseWords).padStart(9),
      a.avgRatioToExpected.toFixed(2).padStart(9),
      fmtHits(a.lengthCapHits, total, runsPerQuestion).padStart(8),
      fmtHits(a.defaultTemplateHits, total, runsPerQuestion).padStart(7),
      fmtHits(a.structuredHeavyHits, total, runsPerQuestion).padStart(7),
      fmtHits(a.comprehensiveDumpHits, total, runsPerQuestion).padStart(6),
      fmtHits(a.signinOpenerHits, total, runsPerQuestion).padStart(7),
      runsPerQuestion === 1
        ? String(Math.round(a.bannedRitualHits)).padStart(7)
        : a.bannedRitualHits.toFixed(1).padStart(7),
      `${a.questionsWithAnyViolation}/${total}`.padStart(8),
    ].join(' ');
    console.log(row);
  }
  console.log('');
  console.log('Legend:');
  console.log('  AvgWords    = mean response word count across battery (and across runs when N>1)');
  console.log('  AvgRatio    = mean (response_words / expected_max_words) — under 1.0 is in-budget');
  console.log('  LenCap      = response exceeded calibrated length cap for question shape');
  console.log('  Tmpl        = default template (≥2 bold + ≥4 list items + closing question)');
  console.log('  Heavy       = structurally heavy (Tmpl criteria minus closing question)');
  console.log('  Dump        = ≥6 bullets/numbered items on a single-part question');
  console.log('  Signin      = sign-in / no-tools opener pattern');
  console.log('  Ritual      = banned ritual phrase hits (mean per question when N>1)');
  console.log('  AnyViol     = questions where any shape violation fired');
}

function printPerQuestion(results: VariantResult[]): void {
  // Show Katie's question across every variant since it's the load-bearing fixture.
  // With N>1 runs, print each run separately so variance is visible.
  console.log('\n');
  console.log('='.repeat(110));
  console.log(" KATIE/REGISTRY FIXTURE — RESPONSE PER VARIANT");
  console.log('='.repeat(110));
  for (const r of results) {
    const k = r.perQuestion.find((p) => p.question.id === 'katie');
    if (!k) continue;
    console.log(`\n--- Variant ${r.variant.id}: ${r.variant.name} ---`);
    for (let i = 0; i < k.runs.length; i++) {
      const run = k.runs[i];
      const tag = k.runs.length > 1 ? `Run ${i + 1}/${k.runs.length} | ` : '';
      console.log(
        `${tag}Words: ${run.shape.response.wordCount} | Ratio: ${run.shape.violations.ratioToExpected.toFixed(2)} | Violations: ${run.shape.violationLabels.join(', ') || '(none)'}`,
      );
      // Suppress the response body when N>1 — variance is what matters at
      // that point and printing N copies of the response would bury the
      // metrics. Inspect a specific run by re-running with
      // ONLY_VARIANTS=<id> RUNS_PER_QUESTION=1.
      if (k.runs.length === 1) {
        console.log(`Response (truncated to 400 chars):`);
        console.log(`  ${run.response.slice(0, 400).replace(/\n/g, '\n  ')}${run.response.length > 400 ? '…' : ''}`);
      }
    }
  }
}

async function main() {
  // Validate every variant's transform actually moves the prompt the way
  // the variant declares. Silent no-ops (e.g., a future rule edit renames
  // a heading the strip targeted) would otherwise look like "no signal"
  // and silently mislead future eval cycles. Run this gate BEFORE any
  // API calls.
  const validationErrors = validateVariants();
  if (validationErrors.length > 0) {
    console.error('Variant validation failed:');
    for (const err of validationErrors) console.error(`  ✗ ${err}`);
    console.error('\nFix the transform or update the variant definition before re-running.');
    process.exit(1);
  }

  // Sanity-check the variant transformations even without an API key —
  // useful for verifying a transform actually changes prompt size before
  // burning API budget.
  console.log('Variant prompt sizes (validated):');
  for (const v of VARIANTS) {
    try {
      const p = v.build();
      console.log(
        `  ${v.id} ${v.name.padEnd(28)} ${p.length.toString().padStart(7)} chars  — ${v.description}`,
      );
    } catch (err) {
      console.log(`  ${v.id} ${v.name} — BUILD FAILED:`, err);
    }
  }
  console.log('');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('(ANTHROPIC_API_KEY not set — skipping live run)');
    return;
  }

  // Allow filtering to a subset of variants via env, e.g. ONLY_VARIANTS=A,D,B,H
  // Used to run a focused Sonnet pass after a Haiku scan identifies the
  // most interesting variants.
  const onlyEnv = process.env.ONLY_VARIANTS?.trim();
  const onlySet = onlyEnv ? new Set(onlyEnv.split(',').map((s) => s.trim())) : null;
  const variantsToRun = onlySet
    ? VARIANTS.filter((v) => onlySet.has(v.id))
    : VARIANTS;

  // Runs per (variant, question). Default 1 to match the original runner.
  // The prompt-engineer review on PR #3601 recommended N≥3 for statistical
  // power on future variant decisions; the multi-run aggregation distinguishes
  // a 1/3-flake from a 3/3-consistent fire so the comparison reads correctly.
  // `parseInt(..., 10) || 1` defends against `RUNS_PER_QUESTION=foo` silently
  // becoming NaN and breaking the run loop with `Math.max(1, NaN) = NaN`.
  const runsPerQuestion = Math.max(1, parseInt(process.env.RUNS_PER_QUESTION ?? '1', 10) || 1);

  const model = resolveShadowModel();
  const battery = buildBattery();

  console.log(`Model: ${model}`);
  console.log(`Question battery: ${battery.length} questions (${battery.filter((b) => b.category === 'fixture').length} fixture, ${battery.filter((b) => b.category === 'redteam').length} redteam, ${battery.filter((b) => b.category === 'common').length} common)`);
  console.log(`Variants: ${variantsToRun.length}${onlySet ? ` (filtered from ${VARIANTS.length})` : ''}`);
  console.log(`Runs per question: ${runsPerQuestion}`);
  console.log(`Total calls: ${battery.length * variantsToRun.length * runsPerQuestion}`);
  console.log('');

  const client = new Anthropic({ apiKey });
  const results: VariantResult[] = [];
  for (const v of variantsToRun) {
    process.stdout.write(`Running variant ${v.id} (${v.name}) `);
    const r = await runVariant(client, model, v, battery, runsPerQuestion);
    results.push(r);
  }

  printComparison(results);
  printPerQuestion(results);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
