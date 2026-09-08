/**
 * Bounded paid execution for exactly one synthetic architecture diagnostic
 * cell. This is diagnostic evidence only: it is not an external-final,
 * production, canary, or comparison-eligibility path.
 */
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ModelProvider } from '../model-providers/model-provider.js';
import {
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PACK_DIGEST,
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
  fixedTraceArchitectureDiagnosticPilotStageControls,
} from './fixed-trace-architecture-diagnostic.js';
import { fixedTraceArchitectureArm, fixedTraceCommonToolDefinitions, fixedTraceHybridPolicy } from './fixed-trace-architecture.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  claimFixedTraceBudgetDiagnosticLease,
  fixedTraceArchitectureDiagnosticRouterResponsePricingPolicy,
  fixedTraceResponsePricingPolicy,
  isTrustedBudgetedFixedTraceProvider,
} from './fixed-trace-budget.js';
import { assertFixedTraceDiagnosticBudgetReconciliation } from './fixed-trace-diagnostic-run.js';
import { datedPricingProfileIdentity, datedPricingProfilesForFixedTrace, datedPricingReservationCostUsd } from './dated-pricing-cohort.js';
import {
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_MAX_PREPARED_REQUEST_BYTES,
  preflightFixedTraceRunnerConfig,
  runFixedTraceArchitectureDiagnosticSonnetFullPack,
  type FixedTraceProviderStageConfig,
  type FixedTraceRunnerConfig,
} from './fixed-trace-runner.js';
import { fixedTraceSuiteSha256, summarizeFixedTraceRun } from './fixed-trace-suite.js';

export const FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_EXECUTION_CELL =
  'architecture_diagnostic:anthropic:claude-haiku-4-5:claude-sonnet-5' as const;

const EXECUTION_ARMS = Object.freeze([
  'direct_generation',
  'two_stage_llm_router',
  'deterministic_policy_llm_fallback_hybrid',
] as const);

type ExecutionArm = (typeof EXECUTION_ARMS)[number];

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function stage(provider: ModelProvider, kind: 'router' | 'generation'): FixedTraceProviderStageConfig {
  const controls = fixedTraceArchitectureDiagnosticPilotStageControls()[kind];
  return Object.freeze({ ...controls, provider });
}

function requireStageProvider(
  stageConfig: FixedTraceProviderStageConfig,
  budget: FixedTraceBudget,
  kind: 'router' | 'generation',
): void {
  const policy = kind === 'router'
    ? fixedTraceArchitectureDiagnosticRouterResponsePricingPolicy(
      stageConfig.provider.id,
      stageConfig.model,
      stageConfig.pricing,
    )
    : fixedTraceResponsePricingPolicy(
      stageConfig.provider.id,
      stageConfig.model,
      stageConfig.pricing,
    );
  if (!isTrustedBudgetedFixedTraceProvider(stageConfig.provider, budget, stageConfig.pricing, policy)) {
    throw new Error('Fixed trace architecture diagnostic requires authenticated budgeted Anthropic stages');
  }
}

export interface FixedTraceArchitectureDiagnosticCostCeiling {
  readonly cell: typeof FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_EXECUTION_CELL;
  readonly preparedRequestBytes: number;
  readonly routerMaxDispatches: 40;
  readonly generationMaxDispatches: 128;
  readonly totalMaxDispatches: 168;
  readonly routerReservationUsd: number;
  readonly generationReservationUsd: number;
  readonly totalUsd: number;
  readonly requiredSoftMaxUsd: number;
  readonly pricingProfileSha256: Readonly<{ router: string; generation: string }>;
}

