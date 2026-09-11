import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db/client.js';
import { createLogger } from '../logger.js';
import type { AddieClaudeClient, AddieResponse, ProcessMessageOptions, RequestTools, StreamEvent } from './claude-client.js';
import type { CostEvent } from './claude-cost-tracker.js';
import { createGeminiDirectTools } from './gemini-direct-tools.js';
import { GoogleGenerateContentProvider, GOOGLE_ROUTER_MODEL } from './model-providers/google-generate-content-provider.js';
import { resolveModelCostPricing } from './model-cost-pricing.js';

const logger = createLogger('addie-gemini-direct');
export const GEMINI_DIRECT_EXPERIMENT = 'gemini-3.7-direct-v1';
const CONTEXT_KEY = 'gemini_direct_v1';
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
type Assignment = { arm: 'control' | 'gemini'; cohort: 'staff' | 'eligible' | 'existing'; bucket: number };
const clients = new WeakMap<Client, AddieClaudeClient>();

/** Stable across workers/restarts. Raising the percentage only enrolls new threads. */
export function geminiDirectAssignment(userId: string, staff: boolean, existing: boolean, env = process.env): Assignment | null {
  const mode = env.ADDIE_GEMINI_DIRECT_MODE;
  if (mode !== 'staff' && mode !== 'eligible') return null;
  if (mode === 'staff' && !staff) return null;
  const percent = Number(env.ADDIE_GEMINI_DIRECT_PERCENT ?? '10');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
  const bucket = createHash('sha256').update(`${GEMINI_DIRECT_EXPERIMENT}:${userId}`).digest().readUInt32BE(0) % 10_000;
  return {
    arm: existing ? 'control' : mode === 'staff' || bucket < percent * 100 ? 'gemini' : 'control',
    cohort: existing ? 'existing' : mode,
    bucket,
  };
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

  constructor(readonly startedAt: number, readonly assignment: Assignment) {}

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
    try {
      await query(`UPDATE addie_chat_experiment_turns SET
        completed_at = NOW(), first_visible_ms = $2, total_ms = $3, router_ms = $4,
        provider_calls = $5, estimated_cost_micros = $6, usage_complete = $7,
        fallback_reason = $8, actual_provider = $9, actual_model = $10,
        failed = $11, tool_errors = $12, usage = $13::jsonb,
        assistant_message_id = COALESCE($14, assistant_message_id)
        WHERE id = $1`, [
        this.id, this.firstVisibleMs, Date.now() - this.startedAt, this.routerMs,
        this.providerCalls, costMicros, this.usageComplete, this.fallbackReason,
        execution?.source === 'provider' ? execution.provider : null,
        execution?.source === 'provider' ? execution.model : null,
        failed || !response || response.flagged === true,
        this.fallbackToolErrors + (response?.tool_executions?.filter(tool => tool.is_error).length ?? 0),
        JSON.stringify(this.usage), messageId ?? null,
      ]);
    } catch (error) {
      logger.error({ error, turnId: this.id }, 'Failed to save Gemini Direct outcome');
    }
  }
}

function fallbackResponse(response: AddieResponse, handoff: boolean): AddieResponse {
  return {
    ...response,
    model_execution: response.model_execution.source === 'provider' ? {
      ...response.model_execution,
      requested_provider: 'google', requested_model: GOOGLE_ROUTER_MODEL,
      model_resolution: 'fallback',
      fallback_reason: handoff ? 'primary_capability_unsupported' : 'primary_unavailable',
    } : {
      ...response.model_execution, requested_provider: 'google', requested_model: GOOGLE_ROUTER_MODEL,
    },
  };
}

