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
  type FixedTraceCohortStageControl,
  type FixedTraceModelStageMetadata,
  type FixedTracePricing,
  type FixedTraceRunMetadata,
} from './fixed-trace-suite.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  fixedTraceEstimatedCostUsd,
} from './fixed-trace-budget.js';

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
  readonly budget: FixedTraceBudget;
  readonly outputReservation: FixedTraceDiagnosticOutputReservation;
  readonly runRootId: string;
  readonly runStartedAt: string;
  readonly sourceBundleFiles: readonly string[];
  readonly budgetNote: string;
}

type RequestedStageConfig = ReturnType<typeof requestedStageConfig>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotStageConfig(config: FixedTraceProviderStageConfig): FixedTraceProviderStageConfig {
  return Object.freeze({ ...config, pricing: deepFreeze(structuredClone(config.pricing)) });
}

function snapshotBaseConfig(
  config: FixedTraceDiagnosticArtifactOptions['baseConfig'],
): FixedTraceDiagnosticArtifactOptions['baseConfig'] {
  return Object.freeze({
    ...config,
    traceSuite: deepFreeze(structuredClone(config.traceSuite)),
    toolDefinitions: deepFreeze(structuredClone(config.toolDefinitions)),
  });
}

function snapshotPlans(
  suppliedPlans: readonly FixedTraceDiagnosticProviderPlan[],
  budget: FixedTraceBudget,
): readonly FixedTraceDiagnosticProviderPlan[] {
  if (!Array.isArray(suppliedPlans) || suppliedPlans.length === 0) {
    throw new Error('Fixed trace diagnostic run requires one or more provider plans');
  }
  const names = new Set<string>();
  const plans = suppliedPlans.map((plan) => {
    if (
      typeof plan.name !== 'string'
      || plan.name.trim().length === 0
      || names.has(plan.name)
      || plan.name !== plan.router?.provider?.id
      || plan.name !== plan.generation?.provider?.id
      || !(plan.router.provider instanceof BudgetedFixedTraceProvider)
      || !(plan.generation.provider instanceof BudgetedFixedTraceProvider)
      || !plan.router.provider.isBoundToBudget(budget)
      || !plan.generation.provider.isBoundToBudget(budget)
    ) throw new Error('Fixed trace diagnostic provider plans require unique names matching both stage providers');
    names.add(plan.name);
    // Providers are live capabilities and deliberately stay by reference;
    // every serializable stage control is cloned before the first await.
    return Object.freeze({
      name: plan.name,
      router: snapshotStageConfig(plan.router),
      generation: snapshotStageConfig(plan.generation),
    });
  });
  return Object.freeze(plans);
}