/** Static full-cell ceiling for all three exact architecture arms. */
export function fixedTraceArchitectureDiagnosticCostCeiling(): FixedTraceArchitectureDiagnosticCostCeiling {
  const controls = fixedTraceArchitectureDiagnosticPilotStageControls();
  const router = datedPricingProfilesForFixedTrace().find((entry) => entry.profileId === controls.router.pricing.profileId);
  const generation = datedPricingProfilesForFixedTrace().find((entry) => entry.profileId === controls.generation.pricing.profileId);
  if (!router || !generation) throw new Error('Fixed trace architecture diagnostic pricing is unavailable');
  fixedTraceArchitectureDiagnosticRouterResponsePricingPolicy('anthropic', controls.router.model, router);
  fixedTraceResponsePricingPolicy('anthropic', controls.generation.model, generation);
  const routerReservationUsd = 40 * datedPricingReservationCostUsd(
    router,
    FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_MAX_PREPARED_REQUEST_BYTES,
    controls.router.maxOutputTokens,
  );
  const generationReservationUsd = 128 * datedPricingReservationCostUsd(
    generation,
    FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_MAX_PREPARED_REQUEST_BYTES,
    controls.generation.maxOutputTokens,
  );
  return freeze({
    cell: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_EXECUTION_CELL,
    preparedRequestBytes: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_MAX_PREPARED_REQUEST_BYTES,
    routerMaxDispatches: 40,
    generationMaxDispatches: 128,
    totalMaxDispatches: 168,
    routerReservationUsd,
    generationReservationUsd,
    totalUsd: routerReservationUsd + generationReservationUsd,
    requiredSoftMaxUsd: routerReservationUsd + generationReservationUsd,
    pricingProfileSha256: {
      router: datedPricingProfileIdentity(router).digest,
      generation: datedPricingProfileIdentity(generation).digest,
    },
  });
}

export function fixedTraceArchitectureDiagnosticSourceBundle(files: readonly string[]): {
  readonly files: readonly string[];
  readonly sha256: string;
} {
  const ordered = [...new Set(files)].sort();
  if (ordered.length === 0 || ordered.some((file) => !file || file.startsWith('/') || file.includes('..'))) {
    throw new Error('Fixed trace architecture diagnostic source bundle is invalid');
  }
  const hash = createHash('sha256');
  for (const file of ordered) hash.update(file, 'utf8').update('\0').update(readFileSync(file)).update('\0');
  return freeze({ files: Object.freeze(ordered), sha256: hash.digest('hex') });
}

export function fixedTraceArchitectureDiagnosticPlan(input: Readonly<{
  sourceFiles: readonly string[];
  sourceBundleSha256: string;
  promptConfigVersion: string;
}>) {
  const controls = fixedTraceArchitectureDiagnosticPilotStageControls();
  return freeze({
    cell: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_EXECUTION_CELL,
    architectureDiagnosticMode: 'synthetic_sonnet_full_pack_v1',
    packDigest: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PACK_DIGEST,
    traceCount: 24,
    arms: EXECUTION_ARMS,
    router: { ...controls.router, providerId: controls.router.providerId },
    generation: { ...controls.generation, providerId: controls.generation.providerId },
    sourceFiles: [...input.sourceFiles],
    sourceBundleSha256: input.sourceBundleSha256,
    promptConfigVersion: input.promptConfigVersion,
    wholeCellCostCeiling: fixedTraceArchitectureDiagnosticCostCeiling(),
    diagnosticOnly: true,
    comparisonEligible: false,
    formalExternalFinal: 'unavailable',
  });
}

export function fixedTraceArchitectureDiagnosticConfig(input: Readonly<{
  runId: string;
  sourceBundleSha256: string;
  gitCommit: string;
  promptConfigVersion: string;
  architectureArm: ExecutionArm;
  router: ModelProvider;
  generation: ModelProvider;
}>): FixedTraceRunnerConfig {
  // Providers are live capabilities, not serializable evaluator evidence;
  // freezing a supplied adapter's internals here would be surprising and is
  // not the trust boundary. Admission instead requires immutable budgeted
  // wrappers, while the runner snapshots the serializable config.
  return Object.freeze({
    runId: input.runId,
    sourceBundleSha256: input.sourceBundleSha256,
    gitCommit: input.gitCommit,
    gitDirty: false,
    promptConfigVersion: input.promptConfigVersion,
    traceSuite: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
    traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE),
    toolDefinitions: fixedTraceCommonToolDefinitions(input.architectureArm),
    toolDefinitionProvenance: 'evaluator_owned_common_tool_universe',
    architectureArm: input.architectureArm,
    architectureDiagnosticMode: 'synthetic_sonnet_full_pack_v1',
    ...(input.architectureArm === 'deterministic_policy_llm_fallback_hybrid'
      ? { hybridPolicy: fixedTraceHybridPolicy() }
      : {}),
    router: stage(input.router, 'router'),
    generation: stage(input.generation, 'generation'),
  });
}

export interface FixedTraceArchitectureDiagnosticAdmission {
  /** Abandon an admitted cell before it begins; an admission cannot be reused. */
  release(): void;
}

