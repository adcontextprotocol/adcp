import {
  preflightFixedTraceRunnerConfig,
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
  FixedTraceBudget,
  claimFixedTraceBudgetDiagnosticLease,
  fixedTraceEstimatedCostUsd,
  fixedTraceResponsePricingPolicy,
  isTrustedBudgetedFixedTraceProvider,
} from './fixed-trace-budget.js';
import { types } from 'node:util';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

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

function ownDataProperty(source: unknown, name: string, owner: string): unknown {
  if (typeof source !== 'object' || source === null) {
    throw new Error(`Fixed trace diagnostic ${owner} must be an object with own data properties`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor || !('value' in descriptor)) {
    throw new Error(`Fixed trace diagnostic ${owner}.${name} must be an own data property`);
  }
  return descriptor.value;
}

function assertClosedOwnDataRecord(source: unknown, fields: readonly string[], owner: string): void {
  if (typeof source !== 'object' || source === null || types.isProxy(source) || Object.getPrototypeOf(source) !== Object.prototype) {
    throw new Error(`Fixed trace diagnostic ${owner} must be a plain non-Proxy object`);
  }
  const keys = Reflect.ownKeys(source);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw new Error(`Fixed trace diagnostic ${owner} must contain exactly its approved fields`);
  }
  for (const field of fields) ownDataProperty(source, field, owner);
}

const DIAGNOSTIC_PRICING_FIELDS = [
  'profileId',
  'inputUsdPerMillionTokens',
  'outputUsdPerMillionTokens',
  'cacheReadUsdPerMillionTokens',
  'cacheWriteUsdPerMillionTokens',
  'cacheReadAccounting',
  'cacheWriteAccounting',
  'source',
] as const;

function snapshotPricing(pricing: unknown, owner: string): FixedTracePricing {
  assertClosedOwnDataRecord(pricing, DIAGNOSTIC_PRICING_FIELDS, owner);
  // Structured cloning calls nested getters. Copy each approved data
  // descriptor instead, so a price cannot change between validation and use.
  return Object.freeze({
    profileId: ownDataProperty(pricing, 'profileId', owner),
    inputUsdPerMillionTokens: ownDataProperty(pricing, 'inputUsdPerMillionTokens', owner),
    outputUsdPerMillionTokens: ownDataProperty(pricing, 'outputUsdPerMillionTokens', owner),
    cacheReadUsdPerMillionTokens: ownDataProperty(pricing, 'cacheReadUsdPerMillionTokens', owner),
    cacheWriteUsdPerMillionTokens: ownDataProperty(pricing, 'cacheWriteUsdPerMillionTokens', owner),
    cacheReadAccounting: ownDataProperty(pricing, 'cacheReadAccounting', owner),
    cacheWriteAccounting: ownDataProperty(pricing, 'cacheWriteAccounting', owner),
    source: ownDataProperty(pricing, 'source', owner),
  }) as FixedTracePricing;
}

function snapshotStageConfig(config: unknown, owner: string): FixedTraceProviderStageConfig {
  // Read each untrusted stage property exactly once. Later checks use only
  // this detached plain object, never a caller-controlled getter or proxy.
  assertClosedOwnDataRecord(config, [
    'provider', 'model', 'reasoningEffort', 'maxOutputTokens', 'timeoutMs',
    'maxIterations', 'transportRetries', 'samplingMode', 'temperature', 'pricing',
  ], owner);
  const provider = ownDataProperty(config, 'provider', owner);
  const model = ownDataProperty(config, 'model', owner);
  const reasoningEffort = ownDataProperty(config, 'reasoningEffort', owner);
  const maxOutputTokens = ownDataProperty(config, 'maxOutputTokens', owner);
  const timeoutMs = ownDataProperty(config, 'timeoutMs', owner);
  const maxIterations = ownDataProperty(config, 'maxIterations', owner);
  const transportRetries = ownDataProperty(config, 'transportRetries', owner);
  const samplingMode = ownDataProperty(config, 'samplingMode', owner);
  const temperature = ownDataProperty(config, 'temperature', owner);
  const pricing = ownDataProperty(config, 'pricing', owner);
  return Object.freeze({
    provider,
    model,
    reasoningEffort,
    maxOutputTokens,
    timeoutMs,
    maxIterations,
    transportRetries,
    samplingMode,
    temperature,
    pricing: snapshotPricing(pricing, `${owner}.pricing`),
  }) as FixedTraceProviderStageConfig;
}

