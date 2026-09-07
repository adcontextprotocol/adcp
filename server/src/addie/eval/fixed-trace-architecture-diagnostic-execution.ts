/**
 * Bounded paid execution for exactly one synthetic architecture diagnostic
 * cell. This is diagnostic evidence only: it is not an external-final,
 * production, canary, or comparison-eligibility path.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
): void {
  const policy = fixedTraceResponsePricingPolicy(
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
  fixedTraceResponsePricingPolicy('anthropic', controls.router.model, router);
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
  readonly configs: readonly FixedTraceRunnerConfig[];
  release(): void;
}

/**
 * Authenticate the only declared cell and reserve the complete bounded
 * three-arm run before an immutable selector or output path is consumed.
 */
export function admitFixedTraceArchitectureDiagnostic(input: Readonly<{
  runRootId: string;
  sourceBundleSha256: string;
  gitCommit: string;
  promptConfigVersion: string;
  router: ModelProvider;
  generation: ModelProvider;
  budget: FixedTraceBudget;
}>): FixedTraceArchitectureDiagnosticAdmission {
  if (!input.runRootId.trim()) throw new Error('Fixed trace architecture diagnostic run root ID is required');
  const ceiling = fixedTraceArchitectureDiagnosticCostCeiling();
  if (input.budget.softMaxUsd < ceiling.requiredSoftMaxUsd) {
    throw new RangeError('Fixed trace architecture diagnostic soft budget is below the required whole-cell ceiling');
  }
  const requested = EXECUTION_ARMS.map((architectureArm) => fixedTraceArchitectureDiagnosticConfig({
    ...input, runId: `${input.runRootId}:${architectureArm}`, architectureArm,
  }));
  for (const config of requested) {
    requireStageProvider(config.router!, input.budget);
    requireStageProvider(config.generation, input.budget);
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
  return Object.freeze({ configs: Object.freeze(configs), release: () => lease.releaseWholeRunReservation() });
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

/** Reserve artifact and checksum identities together; neither is overwritten. */
export function reserveFixedTraceArchitectureDiagnosticOutput(path: string): FixedTraceArchitectureDiagnosticOutputReservation {
  const output = resolve(path);
  const checksum = `${output}.sha256`;
  let artifactDescriptor: number;
  let checksumDescriptor: number;
  try {
    artifactDescriptor = openSync(output, 'wx', 0o600);
    try { checksumDescriptor = openSync(checksum, 'wx', 0o600); }
    catch (error) { closeSync(artifactDescriptor); throw error; }
  } catch (error) {
    throw new Error(`Cannot exclusively reserve fixed-trace architecture diagnostic output: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finalized = false;
  return Object.freeze({
    finalize(artifact: unknown): string {
      if (finalized) throw new Error('Fixed trace architecture diagnostic output is already finalized');
      const content = `${JSON.stringify(artifact, null, 2)}\n`;
      const digest = sha256(content);
      try {
        writeFileSync(artifactDescriptor!, content, 'utf8');
        writeFileSync(checksumDescriptor!, `${digest}  ${output}\n`, 'utf8');
        finalized = true;
        return digest;
      } finally { closeSync(artifactDescriptor!); closeSync(checksumDescriptor!); }
    },
  });
}

/** Execute all three declared arms and retain every returned observation. */
export async function runFixedTraceArchitectureDiagnosticArtifact(input: Readonly<{
  admission: FixedTraceArchitectureDiagnosticAdmission;
  runRootId: string;
  runStartedAt: string;
  plan: ReturnType<typeof fixedTraceArchitectureDiagnosticPlan>;
  budget: FixedTraceBudget;
}>) {
  const runs: unknown[] = [];
  let failure: string | null = null;
  try {
    for (const config of input.admission.configs) {
      const observations = await runFixedTraceArchitectureDiagnosticSonnetFullPack(config);
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
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    input.admission.release();
  }
  const budget = input.budget.snapshot();
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
    failure ??= error instanceof Error ? error.message : String(error);
  }
  return freeze({
    artifactVersion: 'fixed_trace_architecture_diagnostic_execution_v1',
    runRootId: input.runRootId,
    runStartedAt: input.runStartedAt,
    runCompletedAt: new Date().toISOString(),
    plan: input.plan,
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
    complete: failure === null && !budget.exposureUnknown && runs.length === EXECUTION_ARMS.length && runs.every((run) => (
      (run as { summary: { complete: boolean } }).summary.complete
    )),
    failure,
    runs,
  });
}
