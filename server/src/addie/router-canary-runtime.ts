import { createLogger } from '../logger.js';
import { OPENAI_ROUTER_MODEL } from './model-providers/openai-responses-provider.js';
import {
  ROUTER_CANARY_MAX_REQUEST_BYTES,
  admitRouterCanary,
  recordRouterCanaryOutcome,
  type AdmitRouterCanaryResult,
  type RouterCanaryAdmission,
  type RouterCanaryCohortInput,
  type RouterCanaryFailureReason,
  type RouterCanaryOutcome,
} from './router-canary.js';
import {
  buildRouterModelRequest,
  type AddieRouter,
  type ExecutionPlan,
  type RouterModelObservation,
  type RoutingContext,
} from './router.js';

const logger = createLogger('addie-router-canary-runtime');
const LUNA_INPUT_MICROS_PER_TOKEN = 0.2;
const LUNA_OUTPUT_MICROS_PER_TOKEN = 1.2;
export const ROUTER_CANARY_METADATA_TIMEOUT_MS = 750;

type RouterRoute = AddieRouter['route'];

export interface RouterCanaryRuntimeInput extends RouterCanaryCohortInput {
  routingContext: RoutingContext;
}

export type RouterCanaryRuntimeReason =
  | 'candidate_succeeded'
  | 'candidate_failed'
  | 'request_too_large'
  | 'outcome_not_recorded'
  | Exclude<AdmitRouterCanaryResult, RouterCanaryAdmission>['reason'];

export interface RouterCanaryRuntimeResult {
  plan: ExecutionPlan;
  provider: 'luna' | 'anthropic_fallback';
  reason: RouterCanaryRuntimeReason;
}

export interface RouterCanaryRuntimeDependencies {
  candidateRoute: RouterRoute;
  fallbackRoute: RouterRoute;
  admit?: typeof admitRouterCanary;
  record?: typeof recordRouterCanaryOutcome;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
  yieldForObserver?: () => Promise<void>;
}

/** Fail closed before the minimum candidate deadline if live metadata hangs. */
export async function loadRouterCanaryMetadata<T>(
  loader: () => Promise<T | null>,
  dependencies: {
    timeoutMs?: number;
    scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearScheduledTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
  } = {},
): Promise<T | null> {
  const timeoutMs = dependencies.timeoutMs ?? ROUTER_CANARY_METADATA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 999) {
    throw new Error('Invalid router canary metadata timeout');
  }
  const schedule = dependencies.scheduleTimeout ?? setTimeout;
  const clear = dependencies.clearScheduledTimeout ?? clearTimeout;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<null>((resolve) => {
    timeout = schedule(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(loader).catch(() => null),
      timeoutResult,
    ]);
  } finally {
    if (timeout !== undefined) clear(timeout);
  }
}

function safeKnowledgePlan(): ExecutionPlan {
  return {
    action: 'respond',
    tool_sets: ['knowledge'],
    confidence: 'high',
    reason: 'Router provider fallback failed - defaulting to knowledge tools',
    decision_method: 'llm',
  };
}

function estimateCostMicros(observation: RouterModelObservation | null): number {
  if (!observation || observation.inputTokens === null || observation.outputTokens === null) {
    return 0;
  }
  return Math.ceil(
    observation.inputTokens * LUNA_INPUT_MICROS_PER_TOKEN
    + observation.outputTokens * LUNA_OUTPUT_MICROS_PER_TOKEN,
  );
}

function classifyCandidateFailure(
  observation: RouterModelObservation | null,
  timedOut: boolean,
): RouterCanaryFailureReason {
  if (timedOut) return 'timeout';
  switch (observation?.primaryErrorCategory) {
    case 'invalid_json':
    case 'schema_invalid':
    case 'refusal':
    case 'truncated':
    case 'incomplete':
      return 'invalid_output';
    case 'unexpected_model_identity':
    case 'invalid_provider_event_stream':
    case 'unsupported_provider_capability':
      return observation.primaryErrorCategory;
    default:
      return 'provider_error';
  }
}