interface FixedTraceArchitectureDiagnosticAdmissionRecord {
  readonly configs: readonly FixedTraceRunnerConfig[];
  readonly budget: FixedTraceBudget;
  readonly lease: ReturnType<typeof claimFixedTraceBudgetDiagnosticLease>;
  readonly runRootId: string;
  readonly runStartedAt: string;
  readonly plan: ReturnType<typeof fixedTraceArchitectureDiagnosticPlan>;
  readonly budgetSoftMaxUsd: number;
  state: 'admitted' | 'running' | 'released' | 'finished';
}

// The public admission is deliberately only a capability handle. Its mutable
// execution authority, providers, lease, budget, and provenance are held in
// this module-private registry so a matching-looking object cannot dispatch.
const admissions = new WeakMap<FixedTraceArchitectureDiagnosticAdmission, FixedTraceArchitectureDiagnosticAdmissionRecord>();

function snapshotAdmissionPlan(
  plan: ReturnType<typeof fixedTraceArchitectureDiagnosticPlan>,
  sourceBundleSha256: string,
  promptConfigVersion: string,
): ReturnType<typeof fixedTraceArchitectureDiagnosticPlan> {
  const sourceFiles = plan?.sourceFiles;
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0 || sourceFiles.some((file) => (
    typeof file !== 'string' || !file || file.startsWith('/') || file.includes('..')
  ))) {
    throw new Error('Fixed trace architecture diagnostic plan source files are invalid');
  }
  const canonical = fixedTraceArchitectureDiagnosticPlan({
    sourceFiles: [...sourceFiles], sourceBundleSha256, promptConfigVersion,
  });
  if (!isDeepStrictEqual(plan, canonical)) {
    throw new Error('Fixed trace architecture diagnostic plan does not match its admitted provenance');
  }
  return canonical;
}

function releaseAdmission(record: FixedTraceArchitectureDiagnosticAdmissionRecord): void {
  if (record.state === 'released' || record.state === 'finished') return;
  record.lease.releaseWholeRunReservation();
  record.state = 'released';
}

function rejectAdmission(record: FixedTraceArchitectureDiagnosticAdmissionRecord, message: string): never {
  // A malformed execution request is never retried with the same paid-cell
  // authority. Release its unspent escrow before surfacing the rejection.
  releaseAdmission(record);
  throw new Error(message);
}

function authenticatedAdmission(
  admission: FixedTraceArchitectureDiagnosticAdmission,
  input: Readonly<{
    runRootId: string;
    runStartedAt: string;
    plan: ReturnType<typeof fixedTraceArchitectureDiagnosticPlan>;
    budget: FixedTraceBudget;
  }>,
): FixedTraceArchitectureDiagnosticAdmissionRecord {
  const record = admissions.get(admission);
  if (!record || !Object.isFrozen(admission)) {
    throw new Error('Fixed trace architecture diagnostic admission is not authenticated');
  }
  if (record.state !== 'admitted') {
    throw new Error('Fixed trace architecture diagnostic admission is no longer available');
  }
  if (
    input.runRootId !== record.runRootId
    || input.runStartedAt !== record.runStartedAt
    || input.budget !== record.budget
    || !isDeepStrictEqual(input.plan, record.plan)
  ) {
    return rejectAdmission(record, 'Fixed trace architecture diagnostic artifact provenance does not match its admission');
  }
  if (record.budget.softMaxUsd !== record.budgetSoftMaxUsd) {
    return rejectAdmission(record, 'Fixed trace architecture diagnostic admitted budget was modified');
  }
  if (record.configs.length !== EXECUTION_ARMS.length) {
    return rejectAdmission(record, 'Fixed trace architecture diagnostic admission has an invalid arm count');
  }
  for (const [index, config] of record.configs.entries()) {
    const arm = EXECUTION_ARMS[index];
    if (
      !arm
      || config.runId !== `${record.runRootId}:${arm}`
      || config.architectureArm !== arm
      || config.sourceBundleSha256 !== record.plan.sourceBundleSha256
      || config.promptConfigVersion !== record.plan.promptConfigVersion
      || config.architectureDiagnosticMode !== 'synthetic_sonnet_full_pack_v1'
      || !config.router
    ) return rejectAdmission(record, 'Fixed trace architecture diagnostic admitted config is invalid');
    try {
      requireStageProvider(config.router, record.budget, 'router');
      requireStageProvider(config.generation, record.budget, 'generation');
      preflightFixedTraceRunnerConfig(config);
    } catch (error) {
      return rejectAdmission(record, error instanceof Error ? error.message : String(error));
    }
  }
  return record;
}

