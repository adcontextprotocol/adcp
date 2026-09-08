/** One immutable, paid, synthetic 24-case architecture diagnostic cell. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

interface Arguments {
  readonly validateOnly: boolean;
  readonly execute: boolean;
  readonly output: string | null;
  readonly selector: string | null;
}

function option(name: string): string | undefined {
  return process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function parseArguments(): Arguments {
  const values = process.argv.slice(2);
  for (const argument of values) {
    if (argument === '--validate-only' || argument === '--execute' || argument.startsWith('--output=') || argument.startsWith('--selector=')) continue;
    throw new Error(`Unsupported fixed-trace architecture diagnostic option: ${argument}`);
  }
  const validateOnly = values.includes('--validate-only');
  const execute = values.includes('--execute');
  if (validateOnly === execute) throw new Error('Specify exactly one of --validate-only or --execute');
  if (values.filter((value) => value === '--validate-only').length > 1 || values.filter((value) => value === '--execute').length > 1) {
    throw new Error('Specify exactly one execution mode flag');
  }
  for (const name of ['--output=', '--selector=']) {
    if (values.filter((argument) => argument.startsWith(name)).length > 1) {
      throw new Error(`At most one ${name.slice(2, -1)} value is permitted`);
    }
  }
  const output = option('--output') ?? null;
  const selector = option('--selector') ?? null;
  if (validateOnly && (output !== null || selector !== null)) {
    throw new Error('Validate-only accepts no selector or output path');
  }
  if (execute && (!output?.trim() || !selector?.trim())) {
    throw new Error('--execute requires --output and --selector');
  }
  if (execute) {
    const identities = [resolve(output!), resolve(selector!), resolve(`${output!}.sha256`)];
    if (new Set(identities).size !== identities.length) {
      throw new Error('Selector, artifact, and checksum paths must be distinct');
    }
  }
  return { validateOnly, execute, output, selector };
}

const arguments_ = parseArguments();
// No evaluator/provider module (and no SDK) is loaded until malformed input
// is rejected. Stdout remains a single machine-readable record.
process.env.LOG_LEVEL = 'silent';
const execution = await import('../../src/addie/eval/fixed-trace-architecture-diagnostic-execution.js');
const budgetModule = await import('../../src/addie/eval/fixed-trace-budget.js');
const { AnthropicModelProvider } = arguments_.execute
  ? await import('../../src/addie/model-providers/anthropic-provider.js')
  : { AnthropicModelProvider: null };

const sources = execution.fixedTraceArchitectureDiagnosticSourceBundle([
  'server/src/addie/eval/fixed-trace-architecture-diagnostic-execution.ts',
  'server/src/addie/eval/fixed-trace-architecture-diagnostic.ts',
  'server/src/addie/eval/fixed-trace-architecture.ts',
  'server/src/addie/eval/fixed-trace-budget.ts',
  'server/src/addie/eval/fixed-trace-runner.ts',
  'server/src/addie/eval/fixed-trace-suite.ts',
  'server/src/addie/eval/fixed-trace-tool-loop.ts',
  'server/src/addie/model-providers/anthropic-provider.ts',
  'server/tests/manual/fixed-trace-architecture-diagnostic-eval.ts',
]);
const promptConfigVersion = createHash('sha256').update(readFileSync('server/src/addie/prompts.ts'))
  .update(readFileSync('server/src/addie/rules/index.ts')).digest('hex');
const plan = execution.fixedTraceArchitectureDiagnosticPlan({
  sourceFiles: sources.files,
  sourceBundleSha256: sources.sha256,
  promptConfigVersion,
});

if (arguments_.validateOnly) {
  console.log(JSON.stringify({
    validateOnly: true,
    providerCalls: 0,
    selectorConsumed: false,
    outputWritten: false,
    plan,
  }));
  process.exit(0);
}

if (existsSync(arguments_.selector!) || existsSync(arguments_.output!) || existsSync(`${arguments_.output!}.sha256`)) {
  throw new Error('Selector, artifact, or checksum already exists; this diagnostic cell is one-shot');
}
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error('Git source drift: execute only from an exact clean reviewed head');
}
const gitCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('Git source identity is unavailable');
const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey || !AnthropicModelProvider) throw new Error('ADDIE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY is required');

const ceiling = execution.fixedTraceArchitectureDiagnosticCostCeiling();
const budget = new budgetModule.FixedTraceBudget(ceiling.requiredSoftMaxUsd);
const rawProvider = new AnthropicModelProvider(apiKey, undefined, { transportMaxRetries: 0 });
const controls = (await import('../../src/addie/eval/fixed-trace-architecture-diagnostic.js'))
  .fixedTraceArchitectureDiagnosticPilotStageControls();
const router = new budgetModule.BudgetedFixedTraceProvider(
  rawProvider,
  budget,
  controls.router.pricing,
  budgetModule.fixedTraceResponsePricingPolicy('anthropic', controls.router.model, controls.router.pricing),
);
const generation = new budgetModule.BudgetedFixedTraceProvider(
  rawProvider,
  budget,
  controls.generation.pricing,
  budgetModule.fixedTraceResponsePricingPolicy('anthropic', controls.generation.model, controls.generation.pricing),
);
const runRootId = `architecture-diagnostic-${Date.now()}`;
const runStartedAt = new Date().toISOString();
const admission = execution.admitFixedTraceArchitectureDiagnostic({
  runRootId,
  runStartedAt,
  sourceBundleSha256: sources.sha256,
  gitCommit,
  promptConfigVersion,
  plan,
  router,
  generation,
  budget,
});
let output: ReturnType<typeof execution.reserveFixedTraceArchitectureDiagnosticOutput> | null = null;
let completedArtifact: Awaited<ReturnType<typeof execution.runFixedTraceArchitectureDiagnosticArtifact>> | null = null;
let terminalArtifactFinalized = false;
try {
  // Both evidence identities are durably claimed before the first provider
  // dispatch. A reserved empty file is intentionally retained on a crash.
  output = execution.reserveFixedTraceArchitectureDiagnosticOutput(arguments_.output!);
  execution.consumeFixedTraceArchitectureDiagnosticSelector(arguments_.selector!, {
    sourceBundleSha256: sources.sha256,
    promptConfigVersion,
  });
  completedArtifact = await execution.runFixedTraceArchitectureDiagnosticArtifact({
    admission,
    runRootId,
    runStartedAt,
    plan,
    budget,
  });
  const artifactSha256 = execution.finalizeCompletedFixedTraceArchitectureDiagnosticArtifact(output, completedArtifact);
  terminalArtifactFinalized = true;
  console.log(JSON.stringify({
    output: arguments_.output,
    artifactSha256,
    complete: completedArtifact.complete,
    diagnosticOnly: true,
    comparisonEligible: false,
  }));
  if (!completedArtifact.complete) {
    process.exitCode = 1;
    console.error(`Fixed trace architecture diagnostic did not complete with fully known exposure; preserved artifact ${arguments_.output} (${artifactSha256})`);
  }
} catch (error) {
  if (output === null) {
    admission.release();
    throw error;
  }
  if (completedArtifact !== null && !terminalArtifactFinalized) {
    // The completed artifact was the only correct terminal evidence. Its
    // finalizer has already sealed the reservation, so a setup-failure
    // replacement would overwrite or obscure paid execution evidence.
    const finalizationDetail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(
      `Fixed trace architecture diagnostic completed, but its terminal artifact could not be finalized at ${arguments_.output}; the claimed artifact and checksum paths were retained without replacement. The selector remains consumed and this cell must not be dispatched again.${finalizationDetail}`,
      { cause: error },
    );
  }
  if (completedArtifact !== null) throw error;
  let failureArtifact: ReturnType<typeof execution.fixedTraceArchitectureDiagnosticFailureArtifact>;
  try {
    failureArtifact = execution.fixedTraceArchitectureDiagnosticFailureArtifact(admission, error);
  } catch (failureArtifactError) {
    throw new Error(
      `Fixed trace architecture diagnostic failed after its output and selector were claimed; the selector remains consumed and this cell must not be dispatched again.`,
      { cause: failureArtifactError },
    );
  }
  let artifactSha256: string;
  try {
    artifactSha256 = output.finalize(failureArtifact);
  } catch (finalizationError) {
    throw new Error(
      `Fixed trace architecture diagnostic failed and its failure artifact could not be finalized; the selector remains consumed and this cell must not be dispatched again.`,
      { cause: finalizationError },
    );
  }
  throw new Error(`Fixed trace architecture diagnostic failed; preserved artifact ${arguments_.output} (${artifactSha256})`, { cause: error });
}