function snapshotBaseConfig(
  config: FixedTraceDiagnosticArtifactOptions['baseConfig'],
): FixedTraceDiagnosticArtifactOptions['baseConfig'] {
  return snapshotFixedTraceJson(config, 'fixed trace diagnostic base config') as FixedTraceDiagnosticArtifactOptions['baseConfig'];
}

function snapshotPlans(
  suppliedPlans: readonly FixedTraceDiagnosticProviderPlan[],
  budget: FixedTraceBudget,
): readonly FixedTraceDiagnosticProviderPlan[] {
  if (!Array.isArray(suppliedPlans) || suppliedPlans.length === 0) {
    throw new Error('Fixed trace diagnostic run requires one or more provider plans');
  }
  if (types.isProxy(suppliedPlans) || Object.getPrototypeOf(suppliedPlans) !== Array.prototype || Object.getOwnPropertySymbols(suppliedPlans).length !== 0) {
    throw new Error('Fixed trace diagnostic provider plans must be a plain non-Proxy array');
  }
  const planDescriptors = Object.getOwnPropertyDescriptors(suppliedPlans);
  for (const key of Object.keys(planDescriptors)) {
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !('value' in planDescriptors[key]!) || !planDescriptors[key]!.enumerable) {
      throw new Error('Fixed trace diagnostic provider plans contain an accessor or extra property');
    }
  }
  for (const [index, suppliedPlan] of suppliedPlans.entries()) {
    assertClosedOwnDataRecord(suppliedPlan, ['name', 'router', 'generation'], `provider plan ${index}`);
  }
  const plans = Object.freeze(suppliedPlans.map((suppliedPlan, index) => Object.freeze({
    // Do not validate while reading: a plan accessor must not be able to
    // return one identity for validation and another for execution.
    name: ownDataProperty(suppliedPlan, 'name', `provider plan ${index}`),
    router: snapshotStageConfig(
      ownDataProperty(suppliedPlan, 'router', `provider plan ${index}`),
      `provider plan ${index}.router`,
    ),
    generation: snapshotStageConfig(
      ownDataProperty(suppliedPlan, 'generation', `provider plan ${index}`),
      `provider plan ${index}.generation`,
    ),
  })));
  const names = new Set<string>();
  for (const plan of plans) {
    const routerPolicy = fixedTraceResponsePricingPolicy(
      plan.router.provider.id,
      plan.router.model,
      plan.router.pricing,
    );
    const generationPolicy = fixedTraceResponsePricingPolicy(
      plan.generation.provider.id,
      plan.generation.model,
      plan.generation.pricing,
    );
    if (
      typeof plan.name !== 'string'
      || plan.name.trim().length === 0
      || names.has(plan.name)
      || plan.name !== plan.router?.provider?.id
      || plan.name !== plan.generation?.provider?.id
      || !isTrustedBudgetedFixedTraceProvider(plan.router.provider, budget, plan.router.pricing, routerPolicy)
      || !isTrustedBudgetedFixedTraceProvider(plan.generation.provider, budget, plan.generation.pricing, generationPolicy)
    ) throw new Error('Fixed trace diagnostic provider plans require unique names matching both stage providers');
    names.add(plan.name);
  }
  // Clone every serializable stage control before a provider can run, but do
  // not claim the live ledger yet. The complete suite still needs preflight.
  return plans as readonly FixedTraceDiagnosticProviderPlan[];
}

function leasePlans(
  plans: readonly FixedTraceDiagnosticProviderPlan[],
  budget: FixedTraceBudget,
): readonly FixedTraceDiagnosticProviderPlan[] {
  const lease = claimFixedTraceBudgetDiagnosticLease(
    budget,
    plans.flatMap((plan) => [plan.router.provider, plan.generation.provider]),
    (candidateLease) => {
      for (const plan of plans) {
        const router = candidateLease.providerFor(plan.router.provider);
        const generation = candidateLease.providerFor(plan.generation.provider);
        const routerPolicy = fixedTraceResponsePricingPolicy(router.id, plan.router.model, plan.router.pricing);
        const generationPolicy = fixedTraceResponsePricingPolicy(
          generation.id,
          plan.generation.model,
          plan.generation.pricing,
        );
        if (
          plan.name !== router.id
          || plan.name !== generation.id
          || !isTrustedBudgetedFixedTraceProvider(router, budget, plan.router.pricing, routerPolicy)
          || !isTrustedBudgetedFixedTraceProvider(generation, budget, plan.generation.pricing, generationPolicy)
        ) throw new Error('Fixed trace diagnostic cloned provider plans are not authenticated');
      }
    },
  );
  return Object.freeze(plans.map((plan) => Object.freeze({
    name: plan.name,
    router: Object.freeze({ ...plan.router, provider: lease.providerFor(plan.router.provider) }),
    generation: Object.freeze({ ...plan.generation, provider: lease.providerFor(plan.generation.provider) }),
  })));
}