/**
 * Authenticate the only declared cell and reserve the complete bounded
 * three-arm run before an immutable selector or output path is consumed.
 */
export function admitFixedTraceArchitectureDiagnostic(input: Readonly<{
  runRootId: string;
  runStartedAt: string;
  sourceBundleSha256: string;
  gitCommit: string;
  promptConfigVersion: string;
  plan: ReturnType<typeof fixedTraceArchitectureDiagnosticPlan>;
  router: ModelProvider;
  generation: ModelProvider;
  budget: FixedTraceBudget;
}>): FixedTraceArchitectureDiagnosticAdmission {
  if (!input.runRootId.trim()) throw new Error('Fixed trace architecture diagnostic run root ID is required');
  if (!input.runStartedAt.trim()) throw new Error('Fixed trace architecture diagnostic run start time is required');
  if (!/^[a-f0-9]{64}$/.test(input.sourceBundleSha256)) {
    throw new Error('Fixed trace architecture diagnostic source bundle digest is invalid');
  }
  if (!input.gitCommit.trim() || !input.promptConfigVersion.trim()) {
    throw new Error('Fixed trace architecture diagnostic provenance is required');
  }
  const plan = snapshotAdmissionPlan(input.plan, input.sourceBundleSha256, input.promptConfigVersion);
  const ceiling = fixedTraceArchitectureDiagnosticCostCeiling();
  if (input.budget.softMaxUsd < ceiling.requiredSoftMaxUsd) {
    throw new RangeError('Fixed trace architecture diagnostic soft budget is below the required whole-cell ceiling');
  }
  const requested = EXECUTION_ARMS.map((architectureArm) => fixedTraceArchitectureDiagnosticConfig({
    ...input, runId: `${input.runRootId}:${architectureArm}`, architectureArm,
  }));
  for (const config of requested) {
    requireStageProvider(config.router!, input.budget, 'router');
    requireStageProvider(config.generation, input.budget, 'generation');
    preflightFixedTraceRunnerConfig(config);
  }
  const lease = claimFixedTraceBudgetDiagnosticLease(
    input.budget,
    [input.router, input.generation],
    undefined,
    ceiling.requiredSoftMaxUsd,
  );
  const configs = requested.map((config) => fixedTraceArchitectureDiagnosticConfig({
    ...input,
    runId: config.runId,
    architectureArm: config.architectureArm as ExecutionArm,
    router: lease.providerFor(input.router),
    generation: lease.providerFor(input.generation),
  }));
  try {
    for (const config of configs) preflightFixedTraceRunnerConfig(config);
  } catch (error) {
    lease.releaseWholeRunReservation();
    throw error;
  }
  let admission: FixedTraceArchitectureDiagnosticAdmission;
  const record: FixedTraceArchitectureDiagnosticAdmissionRecord = {
    configs: Object.freeze(configs),
    budget: input.budget,
    lease,
    runRootId: input.runRootId,
    runStartedAt: input.runStartedAt,
    plan,
    budgetSoftMaxUsd: input.budget.softMaxUsd,
    state: 'admitted',
  };
  admission = Object.freeze({ release: () => releaseAdmission(record) });
  admissions.set(admission, record);
  return admission;
}