async function defaultYieldForObserver(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fallback(
  input: RouterCanaryRuntimeInput,
  dependencies: RouterCanaryRuntimeDependencies,
  reason: RouterCanaryRuntimeReason,
  terminal?: {
    admission: RouterCanaryAdmission;
    failureReason: RouterCanaryFailureReason;
    candidateLatencyMs: number;
    candidateCostMicros: number;
  },
): Promise<RouterCanaryRuntimeResult> {
  const fallbackCapture: { current: RouterModelObservation | null } = { current: null };
  const startedAt = (dependencies.now ?? (() => new Date()))().getTime();
  let plan: ExecutionPlan;
  try {
    plan = await dependencies.fallbackRoute(input.routingContext, {
      observer: (observation) => {
        fallbackCapture.current = observation;
      },
    });
    await (dependencies.yieldForObserver ?? defaultYieldForObserver)();
  } catch {
    logger.error('Router canary Anthropic fallback threw unexpectedly');
    plan = safeKnowledgePlan();
  }

  if (terminal) {
    const fallbackLatencyMs = fallbackCapture.current?.latencyMs
      ?? Math.max(0, (dependencies.now ?? (() => new Date()))().getTime() - startedAt);
    const outcome: RouterCanaryOutcome = {
      status: fallbackCapture.current?.primaryErrorCategory === null
        ? 'fallback_succeeded'
        : 'fallback_safe_default',
      failureReason: terminal.failureReason,
      candidateLatencyMs: terminal.candidateLatencyMs,
      candidateCostMicros: terminal.candidateCostMicros,
      fallbackLatencyMs,
    };
    try {
      const recorded = await (dependencies.record ?? recordRouterCanaryOutcome)(
        terminal.admission,
        outcome,
      );
      if (!recorded.recorded) logger.error('Router canary terminal outcome was not recorded');
    } catch {
      logger.error('Router canary terminal outcome ledger unavailable');
    }
  }

  return { plan, provider: 'anthropic_fallback', reason };
}

/**
 * Runs one admitted Luna route within a hard deadline. Every candidate error,
 * missing observation, or ledger failure returns through the Anthropic router.
 */
export async function routeWithRouterCanary(
  input: RouterCanaryRuntimeInput,
  dependencies: RouterCanaryRuntimeDependencies,
): Promise<RouterCanaryRuntimeResult> {
  const request = buildRouterModelRequest(
    input.routingContext,
    OPENAI_ROUTER_MODEL,
    { effort: 'none' },
  );
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > ROUTER_CANARY_MAX_REQUEST_BYTES) {
    return fallback(input, dependencies, 'request_too_large');
  }

  const admission = await (dependencies.admit ?? admitRouterCanary)(input, {
    env: dependencies.env,
    now: (dependencies.now ?? (() => new Date()))(),
  });
  if (admission.status !== 'admitted') {
    return fallback(input, dependencies, admission.reason);
  }

  const controller = new AbortController();
  let timedOut = false;
  const candidateCapture: { current: RouterModelObservation | null } = { current: null };
  const startedAt = (dependencies.now ?? (() => new Date()))().getTime();
  const schedule = dependencies.scheduleTimeout ?? setTimeout;
  const clear = dependencies.clearScheduledTimeout ?? clearTimeout;
  const timeout = schedule(() => {
    timedOut = true;
    controller.abort(new Error('router_canary_timeout'));
  }, admission.deadlineMs);
  let timeoutCleared = false;
  const clearCandidateTimeout = () => {
    if (timeoutCleared) return;
    timeoutCleared = true;
    clear(timeout);
  };

  try {
    const plan = await dependencies.candidateRoute(input.routingContext, {
      failureMode: 'throw',
      signal: controller.signal,
      observer: (observation) => {
        candidateCapture.current = observation;
      },
    });
    clearCandidateTimeout();
    await (dependencies.yieldForObserver ?? defaultYieldForObserver)();
    if (!candidateCapture.current || candidateCapture.current.primaryErrorCategory !== null) {
      return fallback(input, dependencies, 'candidate_failed', {
        admission,
        failureReason: classifyCandidateFailure(candidateCapture.current, timedOut),
        candidateLatencyMs: Math.max(
          0,
          (dependencies.now ?? (() => new Date()))().getTime() - startedAt,
        ),
        candidateCostMicros: estimateCostMicros(candidateCapture.current),
      });
    }
    let recorded;
    try {
      recorded = await (dependencies.record ?? recordRouterCanaryOutcome)(admission, {
        status: 'candidate_succeeded',
        candidateLatencyMs: candidateCapture.current.latencyMs,
        candidateCostMicros: estimateCostMicros(candidateCapture.current),
      });
    } catch {
      logger.error('Router canary success outcome ledger unavailable');
      return fallback(input, dependencies, 'outcome_not_recorded');
    }
    if (!recorded.recorded) {
      logger.error('Router canary success outcome was not recorded');
      return fallback(input, dependencies, 'outcome_not_recorded');
    }
    return { plan, provider: 'luna', reason: 'candidate_succeeded' };
  } catch {
    clearCandidateTimeout();
    await (dependencies.yieldForObserver ?? defaultYieldForObserver)();
    return fallback(input, dependencies, 'candidate_failed', {
      admission,
      failureReason: classifyCandidateFailure(candidateCapture.current, timedOut),
      candidateLatencyMs: candidateCapture.current?.latencyMs ?? Math.max(
        0,
        (dependencies.now ?? (() => new Date()))().getTime() - startedAt,
      ),
      candidateCostMicros: estimateCostMicros(candidateCapture.current),
    });
  } finally {
    clearCandidateTimeout();
  }
}