function snapshotNonblank(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Fixed trace diagnostic ${name} must be nonblank`);
  }
  return value;
}

function diagnosticChildRunId(runRootId: string, provider: string): string {
  // Plan names are validated as unique provider IDs. This makes each child
  // deterministic and unique without granting an external callback authority
  // to inject unrelated run provenance.
  return `${runRootId}:${provider}`;
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

function snapshotOutputReservation(
  reservation: FixedTraceDiagnosticOutputReservation,
): FixedTraceDiagnosticOutputReservation {
  if (!reservation || typeof reservation.finalize !== 'function') {
    throw new Error('Fixed trace diagnostic output reservation must finalize content');
  }
  return reservation;
}

function plannedRunConfigs(
  baseConfig: FixedTraceDiagnosticArtifactOptions['baseConfig'],
  plans: readonly FixedTraceDiagnosticProviderPlan[],
  runRootId: string,
): readonly { readonly plan: FixedTraceDiagnosticProviderPlan; readonly runId: string; readonly config: FixedTraceRunnerConfig }[] {
  const runIds = new Set<string>();
  const plannedRuns = plans.map((plan) => {
    const runId = diagnosticChildRunId(runRootId, plan.name);
    if (runIds.has(runId)) throw new Error('Fixed trace diagnostic plans must derive unique child run IDs');
    runIds.add(runId);
    return Object.freeze({
      plan,
      runId,
      config: Object.freeze({
        ...baseConfig,
        runId,
        router: plan.router,
        generation: plan.generation,
      }),
    });
  });
  return Object.freeze(plannedRuns);
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
  if (!costMatches(stage.estimatedCostUsd, fixedTraceEstimatedCostUsd(stage.usage, control.pricing))) {
    throw new Error('Fixed trace diagnostic artifact stage cost does not match recorded usage and pricing');
  }
}

function costMatches(left: number, right: number): boolean {
  // JSON serialization and addition of multiple model turns use IEEE-754.
  // One picodollar is materially below the resolution of this diagnostic.
  return Math.abs(left - right) <= 1e-12;
}

export function assertFixedTraceDiagnosticBudgetReconciliation(
  budget: ReturnType<FixedTraceBudget['snapshot']>,
  runs: ReadonlyArray<{ observations: readonly { metadata: FixedTraceRunMetadata; terminalStatus: string }[] }>,
): void {
  let dispatchedCalls = 0;
  let visibleSettledSpendUsd = 0;
  let allDispatchedCostsVisible = true;
  let unpricedDispatchedResponse = false;
  let budgetRejections = 0;

  for (const run of runs) {
    for (const observation of run.observations) {
      if (observation.terminalStatus === 'not_dispatched_budget') budgetRejections++;
      for (const stage of [observation.metadata.router, observation.metadata.generation]) {
        const stageDispatchedCalls = stage.dispatchedCalls;
        if (
          stageDispatchedCalls === undefined
          || !Number.isSafeInteger(stageDispatchedCalls)
          || stageDispatchedCalls < 0
          || stage.dispatched !== (stageDispatchedCalls > 0)
        ) throw new Error('Fixed trace diagnostic artifact stage dispatch evidence is invalid');
        dispatchedCalls += stageDispatchedCalls;
        if (!stage.dispatched) continue;
        if (stage.source === 'provider' && stage.estimatedCostUsd === null) {
          unpricedDispatchedResponse = true;
        }
        // A stage can be local after a terminal event was settled but failed
        // stream validation. That paid call is intentionally not represented
        // as a provider observation, so exact spend equality is not claimed.
        if (
          stage.source !== 'provider'
          || !stage.usageKnown
          || stage.usage === null
          || stage.estimatedCostUsd === null
        ) {
          allDispatchedCostsVisible = false;
          continue;
        }
        visibleSettledSpendUsd += stage.estimatedCostUsd;
      }
    }
  }

  if (
    !Number.isFinite(budget.accountedSpendUsd)
    || budget.accountedSpendUsd < 0
    || !Number.isFinite(budget.reservedUsd)
    || budget.reservedUsd < 0
    || !Number.isSafeInteger(budget.dispatchedCalls)
    || !Number.isSafeInteger(budget.completedCalls)
    || !Number.isSafeInteger(budget.budgetRejectedCalls)
    || budget.dispatchedCalls < 0
    || budget.completedCalls < 0
    || budget.budgetRejectedCalls < 0
  ) throw new Error('Fixed trace diagnostic artifact budget ledger is invalid');
  if (!costMatches(budget.reservedUsd, 0)) {
    throw new Error('Fixed trace diagnostic artifact has unsettled budget reservations');
  }
  if (budget.dispatchedCalls !== dispatchedCalls || budget.completedCalls > budget.dispatchedCalls) {
    throw new Error('Fixed trace diagnostic artifact budget dispatch counts do not match observations');
  }
  if (budget.budgetRejectedCalls !== budgetRejections) {
    throw new Error('Fixed trace diagnostic artifact budget rejections do not match observations');
  }
  if (unpricedDispatchedResponse && !budget.exposureUnknown) {
    throw new Error('Fixed trace diagnostic artifact unpriced dispatched response lacks unknown budget exposure');
  }
  if (budget.exposureUnknown) {
    // A dispatched unknown-exposure call is never completed. The known spend
    // preceding it is only a lower bound because failed terminal validation
    // can hide an already-settled call from stage metadata.
    if (budget.completedCalls >= budget.dispatchedCalls || budget.accountedSpendUsd + 1e-12 < visibleSettledSpendUsd) {
      throw new Error('Fixed trace diagnostic artifact unknown-exposure ledger is inconsistent');
    }
    return;
  }
  if (budget.completedCalls !== budget.dispatchedCalls) {
    throw new Error('Fixed trace diagnostic artifact completed budget calls do not match dispatches');
  }
  if (budget.accountedSpendUsd + 1e-12 < visibleSettledSpendUsd) {
    throw new Error('Fixed trace diagnostic artifact budget spend is below finalized observations');
  }
  if (allDispatchedCostsVisible && !costMatches(budget.accountedSpendUsd, visibleSettledSpendUsd)) {
    throw new Error('Fixed trace diagnostic artifact budget spend does not match finalized observations');
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
    && left.architectureArm.diagnosticOnly === right.architectureArm.diagnosticOnly
    && JSON.stringify(left.hybridPolicy) === JSON.stringify(right.hybridPolicy)
    && left.executionEnvelope.source === right.executionEnvelope.source
    && left.executionEnvelope.deployable === right.executionEnvelope.deployable
    && JSON.stringify(left.requestThreadFacts) === JSON.stringify(right.requestThreadFacts);
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
  // Snapshot and validate every serializable claim before provider code can
  // run. Provider, budget, and reservation objects remain live capabilities
  // by reference. In particular, do not acquire the one-way budget lease
  // until every planned suite has passed its no-dispatch preflight.
  const baseConfig = snapshotBaseConfig(options.baseConfig);
  const budgetLedger = options.budget;
  const requestedPlans = snapshotPlans(options.plans, budgetLedger);
  const runRootId = snapshotNonblank(options.runRootId, 'run root ID');
  const runStartedAt = snapshotNonblank(options.runStartedAt, 'run start time');
  const sourceBundleFiles = snapshotSourceBundleFiles(options.sourceBundleFiles);
  const budgetNote = snapshotNonblank(options.budgetNote, 'budget note');
  const outputReservation = snapshotOutputReservation(options.outputReservation);
  const requestedPlannedRuns = plannedRunConfigs(baseConfig, requestedPlans, runRootId);
  for (const plannedRun of requestedPlannedRuns) {
    preflightFixedTraceRunnerConfig(plannedRun.config);
  }

  // From this point onward a failure remains fail-closed: the budget lease is
  // intentionally exclusive for the complete diagnostic artifact lifetime.
  const plans = leasePlans(requestedPlans, budgetLedger);
  const plannedRuns = plannedRunConfigs(baseConfig, plans, runRootId);
  const candidateRuns = [];
  for (const { plan, runId, config } of plannedRuns) {
    const evaluated = await runFixedTraceDiagnosticCandidate(config);
    candidateRuns.push({
      provider: plan.name,
      runId,
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
      || run.runId !== diagnosticChildRunId(runRootId, run.provider)
      || run.observations.some((observation) => observation.metadata.runId !== run.runId)
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
  assertFixedTraceDiagnosticBudgetReconciliation(budget, runs);
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
    hybridPolicy: commonMetadata.hybridPolicy,
    toolUniverse: fixedTraceToolUniverseProvenance(commonMetadata.architectureArm.id),
    executionEnvelope: fixedTraceExecutionEnvelopeProvenance(commonMetadata.architectureArm.id),
    requestThreadFacts: commonMetadata.requestThreadFacts,
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
