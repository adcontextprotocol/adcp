import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db/client.js';
import { createLogger } from '../logger.js';
import type { AddieClaudeClient, AddieResponse, ProcessMessageOptions, RequestTools, StreamEvent } from './claude-client.js';
import type { CostEvent } from './claude-cost-tracker.js';
import { createGeminiDirectTools, type DirectToolContext } from './gemini-direct-tools.js';
import { resolveModelCostPricing } from './model-cost-pricing.js';
import type { WebChatModelPreference } from './web-chat-model-selection.js';
import { responseClient } from './response-client.js';
import { getResponseProviderPolicy, responseProviderModel } from './response-provider-policy.js';
import { anonymousSessionSubjectHmac } from '../routes/helpers/anonymous-session-capability.js';
import { countContainedToolErrors } from './model-providers/tool-orchestration.js';

const logger = createLogger('addie-gemini-direct');
export const GEMINI_DIRECT_EXPERIMENT = 'gemini-3.7-direct-v2';
// Preserve authenticated assignments while giving anonymous web its own
// surface-scoped, versioned namespace.
const AUTHENTICATED_CONTEXT_KEY = 'gemini_direct_v1';
const AUTHENTICATED_ASSIGNMENT_SALT = 'gemini-3.7-direct-v1';
export const ANONYMOUS_WEB_CONTEXT_KEY = 'gemini_direct_web_anonymous_v1';
export const ANONYMOUS_WEB_ASSIGNMENT_VERSION = 'anonymous_web_v1';
const ANONYMOUS_WEB_ASSIGNMENT_DOMAIN = 'addie:gemini-direct:assignment:web-anonymous:v1';
export const GEMINI_PRIMARY_POLICY = 'gemini-3.7-primary-v1';
type Client = Pick<AddieClaudeClient, 'processMessage' | 'processMessageStream'>
  & Partial<Pick<AddieClaudeClient, 'getRegisteredTools' | 'forkForGeminiDirect'>>;
export interface WebToolSelection {
  requestTools: RequestTools;
  selectedToolSets: string[];
  allowedToolNames: string[];
  unavailableHint: string;
  routerMs?: number;
  routerUsage?: CostEvent;
  routerUsageComplete?: boolean;
}
type Assignment = { arm: 'control' | 'gemini'; cohort: 'staff' | 'eligible' | 'existing' | 'manual'; bucket: number };
type Surface = 'web';
type IdentityCohort = 'authenticated' | 'anonymous' | 'auth_transition';
type AssignmentUnit = 'user' | 'anonymous_owner' | 'manual_choice';
type DeliveryOutcome = 'completed' | 'interrupted';
interface ExperimentIdentity {
  surface: Surface;
  identityCohort: IdentityCohort;
  assignmentUnit: AssignmentUnit;
  assignmentVersion: string;
  contextKey: string;
  recordedUserId: string;
}

export interface ExperimentPreProviderStages {
  relationshipAnalyticsScheduleMs?: number;
  memberContextMs: number;
  workosContextMs?: number;
  experimentRoutingMs: number;
  preProviderMs: number;
}

export function geminiDirectAvailable(client: Client | null | undefined): boolean {
  return getResponseProviderPolicy().provider === 'gemini'
    && !!process.env.GEMINI_API_KEY && !!client?.forkForGeminiDirect;
}

/** Historical assignment reproduction only; global policy owns execution. */
export function geminiDirectAssignment(userId: string, staff: boolean, existing: boolean, env = process.env): Assignment | null {
  const mode = env.ADDIE_GEMINI_DIRECT_MODE;
  if (mode !== 'staff' && mode !== 'eligible') return null;
  if (mode === 'staff' && !staff) return null;
  const percent = Number(env.ADDIE_GEMINI_DIRECT_PERCENT ?? '10');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
  const bucket = createHash('sha256').update(`${AUTHENTICATED_ASSIGNMENT_SALT}:${userId}`).digest().readUInt32BE(0) % 10_000;
  return {
    arm: existing ? 'control' : mode === 'staff' || bucket < percent * 100 ? 'gemini' : 'control',
    cohort: existing ? 'existing' : mode,
    bucket,
  };
}

export function geminiAnonymousWebEnabled(env = process.env): boolean {
  return env.ADDIE_GEMINI_DIRECT_MODE === 'eligible'
    && env.ADDIE_GEMINI_DIRECT_ANONYMOUS_WEB_ENABLED === 'true';
}