/** Durable one-use cell declaration. */
export function consumeFixedTraceArchitectureDiagnosticSelector(path: string, input: Readonly<{
  sourceBundleSha256: string;
  promptConfigVersion: string;
}>): void {
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) { throw new Error(`Fixed trace architecture diagnostic selector was already consumed: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    writeFileSync(descriptor, `${JSON.stringify({
      cell: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_EXECUTION_CELL,
      architectureDiagnosticMode: 'synthetic_sonnet_full_pack_v1',
      traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE),
      sourceBundleSha256: input.sourceBundleSha256,
      promptConfigVersion: input.promptConfigVersion,
    })}\n`, 'utf8');
  } finally { closeSync(descriptor); }
}

export interface FixedTraceArchitectureDiagnosticOutputReservation {
  finalize(artifact: unknown): string;
}

/**
 * A finalization attempt is terminal even when its checksum cannot be
 * persisted. Callers must preserve the claimed paths and must not dispatch
 * the cell again. The durability flags say exactly which terminal evidence
 * made it to disk before the failure.
 */
export class FixedTraceArchitectureDiagnosticOutputFinalizationError extends Error {
  constructor(
    readonly artifactDurable: boolean,
    readonly checksumDurable: boolean,
    cause: unknown,
  ) {
    super('Fixed trace architecture diagnostic output finalization failed', { cause });
    this.name = 'FixedTraceArchitectureDiagnosticOutputFinalizationError';
  }
}

/** Reserve artifact and checksum identities together; neither is overwritten. */
export function reserveFixedTraceArchitectureDiagnosticOutput(path: string): FixedTraceArchitectureDiagnosticOutputReservation {
  const output = resolve(path);
  const checksum = `${output}.sha256`;
  let artifactDescriptor: number;
  let checksumDescriptor: number;
  try {
    artifactDescriptor = openSync(output, 'wx', 0o600);
    try { checksumDescriptor = openSync(checksum, 'wx', 0o600); }
    catch (error) {
      // A checksum collision means this reservation never became usable. Roll
      // back our just-created artifact claim so a corrected retry is safe.
      try { closeSync(artifactDescriptor); } finally { unlinkSync(output); }
      throw error;
    }
  } catch (error) {
    throw new Error(`Cannot exclusively reserve fixed-trace architecture diagnostic output: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finalizationAttempted = false;
  return Object.freeze({
    finalize(artifact: unknown): string {
      if (finalizationAttempted) throw new Error('Fixed trace architecture diagnostic output finalization was already attempted');
      finalizationAttempted = true;
      let artifactDurable = false;
      let checksumDurable = false;
      let finalizationFailure: unknown;
      let finalizationFailed = false;
      let digest: string | null = null;
      try {
        const content = `${JSON.stringify(artifact, null, 2)}\n`;
        digest = sha256(content);
        writeFileSync(artifactDescriptor!, content, 'utf8');
        fsyncSync(artifactDescriptor!);
        artifactDurable = true;
        writeFileSync(checksumDescriptor!, `${digest}  ${output}\n`, 'utf8');
        fsyncSync(checksumDescriptor!);
        checksumDurable = true;
      } catch (error) {
        finalizationFailure = error;
        finalizationFailed = true;
      }
      try { closeSync(artifactDescriptor!); }
      catch (error) {
        if (!finalizationFailed) finalizationFailure = error;
        finalizationFailed = true;
      }
      try { closeSync(checksumDescriptor!); }
      catch (error) {
        if (!finalizationFailed) finalizationFailure = error;
        finalizationFailed = true;
      }
      if (finalizationFailed) {
        throw new FixedTraceArchitectureDiagnosticOutputFinalizationError(
          artifactDurable, checksumDurable, finalizationFailure,
        );
      }
      return digest!;
    },
  });
}

/**
 * A completed run's artifact is the only terminal evidence eligible for its
 * claimed output. In particular, do not attempt to replace it with a setup
 * failure artifact if persistence fails: the selector has already been
 * consumed and a provider may have been dispatched.
 */
export function finalizeCompletedFixedTraceArchitectureDiagnosticArtifact(
  output: FixedTraceArchitectureDiagnosticOutputReservation,
  artifact: unknown,
): string {
  try {
    return output.finalize(artifact);
  } catch (error) {
    const durability = error instanceof FixedTraceArchitectureDiagnosticOutputFinalizationError
      ? `artifact durable=${error.artifactDurable}; checksum durable=${error.checksumDurable}`
      : 'artifact and checksum durability are unknown';
    throw new Error(
      `Fixed trace architecture diagnostic completed, but terminal artifact finalization failed (${durability}). The selector remains consumed; do not dispatch this cell again.`,
      { cause: error },
    );
  }
}