/** Select before routing: the treatment never pays for an up-front router call. */
export async function prepareGeminiDirectTurn(input: {
  client: Client;
  userId?: string;
  isAdmin: boolean;
  threadId: string;
  hasPriorAssistant: boolean;
  exclusionReason: string | null;
  startedAt: number;
  requestTools: RequestTools;
  baseRequestContext: string;
  getControlTools: () => Promise<WebToolSelection | null>;
  /** Evaluation routes must never enroll live experiment traffic. */
  evaluation?: boolean;
}) {
  let controlTools: WebToolSelection | null | undefined;
  const getControl = async () => controlTools === undefined
    ? (controlTools = await input.getControlTools()) : controlTools;
  const ordinary = async () => ({ client: input.client, selection: await getControl(), experiment: undefined as ExperimentTurn | undefined, model: undefined as string | undefined });
  const proposed = input.userId && !input.evaluation && process.env.GEMINI_API_KEY
    && input.client.forkForGeminiDirect
    ? geminiDirectAssignment(input.userId, input.isAdmin, input.hasPriorAssistant) : null;
  if (!proposed) return ordinary();

  let assignment: Assignment;
  let experiment: ExperimentTurn;
  try {
    // One atomic UPDATE elects the winner even when two requests start together.
    const assigned = await query<{ assignment: unknown }>(`UPDATE addie_threads SET
      context = CASE WHEN context ? $2 THEN context ELSE
        COALESCE(context, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) END
      WHERE thread_id = $1 RETURNING context -> $2 AS assignment`,
    [input.threadId, CONTEXT_KEY, JSON.stringify(proposed)]);
    const stored = assigned.rows[0]?.assignment;
    if (!validAssignment(stored)) return ordinary();
    assignment = stored;
    experiment = new ExperimentTurn(input.startedAt, assignment);
    await query(`INSERT INTO addie_chat_experiment_turns
      (id, experiment, thread_id, user_id, arm, cohort, exclusion_reason, started_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      experiment.id, GEMINI_DIRECT_EXPERIMENT, input.threadId, input.userId,
      assignment.arm, assignment.cohort, input.exclusionReason, new Date(input.startedAt),
    ]);
  } catch (error) {
    logger.error({ error }, 'Gemini Direct assignment unavailable; retaining control');
    return ordinary();
  }

  const treatment = assignment.arm === 'gemini' && !input.exclusionReason;
  const direct = treatment ? createGeminiDirectTools(input.requestTools, input.client.getRegisteredTools?.() ?? [], input.isAdmin) : null;
  let candidate: AddieClaudeClient | undefined;
  if (direct) {
    candidate = clients.get(input.client);
    if (!candidate) {
      candidate = input.client.forkForGeminiDirect!(new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY!));
      clients.set(input.client, candidate);
    }
  }
  const selection: WebToolSelection | null = direct ? {
    requestTools: direct.tools,
    selectedToolSets: direct.selectedToolSets,
    allowedToolNames: direct.allowedToolNames,
    unavailableHint: 'You can load another read-only tool group when needed. For work outside these groups, call handoff_to_addie.',
  } : await getControl();
  if (!direct) experiment.routed(selection);

  const controlOptions = async (options?: ProcessMessageOptions) => {
    const routed = await getControl();
    experiment.routed(routed);
    return {
      tools: routed?.requestTools ?? input.requestTools,
      options: experiment.options({
        ...options, modelOverride: undefined, directToolSession: undefined,
        allowedToolNames: routed?.allowedToolNames,
        selectedToolSetNames: routed?.selectedToolSets,
        requestContext: [input.baseRequestContext, routed?.unavailableHint].filter(Boolean).join('\n\n'),
      }),
    };
  };
  const directOptions = (options?: ProcessMessageOptions): ProcessMessageOptions => experiment.options({
    ...options, modelOverride: GOOGLE_ROUTER_MODEL, disableServerTools: true,
    directToolSession: direct!.session,
    toolExecutionPolicy: async request => ({ allowed: (await direct!.policy(request)).allowed
      && (!options?.toolExecutionPolicy || (await options.toolExecutionPolicy(request)).allowed) }),
  });

  const client: Client = {
    async processMessage(message, history, tools, rules, options) {
      if (!direct) {
        try {
          const response = await input.client.processMessage(message, history, tools, rules, experiment.options(options));
          await experiment.finish(response);
          return response;
        } catch (error) {
          experiment.usageComplete = false;
          await experiment.finish(undefined, undefined, true);
          throw error;
        }
      }
      let response: AddieResponse | undefined;
      for await (const event of client.processMessageStream(message, history, tools, options)) {
        if (event.type === 'done') response = event.response;
        if (event.type === 'stream_error' || event.type === 'error') throw new Error('Addie provider response failed');
      }
      if (!response) throw new Error('Addie provider response missing');
      // JSON delivery becomes visible after the route persists the reply.
      experiment.firstVisibleMs = null;
      return response;
    },
    async *processMessageStream(message, history, tools, options) {
      let response: AddieResponse | undefined;
      try {
        if (direct && candidate) {
          const buffered: StreamEvent[] = [];
          let failed = false;
          try {
            for await (const event of candidate.processMessageStream(message, history, tools, directOptions(options))) {
              buffered.push(event);
              if (event.type === 'done') response = event.response;
              if (event.type === 'error' || event.type === 'stream_error') failed = true;
            }
          } catch { failed = true; }
          const handoff = direct.session.handoffRequested();
          const localFailure = response?.model_execution.source === 'local'
            && ['provider_error', 'stream_interrupted'].includes(response.model_execution.reason);
          if (!failed && !handoff && !localFailure && response) {
            for (const event of buffered) {
              if (event.type === 'text') experiment.visible();
              yield event;
            }
            return;
          }
          experiment.fallbackReason = handoff ? 'capability_handoff' : 'provider_error';
          experiment.fallbackToolErrors = buffered.filter(event => event.type === 'tool_end' && event.is_error).length;
          if (failed && !handoff) experiment.usageComplete = false;
          const fallback = await controlOptions(options);
          response = undefined;
          for await (const event of input.client.processMessageStream(message, history, fallback.tools, fallback.options)) {
            if (event.type === 'text') experiment.visible();
            if (event.type === 'done') {
              response = fallbackResponse(event.response, handoff);
              yield { ...event, response };
            } else yield event;
          }
        } else {
          for await (const event of input.client.processMessageStream(message, history, tools, experiment.options(options))) {
            if (event.type === 'text') experiment.visible();
            if (event.type === 'done') response = event.response;
            yield event;
          }
        }
      } finally {
        if (!response) experiment.usageComplete = false;
        await experiment.finish(response);
      }
    },
  };
  return { client, selection, experiment, model: direct ? GOOGLE_ROUTER_MODEL : undefined };
}

/** Read-only staff view; transcript content stays in the existing admin review UI. */
export async function getGeminiDirectResults() {
  const result = await query(`SELECT e.arm, e.cohort, e.exclusion_reason,
    COUNT(*)::int AS turns, COUNT(DISTINCT e.user_id)::int AS users,
    COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS incomplete,
    COUNT(*) FILTER (WHERE failed)::int AS failures,
    COUNT(*) FILTER (WHERE fallback_reason IS NOT NULL)::int AS fallbacks,
    COUNT(*) FILTER (WHERE NOT usage_complete)::int AS incomplete_usage,
    ROUND(AVG(first_visible_ms)) AS mean_first_visible_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS median_total_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_total_ms,
    ROUND(AVG(router_ms)) AS mean_router_ms,
    SUM(estimated_cost_micros) / 1000000.0 AS estimated_cost_usd,
    SUM(tool_errors)::int AS tool_errors,
    COUNT(m.rating)::int AS rated_turns, ROUND(AVG(m.rating), 2) AS mean_rating,
    COUNT(*) FILTER (WHERE m.outcome = 'resolved')::int AS resolved_turns,
    SUM(estimated_cost_micros) / 1000000.0 /
      NULLIF(COUNT(*) FILTER (WHERE m.outcome = 'resolved'), 0) AS estimated_cost_per_marked_resolution_usd
    FROM addie_chat_experiment_turns e
    LEFT JOIN addie_thread_messages m ON m.message_id = e.assistant_message_id
    WHERE experiment = $1
    GROUP BY e.arm, e.cohort, e.exclusion_reason ORDER BY e.cohort, e.arm`, [GEMINI_DIRECT_EXPERIMENT]);
  return { experiment: GEMINI_DIRECT_EXPERIMENT, mode: process.env.ADDIE_GEMINI_DIRECT_MODE ?? 'off', cohorts: result.rows };
}