/** Historical anonymous assignment reproduction from the verified owner UUID, never IP. */
export function geminiAnonymousWebAssignment(
  anonymousOwnerId: string,
  existing: boolean,
  env = process.env,
): Assignment | null {
  if (!geminiAnonymousWebEnabled(env)) return null;
  const percent = Number(env.ADDIE_GEMINI_DIRECT_ANONYMOUS_WEB_PERCENT ?? '25');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
  const digest = anonymousSessionSubjectHmac(anonymousOwnerId, ANONYMOUS_WEB_ASSIGNMENT_DOMAIN);
  const bucket = Buffer.from(digest.slice(0, 8), 'hex').readUInt32BE(0) % 10_000;
  return {
    arm: existing ? 'control' : bucket < percent * 100 ? 'gemini' : 'control',
    cohort: existing ? 'existing' : 'eligible',
    bucket,
  };
}

export function hasAnonymousGeminiDirectAssignment(context: unknown): boolean {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
  return validAssignment((context as Record<string, unknown>)[ANONYMOUS_WEB_CONTEXT_KEY]);
}

function validAssignment(value: unknown): value is Assignment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Assignment;
  return ['control', 'gemini'].includes(candidate.arm)
    && ['staff', 'eligible', 'existing'].includes(candidate.cohort)
    && Number.isInteger(candidate.bucket) && candidate.bucket >= 0 && candidate.bucket < 10_000;
}

class ExperimentTurn {
  readonly id = randomUUID();
  readonly usage: CostEvent[] = [];
  providerCalls = 0;
  routerMs = 0;
  firstVisibleMs: number | null = null;
  fallbackReason: string | null = null;
  usageComplete = true;
  fallbackToolErrors = 0;
  progressExtensions = 0;
  finalAnswerOpportunities = 0;
  finalAnswerRejectedCalls = 0;
  private stages: ExperimentPreProviderStages | null = null;

  constructor(
    readonly startedAt: number,
    readonly assignment: Assignment,
    readonly identity: ExperimentIdentity,
  ) {}

  options(options?: ProcessMessageOptions): ProcessMessageOptions {
    return {
      ...options,
      onInvocationPrepared: async snapshot => {
        this.providerCalls++;
        await options?.onInvocationPrepared?.(snapshot);
      },
      onUsageAccounted: event => {
        this.usage.push(event);
        options?.onUsageAccounted?.(event);
      },
      onTerminalBoundaryEvent: event => {
        if (event === 'progress_extension') this.progressExtensions++;
        else if (event === 'final_answer_opportunity') this.finalAnswerOpportunities++;
        else if (event === 'final_answer_rejected_call') this.finalAnswerRejectedCalls++;
        options?.onTerminalBoundaryEvent?.(event);
      },
    };
  }

  routed(selection: WebToolSelection | null) {
    this.routerMs += selection?.routerMs ?? 0;
    if (selection?.routerUsage) {
      this.usage.push(selection.routerUsage);
      this.providerCalls++;
    }
    if (selection?.routerUsageComplete === false) this.usageComplete = false;
  }

  recordPreProviderStages(stages: ExperimentPreProviderStages): void {
    this.stages = { ...stages };
  }

  async recordRelationshipAnalytics(result: { outcome: 'completed' | 'failed'; processingMs: number }): Promise<void> {
    try {
      await query(`UPDATE addie_chat_experiment_turns SET
        relationship_analytics_processing_ms = $2,
        relationship_analytics_outcome = $3
        WHERE id = $1`, [this.id, result.processingMs, result.outcome]);
    } catch (error) {
      logger.warn({ error, turnId: this.id }, 'Failed to save deferred relationship analytics timing');
    }
  }

  visible() {
    this.firstVisibleMs ??= Date.now() - this.startedAt;
  }