/** Execute all three declared arms and retain every returned observation. */
export async function runFixedTraceArchitectureDiagnosticArtifact(input: Readonly<{
  admission: FixedTraceArchitectureDiagnosticAdmission;
  runRootId: string;
  runStartedAt: string;
  plan: ReturnType<typeof fixedTraceArchitectureDiagnosticPlan>;
  budget: FixedTraceBudget;
}>) {
  const admission = authenticatedAdmission(input.admission, input);
  admission.state = 'running';
  const runs: Array<Record<string, unknown> & {
    observations: readonly import('./fixed-trace-suite.js').FixedTraceObservation[];
  }> = [];
  let executionFailure: string | null = null;
  let reconciliationFailure: string | null = null;
  try {
    for (const config of admission.configs) {
      const observations: import('./fixed-trace-suite.js').FixedTraceObservation[] = [];
      try {
        const completed = await runFixedTraceArchitectureDiagnosticSonnetFullPack(config, (observation) => {
          observations.push(observation);
        });
        if (completed.length !== observations.length || completed.some((observation, index) => observation !== observations[index])) {
          throw new Error('Fixed trace architecture diagnostic observation retention is inconsistent');
        }
        const summarized = summarizeFixedTraceRun(observations, FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE);
        if (observations.length !== 24 || summarized.summary.comparisonEligible !== false) {
          throw new Error('Fixed trace architecture diagnostic did not retain the complete diagnostic-only denominator');
        }
        runs.push(freeze({
          architectureArm: fixedTraceArchitectureArm(config.architectureArm),
          runId: config.runId,
          observations,
          ...summarized,
        }));
      } catch (error) {
        executionFailure = error instanceof Error ? error.message : String(error);
        runs.push(freeze({
          architectureArm: fixedTraceArchitectureArm(config.architectureArm),
          runId: config.runId,
          observations,
          complete: false,
          failure: executionFailure,
        }));
        break;
      }
    }
  } finally {
    releaseAdmission(admission);
    admission.state = 'finished';
  }
  const budget = admission.budget.snapshot();
  try {
    // The runner retains invocation identity, continuation request hashes, and
    // custom-tool ledgers in each observation. This reconciles those retained
    // observations with the budget wrapper's per-dispatch actual-usage
    // settlement, or explicitly preserved unknown exposure.
    assertFixedTraceDiagnosticBudgetReconciliation(
      budget,
      runs as Array<{ observations: readonly { metadata: import('./fixed-trace-suite.js').FixedTraceRunMetadata; terminalStatus: string }[] }>,
    );
  } catch (error) {
    reconciliationFailure = error instanceof Error ? error.message : String(error);
  }
  return freeze({
    artifactVersion: 'fixed_trace_architecture_diagnostic_execution_v1',
    runRootId: admission.runRootId,
    runStartedAt: admission.runStartedAt,
    runCompletedAt: new Date().toISOString(),
    plan: admission.plan,
    budget,
    diagnosticOnly: true,
    comparisonEligible: false,
    productionEligible: false,
    canaryEligible: false,
    promotionEvidenceEligible: false,
    promotionBlocker: 'trusted_evaluator_context_unavailable',
    formalExternalFinal: 'unavailable',
    // Denominator coverage remains visible on each run summary. A paid call
    // with unknown exposure, however, is not a complete settled execution.
    complete: executionFailure === null && reconciliationFailure === null && !budget.exposureUnknown
      && runs.length === EXECUTION_ARMS.length && runs.every((run) => run.summary !== undefined && (
        run.summary as { complete: boolean }
      ).complete),
    // Keep the former headline field for consumers while retaining an
    // independent reconciliation result when execution itself also failed.
    failure: executionFailure ?? reconciliationFailure,
    executionFailure,
    reconciliationFailure,
    runs,
  });
}

/**
 * Preserve a setup failure after an output path was claimed without allowing a
 * caller to invent artifact provenance outside the authenticated admission.
 */
export function fixedTraceArchitectureDiagnosticFailureArtifact(
  admission: FixedTraceArchitectureDiagnosticAdmission,
  error: unknown,
) {
  const record = admissions.get(admission);
  if (!record || !Object.isFrozen(admission)) {
    throw new Error('Fixed trace architecture diagnostic admission is not authenticated');
  }
  if (record.state === 'running' || record.state === 'finished') {
    throw new Error('Fixed trace architecture diagnostic admission cannot produce a setup failure artifact');
  }
  releaseAdmission(record);
  record.state = 'finished';
  const executionFailure = error instanceof Error ? error.message : String(error);
  return freeze({
    artifactVersion: 'fixed_trace_architecture_diagnostic_execution_v1',
    runRootId: record.runRootId,
    runStartedAt: record.runStartedAt,
    runCompletedAt: new Date().toISOString(),
    plan: record.plan,
    budget: record.budget.snapshot(),
    diagnosticOnly: true,
    comparisonEligible: false,
    productionEligible: false,
    canaryEligible: false,
    promotionEvidenceEligible: false,
    promotionBlocker: 'trusted_evaluator_context_unavailable',
    formalExternalFinal: 'unavailable',
    complete: false,
    failure: executionFailure,
    executionFailure,
    reconciliationFailure: null,
    runs: [],
  });
}
