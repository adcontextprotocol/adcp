import {
  runFixedTraceSuite,
  type FixedTraceRunnerConfig,
  type FixedTraceProviderStageConfig,
} from './fixed-trace-runner.js';
import {
  fixedTraceArchitectureArm,
  fixedTraceExecutionEnvelopeProvenance,
  fixedTraceToolUniverseProvenance,
} from './fixed-trace-architecture.js';
import {
  summarizeFixedTraceRun,
  type FixedTracePricing,
} from './fixed-trace-suite.js';

export interface FixedTraceDiagnosticProviderPlan {
  readonly name: string;
  readonly router: FixedTraceProviderStageConfig;
  readonly generation: FixedTraceProviderStageConfig;
}

export interface FixedTraceDiagnosticOutputReservation {
  finalize(content: string): void;
}

interface FixedTraceDiagnosticArtifactOptions {
  readonly plans: readonly FixedTraceDiagnosticProviderPlan[];
  readonly baseConfig: Omit<FixedTraceRunnerConfig, 'runId' | 'router' | 'generation'>;
  readonly runIdForProvider: (provider: string) => string;
  readonly budget: { snapshot(): unknown };
  readonly outputReservation: FixedTraceDiagnosticOutputReservation;
  readonly artifactVersion: string;
  readonly runRootId: string;
  readonly runStartedAt: string;
  readonly traceSuiteVersion: string;
  readonly addieCodeVersion: string;
  readonly sourceBundleFiles: readonly string[];
  readonly budgetNote: string;
}

function requestedStageConfig(stage: FixedTraceProviderStageConfig): {
  provider: string;
  model: string;
  reasoningEffort: FixedTraceProviderStageConfig['reasoningEffort'];
  maxOutputTokens: number;
  timeoutMs: number;
  maxIterations: number;
  pricing: FixedTracePricing;
} {
  return {
    provider: stage.provider.id,
    model: stage.model,
    reasoningEffort: stage.reasoningEffort,
    maxOutputTokens: stage.maxOutputTokens,
    timeoutMs: stage.timeoutMs,
    maxIterations: stage.maxIterations,
    pricing: stage.pricing,
  };
}

/**
 * The manual diagnostic entrypoint must execute a complete suite through the
 * guarded wrapper. In particular, this preserves its post-finalization
 * identity check before any summary/artifact can be constructed.
 */
export async function runFixedTraceDiagnosticCandidate(
  config: FixedTraceRunnerConfig,
) {
  const observations = await runFixedTraceSuite(config);
  return {
    ...summarizeFixedTraceRun(observations, config.traceSuite),
    observations,
  };
}

/**
 * The executable diagnostic path owns this loop and finalization boundary.
 * It deliberately builds an artifact only after the guarded suite runner has
 * completed, so post-final-response identity mutations cannot leave behind a
 * falsely complete artifact.
 */
export async function runFixedTraceDiagnosticArtifact(
  options: FixedTraceDiagnosticArtifactOptions,
) {
  const candidateRuns = [];
  for (const plan of options.plans) {
    const config: FixedTraceRunnerConfig = {
      ...options.baseConfig,
      runId: options.runIdForProvider(plan.name),
      router: plan.router,
      generation: plan.generation,
    };
    const evaluated = await runFixedTraceDiagnosticCandidate(config);
    candidateRuns.push({
      provider: plan.name,
      requestedConfig: {
        router: requestedStageConfig(plan.router),
        generation: {
          ...requestedStageConfig(plan.generation),
          truncationMaxOutputTokens: config.traceSuite.find((trace) => (
            trace.caseControl?.kind === 'bounded_generation_output'
          ))?.caseControl?.maxOutputTokens ?? null,
        },
      },
      ...evaluated,
    });
  }

  const budget = options.budget.snapshot();
  const runs = candidateRuns.map((run) => ({
    ...run,
    diagnosticOnly: true as const,
    promotionBlocker: 'trusted_evaluator_context_unavailable' as const,
    promotionEvidenceEligible: false,
    rollout: null,
  }));
  const toolSchemaSha256 = runs[0]?.observations[0]?.metadata.toolSchemaSha256 ?? null;
  const artifact = {
    artifactVersion: options.artifactVersion,
    runRootId: options.runRootId,
    runStartedAt: options.runStartedAt,
    runCompletedAt: new Date().toISOString(),
    traceSuiteVersion: options.traceSuiteVersion,
    traceSuiteSha256: options.baseConfig.traceSuiteSha256,
    traceCount: options.baseConfig.traceSuite.length,
    sourceBundleSha256: options.baseConfig.sourceBundleSha256,
    sourceBundleFiles: options.sourceBundleFiles,
    gitCommit: options.baseConfig.gitCommit,
    gitDirty: options.baseConfig.gitDirty,
    addieCodeVersion: options.addieCodeVersion,
    promptConfigVersion: options.baseConfig.promptConfigVersion,
    toolSchemaSha256,
    architectureConfigSha256ByProvider: Object.fromEntries(runs.map((run) => [
      run.provider,
      run.observations[0]?.metadata.architectureConfigSha256 ?? null,
    ])),
    architectureArm: fixedTraceArchitectureArm(options.baseConfig.architectureArm),
    toolUniverse: fixedTraceToolUniverseProvenance(options.baseConfig.architectureArm),
    executionEnvelope: fixedTraceExecutionEnvelopeProvenance(options.baseConfig.architectureArm),
    requestedProviders: options.plans.map((plan) => plan.name),
    requestedArchitectureArm: options.baseConfig.architectureArm,
    repetition: options.baseConfig.repetition ?? 1,
    diagnosticOnly: true as const,
    promotionBlocker: 'trusted_evaluator_context_unavailable' as const,
    judgeDispatch: 'blocked_pending_trusted_evaluator_owned_coordinator' as const,
    budget,
    promotionEvidenceEligible: false,
    promotionBudget: null,
    diagnosticBudget: budget,
    budgetNote: options.budgetNote,
    complete: runs.every((run) => run.summary.complete),
    comparisonEligible: false,
    promotionRunCount: 0,
    rolloutPass: false,
    runs,
  };
  options.outputReservation.finalize(`${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