  async finish(response?: AddieResponse, messageId?: string, failed = false) {
    if (messageId && this.firstVisibleMs === null) this.visible();
    const execution = response?.model_execution;
    let costMicros = 0;
    for (const event of this.usage) {
      const pricing = resolveModelCostPricing(event.provider, event.model);
      if (pricing) costMicros += pricing.estimateCostMicros(event.usage);
      else this.usageComplete = false;
    }
    const recoveredToolErrors = response?.tool_executions.filter(tool => (
      tool.is_error && tool.normalized_result?.telemetry?.recovered_by_later_success === true
    )).length ?? 0;
    const totalToolErrors = this.fallbackToolErrors
      + (response?.tool_executions.filter(tool => tool.is_error).length ?? 0);
    const unrecoveredToolErrors = Math.max(0, totalToolErrors - recoveredToolErrors);
    const containedToolErrors = countContainedToolErrors(response?.tool_executions ?? [], Boolean(
      response?.text.trim() && !failed && !response.flagged && !response.output_truncation,
    ));
    logger.info({
      event: 'addie_response_stage',
      stage: 'provider_and_tools',
      turnId: this.id,
      provider_ms: response?.timing?.total_llm_ms,
      tool_ms: response?.timing?.total_tool_execution_ms,
      provider_calls: this.providerCalls,
    }, 'Addie provider and tool stages completed');
    try {
      await query(`UPDATE addie_chat_experiment_turns SET
        completed_at = COALESCE(completed_at, NOW()), first_visible_ms = $2, total_ms = $3, router_ms = $4,
        provider_calls = $5, estimated_cost_micros = $6, usage_complete = $7,
        fallback_reason = $8, actual_provider = $9, actual_model = $10,
        failed = $11, tool_errors = $12, usage = $13::jsonb,
        assistant_message_id = COALESCE($14, assistant_message_id),
        iterations = $15, progress_extensions = $16,
        final_answer_opportunities = $17, final_answer_rejected_calls = $18,
        output_truncation_source = $19, output_truncation_provider_reason = $20,
        output_truncation_original_length = $21,
        output_truncation_delivered_length = $22,
        relationship_analytics_schedule_ms = $23,
        member_context_ms = $24, workos_context_ms = $25,
        experiment_routing_ms = $26, pre_provider_ms = $27,
        provider_ms = $28, tool_ms = $29,
        recovered_tool_errors = $30, unrecovered_tool_errors = $31,
        contained_tool_errors = $32
        WHERE id = $1`, [
        this.id, this.firstVisibleMs, Date.now() - this.startedAt, this.routerMs,
        this.providerCalls, costMicros, this.usageComplete, this.fallbackReason,
        execution?.source === 'provider' ? execution.provider : null,
        execution?.source === 'provider' ? execution.model : null,
        failed || !response || response.flagged === true,
        totalToolErrors,
        JSON.stringify(this.usage), messageId ?? null,
        response?.timing?.iterations ?? null,
        this.progressExtensions, this.finalAnswerOpportunities, this.finalAnswerRejectedCalls,
        response?.output_truncation?.source ?? null,
        response?.output_truncation?.provider_reason ?? null,
        response?.output_truncation?.original_length ?? null,
        response?.output_truncation?.delivered_length ?? null,
        this.stages?.relationshipAnalyticsScheduleMs ?? null,
        this.stages?.memberContextMs ?? null,
        this.stages?.workosContextMs ?? null,
        this.stages?.experimentRoutingMs ?? null,
        this.stages?.preProviderMs ?? null,
        response?.timing?.total_llm_ms ?? null,
        response?.timing?.total_tool_execution_ms ?? null,
        recoveredToolErrors,
        unrecoveredToolErrors,
        containedToolErrors,
      ]);
    } catch (error) {
      logger.error({ error, turnId: this.id }, 'Failed to save Gemini Direct outcome');
    }
  }

  async markDelivery(outcome: DeliveryOutcome, messageId?: string, persistenceStartedAt?: number) {
    const persistenceDeliveryMs = persistenceStartedAt === undefined
      ? null
      : Math.max(0, Date.now() - persistenceStartedAt);
    logger.info({
      event: 'addie_response_stage', stage: 'persistence_delivery', turnId: this.id,
      outcome, persistence_delivery_ms: persistenceDeliveryMs,
    }, 'Addie persistence and delivery stage completed');
    try {
      await query(`UPDATE addie_chat_experiment_turns SET
        delivery_outcome = $2,
        assistant_message_id = COALESCE($3, assistant_message_id),
        persistence_delivery_ms = COALESCE($4, persistence_delivery_ms)
        WHERE id = $1`, [
        this.id, outcome, messageId ?? null,
        persistenceDeliveryMs,
      ]);
    } catch (error) {
      logger.error({ error, turnId: this.id }, 'Failed to save Gemini Direct delivery outcome');
    }
  }
}

