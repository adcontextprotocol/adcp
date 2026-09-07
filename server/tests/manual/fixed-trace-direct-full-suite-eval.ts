/** One exact, direct-only current-suite candidate per invocation. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CELLS = [
  'generation:anthropic:claude-sonnet-5:provider_default', 'generation:anthropic:claude-haiku-4-5:provider_default',
  'generation:google:gemini-3.7-flash:provider_default', 'generation:google:gemini-3.7-flash:low',
  'generation:google:gemini-3.7-flash:medium', 'generation:google:gemini-3.7-flash:high',
] as const;
type CellId = typeof CELLS[number];

interface Arguments {
  readonly validateOnly: boolean;
  readonly execute: boolean;
  readonly cell: CellId;
  readonly softMaxUsd: number;
  readonly output: string;
  readonly selector: string;
}

function value(name: string): string | undefined {
  return process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function parseArguments(): Arguments {
  const values = process.argv.slice(2);
  for (const argument of values) {
    if (argument === '--validate-only' || argument === '--execute' || argument.startsWith('--cell=') || argument.startsWith('--soft-max-usd=') || argument.startsWith('--output=') || argument.startsWith('--selector=')) continue;
    throw new Error(`Unsupported fixed-trace direct full-suite option: ${argument}`);
  }
  const validateOnly = values.includes('--validate-only');
  const execute = values.includes('--execute');
  if (validateOnly === execute) throw new Error('Specify exactly one of --validate-only or --execute');
  const cell = value('--cell');
  const softMaxUsd = Number(value('--soft-max-usd'));
  const output = value('--output');
  const selector = value('--selector');
  if (!cell || !output?.trim() || !selector?.trim() || !Number.isFinite(softMaxUsd) || softMaxUsd <= 0) {
    throw new Error('--cell, positive --soft-max-usd, --output, and --selector are required');
  }
  if (!(CELLS as readonly string[]).includes(cell)) throw new Error('Fixed trace direct full-suite comparison cell is unsupported');
  for (const name of ['--cell=', '--soft-max-usd=', '--output=', '--selector=']) {
    if (values.filter((argument) => argument.startsWith(name)).length !== 1) throw new Error(`Exactly one ${name.slice(2, -1)} value is required`);
  }
  return { validateOnly, execute, cell: cell as CellId, softMaxUsd, output, selector };
}

const arguments_ = parseArguments();
// No evaluator module (and therefore no application startup side effect) is
// imported before the parser has rejected malformed CLI input.
// This artifact protocol reserves stdout for its single machine-readable
// record; evaluator startup logs must not interleave with it.
process.env.LOG_LEVEL = 'silent';
const fullSuite = await import('../../src/addie/eval/fixed-trace-direct-full-suite.js');
const runner = await import('../../src/addie/eval/fixed-trace-runner.js');
const budgetModule = await import('../../src/addie/eval/fixed-trace-budget.js');
const pricingModule = await import('../../src/addie/eval/dated-pricing-cohort.js');
const cell = fullSuite.fixedTraceDirectFullSuiteCell(arguments_.cell);
const sources = fullSuite.fixedTraceDirectFullSuiteSourceBundle([
  'server/src/addie/eval/fixed-trace-direct-full-suite.ts', 'server/src/addie/eval/fixed-trace-runner.ts',
  'server/src/addie/eval/fixed-trace-suite.ts', 'server/src/addie/eval/fixed-trace-tool-loop.ts',
  'server/src/addie/eval/fixed-trace-budget.ts', 'server/src/addie/eval/fixed-trace-tools.ts', 'server/src/addie/eval/fixed-trace-direct-full-suite-judge.ts',
  'server/tests/manual/fixed-trace-direct-full-suite-eval.ts',
]);
const promptConfigVersion = createHash('sha256').update(readFileSync('server/src/addie/prompts.ts'))
  .update(readFileSync('server/src/addie/rules/index.ts')).digest('hex');
const plan = fullSuite.fixedTraceDirectFullSuitePlan({
  cellId: cell.id, sourceFiles: sources.files, sourceBundleSha256: sources.sha256,
  promptConfigVersion, softMaxUsd: arguments_.softMaxUsd,
});
fullSuite.assertFixedTraceDirectFullSuiteCostCeiling(cell.id, arguments_.softMaxUsd);
if (arguments_.validateOnly) {
  console.log(JSON.stringify({ validateOnly: true, providerCalls: 0, outputWritten: false, selectorConsumed: false, plan }));
  process.exit(0);
}
if (existsSync(arguments_.selector) || existsSync(arguments_.output) || existsSync(`${arguments_.output}.sha256`)) {
  throw new Error('Selector or output already exists; this configuration is one-shot');
}
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Git source drift: execute only from an exact clean reviewed head');
if (readFileSync('.git/HEAD', 'utf8').length === 0) throw new Error('Git source identity is unavailable');
const budget = new budgetModule.FixedTraceBudget(arguments_.softMaxUsd);
async function providerFor(id: 'anthropic' | 'google' | 'openai') {
  if (id === 'anthropic') {
    const apiKey = fullSuite.fixedTraceDirectFullSuiteAnthropicApiKey(process.env);
    if (!apiKey) throw new Error('ADDIE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY is required for candidate or judge');
    const { AnthropicModelProvider } = await import('../../src/addie/model-providers/anthropic-provider.js');
    return new AnthropicModelProvider(apiKey, undefined, { transportMaxRetries: 0 });
  }
  if (id === 'google') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for candidate or judge');
    const { GoogleGenerateContentProvider } = await import('../../src/addie/model-providers/google-generate-content-provider.js');
    return new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY);
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for candidate or judge');
  const { OpenAIResponsesProvider } = await import('../../src/addie/model-providers/openai-responses-provider.js');
  return new OpenAIResponsesProvider(process.env.OPENAI_API_KEY);
}
function budgetedProvider(provider: Awaited<ReturnType<typeof providerFor>>, model: string) {
  const pricing = pricingModule.datedPricingProfilesForFixedTrace().find((candidate) => candidate.provider === provider.id && candidate.model === model);
  if (!pricing) throw new Error('Current reviewed pricing is unavailable for selected provider identity');
  return new budgetModule.BudgetedFixedTraceProvider(provider, budget, pricing, budgetModule.fixedTraceResponsePricingPolicy(provider.id, model, pricing));
}
const rawCandidate = await providerFor(cell.provider);
const rawJudges = Object.fromEntries(await Promise.all(cell.judgeProviders.map(async (id) => [id, await providerFor(id)]))) as Record<'anthropic' | 'google' | 'openai', Awaited<ReturnType<typeof providerFor>>>;
const candidateProvider = budgetedProvider(rawCandidate, cell.model);
const judgeProviders = Object.fromEntries(cell.judgeProviders.map((id) => [id, budgetedProvider(rawJudges[id]!, id === 'anthropic' ? 'claude-haiku-4-5' : id === 'google' ? 'gemini-3.7-flash' : 'gpt-5.6-luna')]));
const candidateConfig = fullSuite.fixedTraceDirectFullSuiteConfig({
  runId: `direct-full-suite-${cell.id}-${Date.now()}`, sourceBundleSha256: sources.sha256,
  gitCommit: fullSuite.fixedTraceDirectFullSuiteGitCommit(), provider: candidateProvider, cellId: cell.id, promptConfigVersion,
});
runner.preflightFixedTraceRunnerConfig(candidateConfig);
// This is the actual all-call escrow, not merely the numeric preflight. It
// must happen before either durable one-shot identity is consumed.
const admission = fullSuite.admitFixedTraceDirectFullSuiteComparison({ candidate: candidateConfig, judgeProviders, budget });
let output: ReturnType<typeof fullSuite.reserveFixedTraceDirectFullSuiteOutput> | null = null;
try {
  fullSuite.consumeFixedTraceDirectFullSuiteSelector(arguments_.selector, { cellId: cell.id, sourceBundleSha256: sources.sha256, promptConfigVersion });
  output = fullSuite.reserveFixedTraceDirectFullSuiteOutput(arguments_.output);
  const result = await fullSuite.runFixedTraceDirectFullSuiteComparisonArtifact({ candidate: candidateConfig, judgeProviders, budget, admission });
  const { evaluateFixedTraceRollout } = await import('../../src/addie/eval/fixed-trace-rollout.js');
  const artifact = { artifactVersion: 'addie-fixed-trace-direct-full-suite-v1', plan, budget: budget.snapshot(), result, rollout: evaluateFixedTraceRollout(result.summary, result.judgeSummary, budget.snapshot()) };
  const artifactSha256 = output.finalize(artifact);
  console.log(JSON.stringify({ output: arguments_.output, artifactSha256, comparisonComplete: result.summary.complete, plan }));
} catch (error) {
  if (output === null) {
    admission.release();
    throw error;
  }
  const artifactSha256 = output.finalize({ artifactVersion: 'addie-fixed-trace-direct-full-suite-v1', plan, budget: budget.snapshot(), failure: error instanceof Error ? error.message : String(error) });
  throw new Error(`Fixed trace direct full-suite comparison failed; preserved artifact ${arguments_.output} (${artifactSha256})`, { cause: error });
}