function snapshotNonblank(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Fixed trace diagnostic ${name} must be nonblank`);
  }
  return value;
}

function snapshotSourceBundleFiles(files: readonly string[]): readonly string[] {
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string' || !file.trim())) {
    throw new Error('Fixed trace diagnostic source bundle files must be nonempty strings');
  }
  if (new Set(files).size !== files.length) {
    throw new Error('Fixed trace diagnostic source bundle files must be unique');
  }
  return Object.freeze([...files]);
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

function samePricing(left: FixedTracePricing, right: FixedTracePricing): boolean {
  return left.profileId === right.profileId
    && left.inputUsdPerMillionTokens === right.inputUsdPerMillionTokens
    && left.outputUsdPerMillionTokens === right.outputUsdPerMillionTokens
    && left.cacheReadUsdPerMillionTokens === right.cacheReadUsdPerMillionTokens
    && left.cacheWriteUsdPerMillionTokens === right.cacheWriteUsdPerMillionTokens
    && left.cacheReadAccounting === right.cacheReadAccounting
    && left.cacheWriteAccounting === right.cacheWriteAccounting
    && left.source === right.source;
}

function requestedStageMatchesControl(
  requested: RequestedStageConfig,
  control: FixedTraceCohortStageControl,
): boolean {
  return requested.provider === control.requestedProvider
    && requested.model === control.requestedModel
    && requested.reasoningEffort === control.reasoningEffort
    && requested.maxOutputTokens === control.configuredMaxOutputTokens
    && requested.timeoutMs === control.timeoutMs
    && requested.maxIterations === control.maxIterations
    && samePricing(requested.pricing, control.pricing);
}

function assertStageCost(stage: FixedTraceModelStageMetadata, control: FixedTraceCohortStageControl): void {
  if (!stage.dispatched || !stage.usageKnown || stage.usage === null) return;
  // An unapproved returned model is deliberately recorded with unknown cost;
  // it is a coherent diagnostic failure, not a contradictory artifact.
  if (stage.source === 'provider' && stage.estimatedCostUsd === null) {
    if (stage.pricingProfileId !== null || stage.pricingSource !== null) {
      throw new Error('Fixed trace diagnostic artifact has partial unknown-cost provenance');
    }
    return;
  }
  if (
    stage.estimatedCostUsd === null
    || stage.pricingProfileId !== control.pricing.profileId
    || stage.pricingSource !== control.pricing.source
  ) throw new Error('Fixed trace diagnostic artifact has incomplete dispatched stage cost evidence');
  if (stage.estimatedCostUsd !== fixedTraceEstimatedCostUsd(stage.usage, control.pricing)) {
    throw new Error('Fixed trace diagnostic artifact stage cost does not match recorded usage and pricing');
  }
}

function sameArtifactRunMetadata(left: FixedTraceRunMetadata, right: FixedTraceRunMetadata): boolean {
  return left.traceSuiteVersion === right.traceSuiteVersion
    && left.traceSuiteSha256 === right.traceSuiteSha256
    && left.sourceBundleSha256 === right.sourceBundleSha256
    && left.gitCommit === right.gitCommit
    && left.gitDirty === right.gitDirty
    && left.addieCodeVersion === right.addieCodeVersion
    && left.promptConfigVersion === right.promptConfigVersion
    && left.toolSchemaSha256 === right.toolSchemaSha256
    && left.toolDefinitionProvenance === right.toolDefinitionProvenance
    && left.stageControlVersion === right.stageControlVersion
    && left.providerDegradationInjectionEnabled === right.providerDegradationInjectionEnabled
    && left.repetition === right.repetition
    && left.architectureArm.id === right.architectureArm.id
    && left.architectureArm.routeSource === right.architectureArm.routeSource
    && left.architectureArm.rolloutEligible === right.architectureArm.rolloutEligible
    && left.executionEnvelope.source === right.executionEnvelope.source
    && left.executionEnvelope.deployable === right.executionEnvelope.deployable;
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
  // Snapshot every serializable claim before provider code can run. Provider,
  // budget, and reservation objects remain live capabilities by reference.
  const baseConfig = snapshotBaseConfig(options.baseConfig);
  const budgetLedger = options.budget;
  const plans = snapshotPlans(options.plans, budgetLedger);
  const runRootId = snapshotNonblank(options.runRootId, 'run root ID');
  const runStartedAt = snapshotNonblank(options.runStartedAt, 'run start time');
  const sourceBundleFiles = snapshotSourceBundleFiles(options.sourceBundleFiles);
  const budgetNote = snapshotNonblank(options.budgetNote, 'budget note');
  const outputReservation = options.outputReservation;
  const plannedRuns = Object.freeze(plans.map((plan) => Object.freeze({
    plan,
    runId: snapshotNonblank(options.runIdForProvider(plan.name), 'run ID'),
  })));
  const candidateRuns = [];
  for (const { plan, runId } of plannedRuns) {
    const config: FixedTraceRunnerConfig = {
      ...baseConfig,
      runId,
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

  const budget = budgetLedger.snapshot();
  const runs = candidateRuns.map((run) => ({
    ...run,
    diagnosticOnly: true as const,
    promotionBlocker: 'trusted_evaluator_context_unavailable' as const,
    promotionEvidenceEligible: false,
    rollout: null,
  }));
  const commonMetadata = runs[0]?.observations[0]?.metadata;
  if (!commonMetadata) throw new Error('Fixed trace diagnostic artifact has no observations');
  if (
    commonMetadata.traceSuiteSha256 !== baseConfig.traceSuiteSha256
    || commonMetadata.repetition !== (baseConfig.repetition ?? 1)
  ) throw new Error('Fixed trace diagnostic artifact does not match its frozen run plan');
  for (const run of runs) {
    const metadata = run.observations[0]?.metadata;
    if (
      !metadata
      || run.observations.length !== baseConfig.traceSuite.length
      || !sameArtifactRunMetadata(commonMetadata, metadata)
      || !requestedStageMatchesControl(run.requestedConfig.router, metadata.routerControl)
      || !requestedStageMatchesControl(run.requestedConfig.generation, metadata.generationControl)
      || run.summary.cohort.architectureConfigSha256 !== metadata.architectureConfigSha256
      || run.summary.diagnosticOnly !== true
      || run.summary.comparisonEligible !== false
    ) throw new Error('Fixed trace diagnostic artifact run metadata is inconsistent');
    for (const observation of run.observations) {
      if (!sameArtifactRunMetadata(commonMetadata, observation.metadata)) {
        throw new Error('Fixed trace diagnostic artifact observations disagree across planned runs');
      }
      assertStageCost(observation.metadata.router, observation.metadata.routerControl);
      assertStageCost(observation.metadata.generation, observation.metadata.generationControl);
    }
  }
  const toolSchemaSha256 = commonMetadata.toolSchemaSha256;
  const artifact = {
    artifactVersion: 'fixed_trace_provider_eval_v4',
    runRootId,
    runStartedAt,
    runCompletedAt: new Date().toISOString(),
    traceSuiteVersion: commonMetadata.traceSuiteVersion,
    traceSuiteSha256: commonMetadata.traceSuiteSha256,
    traceCount: baseConfig.traceSuite.length,
    sourceBundleSha256: commonMetadata.sourceBundleSha256,
    sourceBundleFiles,
    gitCommit: commonMetadata.gitCommit,
    gitDirty: commonMetadata.gitDirty,
    addieCodeVersion: commonMetadata.addieCodeVersion,
    promptConfigVersion: commonMetadata.promptConfigVersion,
    toolSchemaSha256,
    architectureConfigSha256ByProvider: Object.fromEntries(runs.map((run) => [
      run.provider,
      run.observations[0]?.metadata.architectureConfigSha256 ?? null,
    ])),
    architectureArm: fixedTraceArchitectureArm(commonMetadata.architectureArm.id),
    toolUniverse: fixedTraceToolUniverseProvenance(commonMetadata.architectureArm.id),
    executionEnvelope: fixedTraceExecutionEnvelopeProvenance(commonMetadata.architectureArm.id),
    requestedProviders: plans.map((plan) => plan.name),
    requestedArchitectureArm: commonMetadata.architectureArm.id,
    repetition: commonMetadata.repetition,
    diagnosticOnly: true as const,
    promotionBlocker: 'trusted_evaluator_context_unavailable' as const,
    judgeDispatch: 'blocked_pending_trusted_evaluator_owned_coordinator' as const,
    budget,
    promotionEvidenceEligible: false,
    promotionBudget: null,
    diagnosticBudget: budget,
    budgetNote,
    complete: runs.every((run) => run.summary.complete),
    comparisonEligible: false,
    promotionRunCount: 0,
    rolloutPass: false,
    runs,
  };
  outputReservation.finalize(`${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