/** Global execution policy supersedes assignment; historical assignment data is never rewritten. */
export async function prepareGeminiDirectTurn(input: DirectToolContext & {
  client: Client;
  userId?: string;
  isAdmin: boolean;
  threadId: string;
  hasPriorAssistant: boolean;
  startedAt: number;
  requestTools: RequestTools;
  baseRequestContext: string;
  getControlTools: () => Promise<WebToolSelection | null>;
  evaluation?: boolean;
  modelPreference?: WebChatModelPreference;
  anonymousOwnerId?: string;
  anonymousOrigin?: boolean;
}) {
  if (input.evaluation) return {
    client: input.client, selection: await input.getControlTools(),
    experiment: undefined as ExperimentTurn | undefined, model: undefined as string | undefined,
  };
  const policy = getResponseProviderPolicy();
  const anonymous = !!input.anonymousOwnerId || input.anonymousOrigin === true;
  const identity: ExperimentIdentity = {
    surface: 'web',
    identityCohort: input.userId ? anonymous ? 'auth_transition' : 'authenticated' : 'anonymous',
    assignmentUnit: anonymous ? 'anonymous_owner' : 'user',
    assignmentVersion: `global_${policy.provider}_v1`,
    contextKey: anonymous ? ANONYMOUS_WEB_CONTEXT_KEY : AUTHENTICATED_CONTEXT_KEY,
    recordedUserId: input.userId ?? (input.anonymousOwnerId
      ? `anonymous:${anonymousSessionSubjectHmac(input.anonymousOwnerId, ANONYMOUS_WEB_ASSIGNMENT_DOMAIN)}`
      : 'anonymous'),
  };
  const experiment = new ExperimentTurn(input.startedAt, {
    arm: policy.provider === 'gemini' ? 'gemini' : 'control',
    cohort: input.hasPriorAssistant ? 'existing' : 'eligible', bucket: 0,
  }, identity);
  try {
    await query(`INSERT INTO addie_chat_experiment_turns
      (id, experiment, thread_id, user_id, arm, cohort, exclusion_reason, started_at,
       surface, identity_cohort, assignment_unit, assignment_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
      experiment.id, GEMINI_PRIMARY_POLICY, input.threadId, identity.recordedUserId,
      experiment.assignment.arm, experiment.assignment.cohort, null, new Date(input.startedAt),
      identity.surface, identity.identityCohort, identity.assignmentUnit, identity.assignmentVersion,
    ]);
  } catch (error) {
    // Observability failure must not silently select a different provider.
    logger.error({ error }, 'Failed to save global response policy turn');
  }
  let control: WebToolSelection | null | undefined;
  const getControl = async () => control === undefined ? (control = await input.getControlTools()) : control;
  const direct = policy.provider === 'gemini'
    ? createGeminiDirectTools(input.requestTools, input.client.getRegisteredTools?.() ?? [], input.isAdmin, input)
    : null;
  const selection: WebToolSelection | null = direct ? {
    requestTools: direct.tools, selectedToolSets: direct.selectedToolSets, allowedToolNames: direct.allowedToolNames,
    unavailableHint: 'Use load_tool_group to discover the authorized tools for the next step. Loaded actions use the same account permissions, confirmations, durable reservations and receipt checks as every Addie request.',
  } : await getControl();
  if (!direct) experiment.routed(selection);
  const selectedClient = responseClient(input.client, 'web', {
    onFailure(reason, executions) {
      experiment.fallbackReason = reason;
      experiment.usageComplete = false;
      experiment.fallbackToolErrors = executions.filter(tool => tool.is_error).length;
    },
    async fallbackOptions(options) {
      const routed = await getControl();
      experiment.routed(routed);
      return {
        tools: routed?.requestTools ?? input.requestTools,
        options: {
          ...options, directToolSession: undefined,
          allowedToolNames: routed?.allowedToolNames,
          selectedToolSetNames: routed?.selectedToolSets,
          requestContext: [input.baseRequestContext, routed?.unavailableHint].filter(Boolean).join('\n\n'),
        },
      };
    },
  });
  const processOptions = (options?: ProcessMessageOptions) => {
    return experiment.options({ ...options,
      ...(direct && {
        // The executor intersects this session with the exact allowlist and
        // the caller's authorization/replay policy.
        directToolSession: direct.session,
      }),
    });
  };
  const client: Client = {
    async processMessage(message, history, tools, rules, options) {
      if (!direct) {
        let response: AddieResponse | undefined;
        try {
          response = await selectedClient.processMessage(message, history, tools, rules, processOptions(options));
          return response;
        } finally {
          if (!response) experiment.usageComplete = false;
          await experiment.finish(response);
        }
      }
      // Web JSON uses the same checkpoint-aware, buffered logical turn as SSE.
      let response: AddieResponse | undefined;
      for await (const event of client.processMessageStream(message, history, tools, options)) {
        if (event.type === 'done') response = event.response;
        if (event.type === 'stream_error' || event.type === 'error') throw new Error('Addie provider response failed');
      }
      if (!response) throw new Error('Addie provider response missing');
      experiment.firstVisibleMs = null;
      return response;
    },
    async *processMessageStream(message, history, tools, options) {
      let response: AddieResponse | undefined;
      try {
        for await (const event of selectedClient.processMessageStream(message, history, tools, processOptions(options))) {
          if (event.type === 'text') experiment.visible();
          if (event.type === 'done') response = event.response;
          yield event;
        }
      } finally {
        if (!response) experiment.usageComplete = false;
        await experiment.finish(response);
      }
    },
  };
  return { client, selection, experiment, model: responseProviderModel() };
}

/** Read-only staff view; transcript content stays in the existing admin review UI. */
async function getResults(experimentId: string) {
  // Once a user chooses a model, that conversation's history can influence
  // every later answer. Keep all its turns out of the randomized cohorts.
  const result = await query(`WITH reported_turns AS (
    SELECT e.*, CASE WHEN EXISTS (
      SELECT 1 FROM addie_chat_experiment_turns manual
      WHERE manual.experiment = e.experiment AND manual.thread_id = e.thread_id
        AND manual.cohort = 'manual'
    ) OR EXISTS (
      SELECT 1 FROM addie_thread_messages chosen
      WHERE $1 = 'gemini-3.7-direct-v2' AND chosen.thread_id = e.thread_id AND chosen.role = 'user'
        AND chosen.model_preference IN ('gemini', 'sonnet')
    ) THEN 'manual' ELSE e.cohort END AS reporting_cohort
    FROM addie_chat_experiment_turns e WHERE e.experiment = $1
  ) SELECT e.surface, e.identity_cohort, e.assignment_unit, e.assignment_version,
    e.arm, e.reporting_cohort AS cohort, e.exclusion_reason,
    COUNT(*)::int AS turns, COUNT(DISTINCT e.user_id)::int AS users,
    COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS incomplete,
    COUNT(*) FILTER (WHERE delivery_outcome = 'completed')::int AS delivered,
    COUNT(*) FILTER (WHERE delivery_outcome = 'interrupted')::int AS interrupted,
    COUNT(*) FILTER (WHERE delivery_outcome IS NULL)::int AS delivery_unknown,
    COUNT(*) FILTER (WHERE failed)::int AS failures,
    COUNT(*) FILTER (WHERE arm = 'gemini' AND actual_provider = 'anthropic')::int AS fallbacks,
    COUNT(*) FILTER (WHERE fallback_reason = 'provider_error' AND actual_provider = 'anthropic')::int AS provider_error_fallbacks,
    COUNT(*) FILTER (WHERE fallback_reason = 'provider_error_after_action')::int AS post_action_provider_failures,
    COUNT(*) FILTER (WHERE NOT usage_complete)::int AS incomplete_usage,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY pre_provider_ms) AS median_pre_provider_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY pre_provider_ms) AS p95_pre_provider_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY provider_ms) AS median_provider_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY provider_ms) AS p95_provider_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY tool_ms) AS median_tool_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY tool_ms) AS p95_tool_ms,
    ROUND(AVG(member_context_ms)) AS mean_member_context_ms,
    ROUND(AVG(workos_context_ms)) AS mean_workos_context_ms,
    ROUND(AVG(experiment_routing_ms)) AS mean_experiment_routing_ms,
    ROUND(AVG(persistence_delivery_ms)) AS mean_persistence_delivery_ms,
    ROUND(AVG(relationship_analytics_schedule_ms)) AS mean_relationship_analytics_schedule_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY relationship_analytics_processing_ms) AS median_relationship_analytics_processing_ms,
    COUNT(*) FILTER (WHERE relationship_analytics_outcome = 'completed')::int AS relationship_analytics_completed,
    COUNT(*) FILTER (WHERE relationship_analytics_outcome = 'failed')::int AS relationship_analytics_failed,
    COUNT(*) FILTER (WHERE relationship_analytics_outcome IS NULL AND relationship_analytics_schedule_ms IS NOT NULL)::int AS relationship_analytics_pending,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY iterations) AS median_iterations,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY iterations) AS p95_iterations,
    MAX(iterations)::int AS max_iterations,
    COUNT(*) FILTER (WHERE iterations > 10)::int AS turns_over_ten_iterations,
    SUM(progress_extensions)::int AS progress_extensions,
    SUM(final_answer_opportunities)::int AS final_answer_opportunities,
    SUM(final_answer_rejected_calls)::int AS final_answer_rejected_calls,
    COUNT(*) FILTER (WHERE output_truncation_source = 'provider_output_limit')::int AS provider_output_truncations,
    COUNT(*) FILTER (WHERE output_truncation_source = 'local_character_limit')::int AS local_character_truncations,
    ROUND(AVG(first_visible_ms)) AS mean_first_visible_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS median_total_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_total_ms,
    ROUND(AVG(router_ms)) AS mean_router_ms,
    SUM(estimated_cost_micros) / 1000000.0 AS recorded_cost_usd,
    CASE WHEN bool_and(usage_complete AND completed_at IS NOT NULL)
      THEN SUM(estimated_cost_micros) / 1000000.0 END AS estimated_cost_usd,
    SUM(tool_errors)::int AS tool_errors,
    SUM(recovered_tool_errors)::int AS recovered_tool_errors,
    SUM(unrecovered_tool_errors)::int AS unrecovered_tool_errors,
    SUM(contained_tool_errors)::int AS contained_tool_errors,
    SUM(unrecovered_tool_errors - contained_tool_errors)::int AS unresolved_tool_errors,
    COUNT(*) FILTER (WHERE contained_tool_errors IS NOT NULL)::int AS tool_recovery_classified_turns,
    SUM(tool_errors - recovered_tool_errors) FILTER (WHERE contained_tool_errors IS NULL)::int AS tool_recovery_unclassified_errors,
    COUNT(m.rating)::int AS rated_turns, ROUND(AVG(m.rating), 2) AS mean_rating,
    COUNT(*) FILTER (WHERE m.outcome = 'resolved')::int AS resolved_turns,
    CASE WHEN bool_and(usage_complete AND completed_at IS NOT NULL)
      THEN SUM(estimated_cost_micros) / 1000000.0 /
        NULLIF(COUNT(*) FILTER (WHERE m.outcome = 'resolved'), 0)
      END AS estimated_cost_per_marked_resolution_usd
    FROM reported_turns e
    LEFT JOIN addie_thread_messages m ON m.message_id = e.assistant_message_id
    GROUP BY e.surface, e.identity_cohort, e.assignment_unit, e.assignment_version,
      e.arm, e.reporting_cohort, e.exclusion_reason
    ORDER BY e.surface, e.identity_cohort, e.reporting_cohort, e.arm`, [experimentId]);
  return {
    experiment: GEMINI_DIRECT_EXPERIMENT,
    mode: process.env.ADDIE_GEMINI_DIRECT_MODE ?? 'off',
    authenticated_web_percent: Number(process.env.ADDIE_GEMINI_DIRECT_PERCENT ?? '10'),
    anonymous_web: {
      enabled: geminiAnonymousWebEnabled(),
      percent: Number(process.env.ADDIE_GEMINI_DIRECT_ANONYMOUS_WEB_PERCENT ?? '25'),
      assignment_version: ANONYMOUS_WEB_ASSIGNMENT_VERSION,
    },
    cohorts: result.rows,
    tool_recovery_definitions: {
      recovered_tool_errors: 'Later success with the exact operation, agent URL, and idempotency key.',
      unrecovered_tool_errors: 'Errors without exact recovery, including contained errors; retained for historical comparison.',
      contained_tool_errors: 'Validation rejection followed by a successful read from the same agent and a complete generated answer. Observed continuation, not original-operation success or fulfillment; delivery is reported separately.',
      unresolved_tool_errors: 'Classified errors with neither exact recovery nor observed containment. Absence of evidence, not a judgment of answer quality.',
      tool_recovery_unclassified_errors: 'Errors without exact recovery on historical or incomplete turns without containment classification; excluded from contained and unresolved counts.',
    },
  };
}

export async function getGeminiDirectResults() {
  const historical = await getResults(GEMINI_DIRECT_EXPERIMENT);
  const primary = await getResults(GEMINI_PRIMARY_POLICY);
  return { ...historical, response_policy: getResponseProviderPolicy(),
    global_policy: { experiment: GEMINI_PRIMARY_POLICY, cohorts: primary.cohorts } };
}
