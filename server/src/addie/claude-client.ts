/**
 * Claude client for Addie - handles LLM interactions with tool use
 *
 * System prompt is built from markdown rule files in ./rules/,
 * with tool reference always appended from code.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash, createHmac } from 'node:crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('addie-claude-client');
import type { AddieTool } from './types.js';
import {
  ADDIE_FALLBACK_PROMPT,
  buildAddieScopedToolReference,
  buildAddieStableToolReference,
  buildMessageTurnsWithMetadata,
} from './prompts.js';
import { AddieDatabase } from '../db/addie-db.js';
import { AddieModelConfig } from '../config/models.js';
import { getCurrentConfigVersionId } from './config-version.js';
import {
  loadCoreRules,
  loadConstraintRules,
  loadResponseStyle,
  loadScopedRules,
  invalidateRulesCache,
} from './rules/index.js';
import { isAllowedImageType } from './mcp/url-tools.js';
import { withRetry, isRetryableError, RetriesExhaustedError, type RetryConfig } from '../utils/anthropic-retry.js';
import { formatTokenCount, getConversationTokenLimit, buildDroppedMessagesSummary, type MessageTurn } from '../utils/token-limiter.js';
import { notifySystemError } from './error-notifier.js';
import {
  checkCostCap,
  recordCost,
  releaseCertificationReserve,
  renewCertificationReserve,
  formatCapExceededMessage,
  type UserTier,
} from './claude-cost-tracker.js';
import {
  EMPTY_RESPONSE_FALLBACK,
  applyResponsePipeline,
  stripBannedRituals,
  hasPersonaCollapse,
} from './response-postprocess.js';
import type { AddieInputAttachment } from './chat-attachments.js';
import type {
  ModelExecution,
  ModelFallbackReason,
  ModelMessage,
  ModelMessageContent,
  ModelProvider,
  ModelProviderId,
  ModelRequest,
  ModelResponse,
  ModelSystemBlock,
  ModelToolChoice,
  ModelToolCallContent,
  ModelToolDefinition,
  ModelToolResultContent,
  ModelUsage,
  PreparedModelInvocation,
} from './model-providers/model-provider.js';
import { attemptSiblingModelFallback } from './model-providers/model-fallback.js';
import {
  AnthropicModelProvider,
  type AnthropicMessagesTransport,
} from './model-providers/anthropic-provider.js';
import {
  ModelTurnLoopState,
} from './model-providers/model-turn.js';
import {
  AddieToolExecutionLedger,
  createAddieToolExecutor,
  orchestrateAcceptedAddieTurn,
  type AddieAcceptedTurnDecision,
  type AddieExecutionMode,
  type ToolExecution,
  type ToolExecutionPolicy,
  type ToolHandler,
} from './model-providers/tool-orchestration.js';
export type {
  AddieExecutionMode,
  ToolExecution,
  ToolExecutionPolicy,
  ToolExecutionPolicyDecision,
  ToolExecutionPolicyRequest,
} from './model-providers/tool-orchestration.js';
import {
  formatProviderUnavailableMessage,
  ProviderHealthController,
  type ProviderAvailability,
} from './model-providers/provider-health.js';
import { getProviderRetryAfterSeconds } from './model-providers/provider-errors.js';
import {
  buildModelToolDefinitions,
} from './tool-wire-shape.js';
import { assembleAddieRequestTools } from './request-tool-assembly.js';
import { assembleAddieFallbackPrompt } from './prompt-assembly.js';
import {
  MAX_OUTPUT_LENGTH,
  formatTruncatedOutput,
} from './security.js';
import {
  renderToolExecutionsFallback,
  type ToolResultPresentation,
} from './tool-result-contract.js';
import { enforceFailedLookupEvidenceBoundary } from './failed-lookup-evidence.js';

export interface InvocationPreparedSnapshot {
  execution_mode: AddieExecutionMode;
  model: string;
  iteration: number;
  attempt: number;
  system_blocks: Array<{ index: number; sha256: string }>;
  tool_schemas: Array<{ index: number; name: string; sha256: string }>;
  message_payloads: Array<{ index: number; sha256: string }>;
  message_count: number;
  /** HMAC/SHA-256 of the exact object handed to the selected provider SDK. */
  provider_request_sha256: string;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const SONNET_5_MAX_OUTPUT_TOKENS = 32_768;
// The Anthropic SDK rejects non-streaming requests whose calculated timeout
// may exceed ten minutes. Sonnet 5 at 32k crosses that guard; streaming does
// not, so keep the larger budget there and cap only non-streaming calls.
const SONNET_5_MAX_NONSTREAMING_OUTPUT_TOKENS = 16_384;

function addieModelOutputControls(
  model: string,
  maxOutputTokens?: number,
): { maxOutputTokens: number; reasoning?: { effort: 'medium' } } {
  if (/^claude-sonnet-5(?:-|$)/.test(model)) {
    return {
      maxOutputTokens: Math.min(
        SONNET_5_MAX_OUTPUT_TOKENS,
        maxOutputTokens ?? SONNET_5_MAX_OUTPUT_TOKENS,
      ),
      reasoning: { effort: 'medium' },
    };
  }
  return {
    maxOutputTokens: Math.min(
      DEFAULT_MAX_OUTPUT_TOKENS,
      maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ),
  };
}

function isIsolatedExecution(options?: ProcessMessageOptions): boolean {
  return options?.executionMode === 'evaluation'
    || options?.executionMode === 'replay'
    || options?.executionMode === 'shadow';
}

function isExactlyOnceExecution(options?: ProcessMessageOptions): boolean {
  return options?.executionMode === 'replay' || options?.executionMode === 'shadow';
}

function hashPreparedPayload(
  value: string,
  executionMode: AddieExecutionMode,
  key?: string,
  domain?: string,
): string {
  const hasKey = typeof key === 'string' && key.length > 0;
  const hasDomain = typeof domain === 'string' && domain.length > 0;

  // Evaluation provenance is only attributable when both caller-owned HMAC
  // inputs are present. A partial configuration must never silently fall back
  // to an unkeyed digest. Production callers that do not request HMAC hashing
  // retain the historical SHA-256 behavior.
  if (hasKey || hasDomain || executionMode !== 'production') {
    if (!hasKey || !hasDomain) return 'unavailable';
    return createHmac('sha256', key)
      .update('addie-invocation\0', 'utf8')
      .update(String(Buffer.byteLength(domain, 'utf8')), 'utf8')
      .update('\0', 'utf8')
      .update(domain, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedModelContentTypes(content: ModelMessageContent[]): string[] {
  return [...new Set(content.map((block) => block.type))].sort();
}

function boundedContentTypes(
  content: Anthropic.Beta.BetaMessage['content'],
): string[] {
  const categories = content.map((block) => {
    switch (block.type) {
      case 'text':
      case 'thinking':
      case 'redacted_thinking':
      case 'tool_use':
      case 'server_tool_use':
      case 'web_search_tool_result':
        return block.type;
      default:
        return 'other';
    }
  });
  return [...new Set(categories)].sort();
}

/** Build the provider-neutral form of historical turns for live orchestration. */
function toModelMessages(turns: MessageTurn[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let toolIdCounter = 0;

  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
      const content: ModelMessageContent[] = [];
      if (turn.content.trim()) content.push({ type: 'text', text: turn.content });
      const toolResults: ModelToolResultContent[] = [];
      for (const toolCall of turn.toolCalls) {
        const toolCallId = `hist_${toolIdCounter++}`;
        content.push({
          type: 'tool_call',
          id: toolCallId,
          name: toolCall.name,
          input: (
            toolCall.input
            && typeof toolCall.input === 'object'
            && !Array.isArray(toolCall.input)
              ? toolCall.input
              : {}
          ) as ModelToolCallContent['input'],
        });
        toolResults.push({
          type: 'tool_result',
          toolCallId,
          toolName: toolCall.name,
          content: toolCall.result,
          isError: toolCall.is_error ?? false,
        });
      }
      if (content.length === 0) {
        messages.push({ role: turn.role, content: [{ type: 'text', text: turn.content }] });
      } else {
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: toolResults });
      }
    } else {
      messages.push({ role: turn.role, content: [{ type: 'text', text: turn.content }] });
    }
  }

  return messages;
}

function appendModelInputAttachments(
  messages: ModelMessage[],
  attachments?: AddieInputAttachment[],
): ModelMessage[] {
  if (!attachments || attachments.length === 0) return messages;
  const attachmentContent: ModelMessageContent[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      if (!isAllowedImageType(attachment.media_type)) {
        logger.warn({ mediaType: attachment.media_type }, 'Addie: Invalid image media type in user attachment');
        continue;
      }
      attachmentContent.push(
        { type: 'image', mediaType: attachment.media_type, data: attachment.data },
        { type: 'text', text: `[Uploaded image: ${attachment.filename || 'image'}]` },
      );
    } else if (attachment.type === 'document') {
      attachmentContent.push(
        { type: 'document', mediaType: 'application/pdf', data: attachment.data },
        { type: 'text', text: `[Uploaded PDF: ${attachment.filename || 'document'}]` },
      );
    }
  }
  if (attachmentContent.length === 0) return messages;

  const nextMessages = messages.map((message) => ({
    ...message,
    content: [...message.content],
  }));
  let currentTurn = nextMessages[nextMessages.length - 1];
  if (!currentTurn || currentTurn.role !== 'user') {
    currentTurn = { role: 'user', content: [] };
    nextMessages.push(currentTurn);
  }
  currentTurn.content.push(...attachmentContent);
  return nextMessages;
}

/**
 * Action-claiming patterns mapped to the tools that should back them up.
 * Hoisted to module scope to avoid re-allocation on every response.
 */
export const HALLUCINATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; expectedTools: string[] }> = [
  { pattern: /invoice\s+(?:resent|sent)\s+successfully/i, expectedTools: ['resend_invoice', 'send_invoice', 'send_payment_request'] },
  { pattern: /(?:successfully\s+)?resent\s+(?:the\s+)?invoice/i, expectedTools: ['resend_invoice', 'send_invoice', 'send_payment_request'] },
  { pattern: /(?:billing\s+)?email\s+(?:updated|changed)\s+successfully/i, expectedTools: ['update_billing_email'] },
  { pattern: /(?:I'?ve\s+|I\s+)?resolved\s+(?:the\s+)?escalation/i, expectedTools: ['resolve_escalation'] },
  { pattern: /escalation\s+#?\d+\s+(?:has been\s+)?resolved/i, expectedTools: ['resolve_escalation'] },
  { pattern: /meeting\s+(?:scheduled|created)\s+successfully/i, expectedTools: ['schedule_meeting'] },
  { pattern: /(?:I'?ve\s+|I\s+)?(?:created|generated|sent)\s+(?:a\s+)?payment\s+link/i, expectedTools: ['create_payment_link'] },
  { pattern: /(?:I'?ve\s+|I\s+)?(?:sent|delivered)\s+(?:a\s+)?(?:DM|direct message|notification)/i, expectedTools: ['send_member_dm', 'resolve_escalation'] },
  { pattern: /(?:I'?ve\s+|I\s+)?added\s+\S+(?:\s+\S+){0,5}\s+to\s+the\s+(?:meeting|call|series)/i, expectedTools: ['add_meeting_attendee'] },
  // Fake-escalation patterns. `escalate_to_admin` is in the always-available
  // tool set, so claiming an escalation/notification was made without firing
  // it is the same class of fabrication as the rest. Real GitHub-issue tools
  // count too because Addie sometimes describes filing a ticket as creating
  // an issue.
  //
  // The two creation-verb patterns require a first-person subject so we
  // don't fire on "see ticket 42" or "Stripe opened a ticket on your behalf"
  // — those are informational, not fabricated actions. The "team notified"
  // pattern stays loose because it's the primary signal for the original
  // failure shape ("Done — the team has been notified (ticket #228)") where
  // no other pattern fits the punctuation context.
  { pattern: /(?:I'?ve|I\s+just|I)\s+(?:created|opened|filed|generated)\s+(?:a\s+)?(?:support\s+)?ticket\s+#?\d+/i, expectedTools: ['escalate_to_admin', 'create_github_issue', 'draft_github_issue'] },
  { pattern: /(?:the\s+)?team\s+(?:has\s+been\s+|will\s+be\s+|is\s+being\s+)notified/i, expectedTools: ['escalate_to_admin'] },
  { pattern: /I'?ve\s+(?:flagged|escalated|notified)\s+(?:this|the\s+team|the\s+admins?)/i, expectedTools: ['escalate_to_admin'] },
  { pattern: /(?:I'?ve|I\s+just)\s+(?:created|opened|filed)\s+(?:a\s+)?(?:support\s+)?(?:ticket|issue)\b/i, expectedTools: ['escalate_to_admin', 'create_github_issue', 'draft_github_issue'] },
];

/**
 * Detect possible hallucinated actions in response text.
 * Returns a flag reason if the text claims to have completed an action
 * but no corresponding tool was actually called AND succeeded.
 */
export function detectHallucinatedAction(text: string, toolExecutions: readonly ToolExecution[]): string | null {
  for (const { pattern, expectedTools } of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      // Check that a matching tool was called AND succeeded (not just called)
      const hasSuccessfulTool = expectedTools.some(t =>
        toolExecutions.some(exec => exec.tool_name === t && !exec.is_error)
      );
      if (!hasSuccessfulTool) {
        return `Possible hallucinated action: text matches "${pattern.source}" but none of [${expectedTools.join(', ')}] succeeded`;
      }
    }
  }

  return null;
}

/**
 * Empty-turn detector (#3721). The user gets nothing back when the model
 * produces no text AND no successful tool calls — same UX as a transport
 * drop, and the signature failure mode behind silent invoice-tool failures.
 * Returns a reason string when this happens so the caller can flag + log it.
 */
export function detectEmptyTurn(text: string, toolExecutions: readonly ToolExecution[]): string | null {
  if (text.length > 0) return null;
  const successful = toolExecutions.filter(t => !t.is_error).length;
  if (successful > 0) return null;
  const errored = toolExecutions.length - successful;
  return `Empty turn: no text and no successful tool calls (toolExecutions=${toolExecutions.length}, errored=${errored})`;
}

export const ADDIE_EMPTY_RESPONSE_FALLBACK = EMPTY_RESPONSE_FALLBACK;

/**
 * Empty response detector for user-facing recovery. `detectEmptyTurn` remains
 * the stricter "no text + no successful tools" safety flag, but any blank
 * final text is a bad chat UX because most surfaces do not render raw tool
 * results to the user.
 */
export function detectEmptyResponse(text: string, toolExecutions: readonly ToolExecution[]): string | null {
  if (text.trim().length > 0) return null;

  const strictReason = detectEmptyTurn(text, toolExecutions);
  if (strictReason) return strictReason;

  const successful = toolExecutions.filter(t => !t.is_error).length;
  const errored = toolExecutions.length - successful;
  return `Empty response: no text after tool use (toolExecutions=${toolExecutions.length}, successful=${successful}, errored=${errored})`;
}

function applyResponsePipelineWithEmptyMonitoring(
  question: string,
  rawText: string,
  toolExecutions: readonly ToolExecution[],
): { text: string; reason: string | null } {
  const stripped = stripBannedRituals(rawText);
  const reason = detectEmptyResponse(stripped, toolExecutions);
  if (reason) {
    const toolFallback = renderToolExecutionsFallback(toolExecutions, (toolName, renderReason) => {
      logger.warn(
        { event: 'addie_tool_result_display_degraded', toolName, reason: renderReason },
        'Addie: Tool result renderer failed; safe text fallback used',
      );
    });
    return { text: toolFallback || EMPTY_RESPONSE_FALLBACK, reason };
  }
  // Fires only when Addie broke character and the deterministic backstop had
  // to scrub a model/provider disclosure — rare by design. A rising rate means
  // the prompt-level identity rule is slipping (e.g. after a model change).
  const personaCollapsed = hasPersonaCollapse(rawText);
  if (personaCollapsed) {
    logger.warn(
      { toolExecutionCount: toolExecutions.length },
      'Addie: persona-collapse disclosure scrubbed from response',
    );
  }
  const text = applyResponsePipeline(question, rawText);
  if (personaCollapsed && text === EMPTY_RESPONSE_FALLBACK) {
    return {
      text,
      reason: 'Empty response after persona-collapse safety rewrite',
    };
  }
  return { text, reason: null };
}

interface FinalizedAssistantText {
  text: string;
  emptyReason: string | null;
  localReplacementReason: string | null;
  lengthExceeded: boolean;
}

/** Apply the safety/style pipeline exactly once before any terminal delivery. */
function finalizeAssistantText(
  question: string,
  rawText: string,
  toolExecutions: readonly ToolExecution[],
  forceTruncation: boolean = false,
): FinalizedAssistantText {
  const evidenceBoundary = enforceFailedLookupEvidenceBoundary(rawText, toolExecutions);
  if (evidenceBoundary.enforced) {
    logger.warn(
      {
        event: 'addie_failed_lookup_evidence_boundary',
        failedToolNames: evidenceBoundary.failedToolNames,
      },
      'Addie: Replaced unsupported provider prose after failed source lookups',
    );
  }
  const processed = applyResponsePipelineWithEmptyMonitoring(
    question,
    evidenceBoundary.text,
    toolExecutions,
  );
  const lengthExceeded = processed.text.length > MAX_OUTPUT_LENGTH;
  const truncated = forceTruncation || lengthExceeded;
  return {
    text: truncated ? formatTruncatedOutput(processed.text) : processed.text,
    emptyReason: processed.reason,
    localReplacementReason: evidenceBoundary.reason,
    lengthExceeded,
  };
}

function reportEmptyResponseFallback(
  reason: string,
  toolsUsed: readonly string[],
  toolExecutions: readonly ToolExecution[],
  options: ProcessMessageOptions | undefined,
  source: 'processMessage' | 'processMessageStream',
  model: string,
  iteration: number,
): void {
  if (isIsolatedExecution(options)) return;

  const successful = toolExecutions.filter(t => !t.is_error).length;
  const errored = toolExecutions.length - successful;
  const toolNames = toolsUsed.length > 0 ? toolsUsed.join(', ') : 'none';
  const userKey = options?.slackUserId
    ? `slack:${options.slackUserId}`
    : options?.costScope?.userId
      ? options.costScope.userId
      : options?.userDisplayName
        ? `display:${options.userDisplayName}`
        : 'unknown';

  logger.error(
    {
      event: 'addie_empty_response_fallback',
      source,
      reason,
      threadId: options?.threadId,
      user: userKey,
      model,
      iteration,
      toolsUsed,
      toolExecutionCount: toolExecutions.length,
      successfulToolExecutions: successful,
      erroredToolExecutions: errored,
    },
    'Addie: Empty response fallback returned to user',
  );

  notifySystemError({
    source: 'addie-empty-response',
    errorMessage: [
      `${source}: ${reason}`,
      `thread_id=${options?.threadId ?? 'unknown'}`,
      `user=${userKey}`,
      `model=${model}`,
      `iteration=${iteration}`,
      `tools_used=${toolNames}`,
      `tool_executions=${toolExecutions.length} successful=${successful} errored=${errored}`,
    ].join('\n'),
  });
}

/** Default max tool iterations for regular users */
export const DEFAULT_MAX_ITERATIONS = 10;

/** Elevated max tool iterations for certification sessions (teaching + assessment + exercises + completion + credentials) */
export const CERTIFICATION_MAX_ITERATIONS = 20;

/** Elevated max tool iterations for admin users doing bulk operations */
export const ADMIN_MAX_ITERATIONS = 25;

/**
 * Per-request tools that can be added dynamically
 */
export interface RequestTools {
  tools: AddieTool[];
  handlers: Map<string, ToolHandler>;
}

/**
 * Result from createUserScopedTools including admin status
 */
export interface UserScopedToolsResult {
  tools: RequestTools;
  isAAOAdmin: boolean;
}

/**
 * Options for message processing
 */
export interface ProcessMessageOptions {
  /** Request-local execution mode. Evaluation, replay, and shadow suppress operational side effects. */
  executionMode?: AddieExecutionMode;
  /** Exclude provider-managed tools such as web search for this request only. */
  disableServerTools?: boolean;
  /**
   * Exact request-local custom-tool allowlist. When present, global and
   * request-scoped tools outside this list are omitted before prompt sizing,
   * schema construction, and handler dispatch.
   */
  allowedToolNames?: readonly string[];
  /** Router-selected capability sets used to scope prompt guidance/catalog. */
  selectedToolSetNames?: readonly string[];
  /** Optional first-turn tool requirement chosen by trusted orchestration. */
  initialToolChoice?: ModelToolChoice;
  /** Dedicated key for HMACing private invocation payloads in evaluation provenance. */
  invocationHashKey?: string;
  /** Caller-owned HMAC domain separator. Must be supplied with invocationHashKey. */
  invocationHashDomain?: string;
  /** Fail-closed hook evaluated immediately before each custom handler dispatch. */
  toolExecutionPolicy?: ToolExecutionPolicy;
  /**
   * Called immediately before a provider invocation with hashes of the exact,
   * ordered system and tool payloads. Transcript content is intentionally absent.
   */
  onInvocationPrepared?: (
    snapshot: InvocationPreparedSnapshot,
  ) => void | Promise<void>;
  /** Maximum tool iterations (default: DEFAULT_MAX_ITERATIONS) */
  maxIterations?: number;
  /** Override the default model for this request (e.g., for billing queries requiring precision) */
  modelOverride?: string;
  /** Per-request context (member info, channel, goals) appended to system prompt */
  requestContext?: string;
  /** Override max messages for conversation history (default: 20, certification sessions use 50) */
  maxMessages?: number;
  /** Slack user ID — used for error notifications so admins know who was affected */
  slackUserId?: string;
  /** Fallback display name for error notifications when slackUserId is unavailable (e.g. web chat) */
  userDisplayName?: string;
  /** Thread ID — used for error notification links to admin view */
  threadId?: string;
  /**
   * User identity + tier for the per-user Anthropic cost cap (#2790).
   * Callers must pass either `costScope` (to apply the cap) OR
   * `uncapped: true` (to opt out explicitly for router / system
   * paths). When both are missing, claude-client logs a warn with
   * `event: 'cost_cap_unwired'` so observability catches future
   * callers that ship without either (#2950).
   */
  costScope?: {
    userId: string;
    tier: UserTier;
    /** Bounded extra daily budget available only while a certification module is active. */
    certificationReserveUsd?: number;
  };
  /**
   * Explicit opt-out for system / router callers that shouldn't
   * count against a per-user budget.
   */
  uncapped?: true;
  /**
   * Display name of the speaker who sent `userMessage`. When set and the
   * thread has multiple distinct human speakers, every user-role turn —
   * including the current one — is prefixed with `[name]:` so the model
   * can tell speakers apart. Used for Slack channel threads where an
   * admin may reply mid-thread to a non-member's question.
   */
  currentSpeakerName?: string;
  /**
   * Current-turn files uploaded through the web chat composer. These are
   * passed to Claude for this request only; persisted thread history remains
   * textual to avoid storing base64 blobs in the conversation table.
   */
  inputAttachments?: AddieInputAttachment[];
}

/**
 * Override for system prompt - used by eval framework to test proposed rules
 */
export interface RulesOverride {
  systemPrompt: string;
}

export interface AddieResponse {
  text: string;
  tools_used: string[];
  /** Detailed execution log for each tool call */
  tool_executions: ToolExecution[];
  flagged: boolean;
  flag_reason?: string;
  /** Rule IDs that were active for this interaction (for logging/analysis) */
  active_rule_ids?: number[];
  /** Configuration version ID for this interaction */
  config_version_id?: number;
  /** Provider execution identity or an explicit local-response classification. */
  model_execution: ModelExecution;
  /** Timing breakdown for each phase of processing */
  timing?: {
    system_prompt_ms: number;
    total_llm_ms: number;
    total_tool_execution_ms: number;
    iterations: number;
  };
  /** Provider-normalized token and cache usage for this delivered turn. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  capacity?: {
    certification_reserve_used: boolean;
  };
}

function toAddieUsage(usage: ModelUsage): NonNullable<AddieResponse['usage']> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...((usage.cacheWriteTokens ?? 0) > 0 && {
      cache_creation_input_tokens: usage.cacheWriteTokens,
    }),
    ...((usage.cacheReadTokens ?? 0) > 0 && {
      cache_read_input_tokens: usage.cacheReadTokens,
    }),
  };
}

function providerModelExecution(
  response: Pick<ModelResponse, 'provider' | 'model'>,
  requestedProvider: ModelProviderId,
  requestedModel: string,
  fallbackReason: ModelFallbackReason | null = null,
): ModelExecution {
  // A configured alias can resolve to the same provider model as the original
  // request. Persist that as exact/canonicalized rather than violating the DB
  // invariant that fallback provenance must identify a genuinely different
  // provider or model; the attempted fallback remains in bounded server logs.
  const effectiveFallbackReason = fallbackReason
    && (response.provider !== requestedProvider || response.model !== requestedModel)
    ? fallbackReason
    : null;
  return {
    source: 'provider',
    requested_provider: requestedProvider,
    requested_model: requestedModel,
    provider: response.provider,
    model: response.model,
    model_resolution: effectiveFallbackReason
      ? 'fallback'
      : response.model === requestedModel
        ? 'exact'
        : 'provider_canonicalized',
    fallback_reason: effectiveFallbackReason,
  };
}

function localModelExecution(
  reason: Extract<ModelExecution, { source: 'local' }>['reason'],
  requestedProvider: ModelProviderId,
  requestedModel: string,
): ModelExecution {
  return {
    source: 'local',
    requested_provider: requestedProvider,
    requested_model: requestedModel,
    reason,
  };
}

const MAX_ITERATIONS_FALLBACK_TEXT = "I'm having trouble completing that request. Could you try rephrasing?";

interface TerminalAddieResponseCommon {
  userMessage: string;
  rawText: string;
  toolsUsed: readonly string[];
  toolExecutions: readonly ToolExecution[];
  requestedProvider: ModelProviderId;
  requestedModel: string;
  fallbackReason: ModelFallbackReason | null;
  configVersionId: number | null | undefined;
  usage: NonNullable<AddieResponse['usage']>;
  timing: NonNullable<AddieResponse['timing']>;
  certificationReserveUsed?: boolean;
}

type TerminalAddieResponseInput = TerminalAddieResponseCommon & (
  | {
      kind: 'provider';
      disposition: 'complete' | 'truncated';
      providerResponse: Pick<ModelResponse, 'provider' | 'model' | 'providerFinishReason'>;
    }
  | {
      kind: 'max_iterations';
      lastProviderModel: string | null | undefined;
    }
);

interface TerminalAddieResponseResult {
  response: AddieResponse;
  finalized: FinalizedAssistantText;
  hallucinationReason: string | null;
}

/** Build the provider-neutral terminal payload before delivery returns or emits it. */
function buildTerminalAddieResponse(input: TerminalAddieResponseInput): TerminalAddieResponseResult {
  const hasProviderText = input.rawText.length > 0;
  const terminalRawText = input.kind === 'max_iterations' && !hasProviderText
    ? MAX_ITERATIONS_FALLBACK_TEXT
    : input.rawText;
  const finalized = finalizeAssistantText(
    input.userMessage,
    terminalRawText,
    input.toolExecutions,
    input.kind === 'provider' && input.disposition === 'truncated',
  );
  const hallucinationReason = input.kind === 'provider' && input.disposition === 'complete'
    ? detectHallucinatedAction(finalized.text, input.toolExecutions)
    : null;
  const flagReason = input.kind === 'max_iterations'
    ? 'Max tool iterations reached'
    : input.disposition === 'truncated'
      ? `Response truncated: ${input.providerResponse.providerFinishReason}`
      : finalized.lengthExceeded
        ? 'Output truncated due to length'
        : finalized.localReplacementReason ?? hallucinationReason ?? finalized.emptyReason;

  let modelExecution: ModelExecution;
  if (finalized.emptyReason) {
    modelExecution = localModelExecution(
      'no_provider_response',
      input.requestedProvider,
      input.requestedModel,
    );
  } else if (finalized.localReplacementReason) {
    modelExecution = localModelExecution(
      'canned_response',
      input.requestedProvider,
      input.requestedModel,
    );
  } else if (input.kind === 'provider') {
    modelExecution = providerModelExecution(
      input.providerResponse,
      input.requestedProvider,
      input.requestedModel,
      input.fallbackReason,
    );
  } else if (hasProviderText && input.lastProviderModel) {
    modelExecution = providerModelExecution(
      { provider: input.requestedProvider, model: input.lastProviderModel },
      input.requestedProvider,
      input.requestedModel,
      input.fallbackReason,
    );
  } else {
    modelExecution = localModelExecution(
      'canned_response',
      input.requestedProvider,
      input.requestedModel,
    );
  }

  return {
    finalized,
    hallucinationReason,
    response: {
      text: finalized.text,
      tools_used: [...input.toolsUsed],
      tool_executions: [...input.toolExecutions],
      flagged: !!flagReason,
      flag_reason: flagReason ?? undefined,
      active_rule_ids: undefined,
      config_version_id: input.configVersionId ?? undefined,
      model_execution: modelExecution,
      timing: input.timing,
      usage: input.usage,
      ...(input.certificationReserveUsed !== undefined && {
        capacity: { certification_reserve_used: input.certificationReserveUsed },
      }),
    },
  };
}

function providerUnavailableResponse(
  availability: ProviderAvailability,
  requestedProvider: ModelProviderId,
  requestedModel: string,
  toolsUsed: readonly string[] = [],
  toolExecutions: readonly ToolExecution[] = [],
  certificationReserveUsed = false,
): AddieResponse {
  const baseMessage = formatProviderUnavailableMessage(availability);
  const text = toolExecutions.some(execution => !execution.is_error)
    ? `${baseMessage} Some requested actions may already have completed, so review the results above before retrying.`
    : baseMessage;
  return {
    text,
    tools_used: [...toolsUsed],
    tool_executions: [...toolExecutions],
    flagged: true,
    flag_reason: `provider_unavailable:${availability.category ?? 'unknown'}`,
    model_execution: localModelExecution('provider_error', requestedProvider, requestedModel),
    capacity: { certification_reserve_used: certificationReserveUsed },
  };
}

/**
 * Event types emitted during streaming
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; tool_name: string; parameters: Record<string, unknown> }
  | {
      type: 'tool_end';
      tool_name: string;
      result: string;
      is_error: boolean;
      normalized_result?: ToolResultPresentation;
      /** Exact completed receipt used by delivery adapters for checkpoints. */
      execution: ToolExecution;
    }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | {
      // Mid-stream upstream failure after deltas were already received. Anthropic
      // streaming has no resumption token and prompt cache only dedupes input —
      // retrying produces a fresh sample, so we cannot stitch attempts together.
      // Consumers should render a recovery banner and drop the partial assistant
      // turn from conversation history (see issue #4797).
      type: 'stream_error';
      reason: string;
      deltasBeforeError: number;
      tool_executions: ToolExecution[];
      certification_reserve_used: boolean;
    }
  | { type: 'done'; response: AddieResponse }
  | { type: 'error'; error: string };

interface PayloadDebugStats {
  model: string;
  iteration: number;
  system_block_count: number;
  system_chars: number;
  request_context_chars: number;
  tool_count: number;
  tool_chars: number;
  message_count: number;
  message_chars: number;
  largest_message?: { index: number; role: string; chars: number };
}

/**
 * Injectable provider seam for isolated full-response evaluation. Alternate
 * providers remain barred from production delivery until provider-specific
 * accounting and rollout gates are in place.
 */
export interface AddieModelProviderBinding {
  provider: ModelProvider;
  /** Provider instance whose transport performs exactly one SDK submission. */
  exactlyOnceProvider?: ModelProvider;
}

export class AddieClaudeClient {
  private readonly modelProvider: ModelProvider;
  private readonly exactlyOnceModelProvider: ModelProvider;
  private model: string;
  private tools: AddieTool[] = [];
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private addieDb: AddieDatabase;
  private readonly providerHealth: ProviderHealthController;
  private webSearchEnabled: boolean = true; // Enable web search for external questions

  constructor(
    apiKey: string,
    model: string = AddieModelConfig.chat,
    providerHealth: ProviderHealthController = new ProviderHealthController(),
    providerBinding?: AddieModelProviderBinding,
  ) {
    if (providerBinding) {
      this.modelProvider = providerBinding.provider;
      this.exactlyOnceModelProvider = providerBinding.exactlyOnceProvider
        ?? providerBinding.provider;
    } else {
      const client = new Anthropic({ apiKey });
      const transport = client as unknown as AnthropicMessagesTransport;
      this.modelProvider = new AnthropicModelProvider(
        apiKey,
        transport,
        { transportMaxRetries: 2 },
      );
      this.exactlyOnceModelProvider = new AnthropicModelProvider(
        apiKey,
        transport,
        { transportMaxRetries: 0 },
      );
    }
    if (this.exactlyOnceModelProvider.id !== this.modelProvider.id) {
      throw new Error('Normal and exactly-once Addie providers must use the same provider');
    }
    this.model = model;
    this.addieDb = new AddieDatabase();
    this.providerHealth = providerHealth;
  }

  /**
   * Enable or disable web search capability
   */
  setWebSearchEnabled(enabled: boolean): void {
    this.webSearchEnabled = enabled;
  }

  isWebSearchEnabled(): boolean {
    return this.webSearchEnabled;
  }

  /**
   * Get the system prompt from markdown rule files. Stable core instructions
   * come first for provider caching, routed rules sit beside routed tool
   * guidance, and constraints + response-style.md remain last.
   *
   * Validated by the prompt-variant eval (server/tests/manual/prompt-variant-eval.ts):
   * on Sonnet 4.6, this ordering cuts mean response length 13% and shape
   * violations 2/12 vs the prior order on a fixed question battery, with
   * zero default-template or banned-ritual regressions.
   *
   * Rules are loaded from ./rules/*.md files (cached in memory after first
   * read). The request-scoped tool reference is tied to the exact tool wire
   * surface and selected domains. Fallback prompt is used only when rule
   * files cannot be read.
   */
  private buildSystemBlocks(
    availableToolNames: readonly string[],
    selectedToolSetNames?: readonly string[],
    requestContext?: string,
    rulesOverride?: RulesOverride,
  ): ModelSystemBlock[] {
    if (rulesOverride) {
      return [
        { text: rulesOverride.systemPrompt, cacheHint: 'ephemeral' },
        ...(requestContext?.trim() ? [{ text: requestContext }] : []),
      ];
    }

    const stableToolReference = buildAddieStableToolReference();
    const scopedToolReference = buildAddieScopedToolReference({
      availableToolNames,
      selectedToolSetNames,
    });
    try {
      const basePrompt = loadCoreRules();
      const scopedRules = loadScopedRules(selectedToolSetNames ?? []);
      const constraints = loadConstraintRules();
      const responseStyle = loadResponseStyle();
      return [
        {
          text: `${basePrompt}\n\n---\n\n${stableToolReference}`,
          cacheHint: 'ephemeral',
        },
        {
          text: [scopedRules, scopedToolReference].filter(Boolean).join('\n\n---\n\n'),
        },
        ...(requestContext?.trim() ? [{ text: requestContext }] : []),
        { text: `${constraints}\n\n---\n\n${responseStyle}` },
      ];
    } catch (error) {
      logger.warn({ error }, 'Addie: Failed to load rules from files, using fallback prompt');
      return [
        {
          text: assembleAddieFallbackPrompt(ADDIE_FALLBACK_PROMPT, stableToolReference),
          cacheHint: 'ephemeral',
        },
        { text: scopedToolReference },
        ...(requestContext?.trim() ? [{ text: requestContext }] : []),
      ];
    }
  }

  private estimateMessageContentChars(content: readonly ModelMessageContent[]): number {
    let total = 0;
    for (const block of content) {
      if (block.type === 'text') total += block.text.length;
      if (block.type === 'image' || block.type === 'document') total += block.data.length;
      if (block.type === 'tool_call') total += block.name.length + JSON.stringify(block.input).length;
      if (block.type === 'tool_result') {
        total += block.toolName?.length ?? 0;
        total += typeof block.content === 'string'
          ? block.content.length
          : JSON.stringify(block.content).length;
      }
      if (block.type === 'provider_tool_call') {
        total += block.name.length + JSON.stringify(block.inputKeys).length;
      }
      if (block.type === 'provider_tool_result') total += block.name.length;
      if (block.type === 'provider_state') total += block.kind.length;
    }
    return total;
  }

  private buildPayloadDebugStats(
    request: ModelRequest,
    iteration: number = 0,
    requestContextChars: number = 0,
  ): PayloadDebugStats {
    const systemChars = request.system.reduce((sum, block) => sum + block.text.length, 0);

    let largestMessage: PayloadDebugStats['largest_message'];
    let messageChars = 0;
    for (let i = 0; i < request.messages.length; i++) {
      const chars = this.estimateMessageContentChars(request.messages[i].content);
      messageChars += chars;
      if (!largestMessage || chars > largestMessage.chars) {
        largestMessage = { index: i, role: request.messages[i].role, chars };
      }
    }

    const toolPayloads = [...request.tools, ...(request.providerTools ?? [])];

    return {
      model: request.model,
      iteration,
      system_block_count: request.system.length,
      system_chars: systemChars,
      request_context_chars: requestContextChars,
      tool_count: toolPayloads.length,
      tool_chars: JSON.stringify(toolPayloads).length,
      message_count: request.messages.length,
      message_chars: messageChars,
      largest_message: largestMessage,
    };
  }

  private isPromptOverflow(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('prompt is too long')) return true;
    // RetriesExhaustedError wraps the original — check .cause
    if (error instanceof RetriesExhaustedError) {
      const causeMsg = error.cause instanceof Error ? error.cause.message : String(error.cause);
      if (causeMsg.includes('prompt is too long')) return true;
    }
    return false;
  }

  private logPromptOverflow(error: unknown, payload: PayloadDebugStats, source: string): void {
    if (!this.isPromptOverflow(error)) return;

    const message = error instanceof Error ? error.message : String(error);
    // Parse actual token count from Anthropic error (e.g., "... 2457832 tokens ...")
    const tokenMatch = message.match(/(\d[\d,]+)\s*tokens/);
    const reportedTokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, ''), 10) : undefined;

    logger.error(
      {
        source,
        error: message,
        reported_tokens: reportedTokens,
        payload,
      },
      'Addie: Prompt overflow diagnostics'
    );
  }

  private buildInvocationPreparedSnapshot(
    options: ProcessMessageOptions | undefined,
    modelRequest: ModelRequest,
    preparedInvocation: PreparedModelInvocation,
    iteration: number,
    attempt: number,
  ): InvocationPreparedSnapshot {
    const executionMode = options?.executionMode ?? 'production';
    const hash = (value: unknown) => hashPreparedPayload(
      JSON.stringify(value),
      executionMode,
      options?.invocationHashKey,
      options?.invocationHashDomain,
    );
    const providerRequest = preparedInvocation.providerRequest;
    const diagnosticComponents = preparedInvocation.diagnosticComponents;
    const systemBlocks = diagnosticComponents?.systemBlocks ?? modelRequest.system;
    const toolPayloads = diagnosticComponents?.toolSchemas
      ?? [
          ...modelRequest.tools.map((tool) => ({ name: tool.name, payload: tool })),
          ...(modelRequest.providerTools ?? []).map((tool) => ({
            name: `provider:${tool.type}`,
            payload: tool,
          })),
        ];
    const messagePayloads = diagnosticComponents?.messagePayloads ?? modelRequest.messages;
    return {
      execution_mode: executionMode,
      model: preparedInvocation.model,
      iteration,
      attempt,
      system_blocks: systemBlocks.map((block, index) => ({
        index,
        sha256: hash(block),
      })),
      tool_schemas: toolPayloads.map(({ name, payload }, index) => ({
        index,
        name,
        sha256: hash(payload),
      })),
      message_payloads: messagePayloads.map((message, index) => ({
        index,
        sha256: hash(message),
      })),
      message_count: messagePayloads.length,
      provider_request_sha256: hash(providerRequest),
    };
  }

  private async notifyInvocationPrepared(
    options: ProcessMessageOptions | undefined,
    modelRequest: ModelRequest,
    preparedInvocation: PreparedModelInvocation,
    iteration: number,
    attempt: number,
  ): Promise<void> {
    if (!options?.onInvocationPrepared) return;
    await options.onInvocationPrepared(this.buildInvocationPreparedSnapshot(
      options,
      modelRequest,
      preparedInvocation,
      iteration,
      attempt,
    ));
  }

  private recordedToolParameters(
    options: ProcessMessageOptions | undefined,
    toolInput: Record<string, unknown>,
  ): Record<string, unknown> {
    return isIsolatedExecution(options) ? {} : toolInput;
  }

  /**
   * Invalidate the cached system prompt (forces re-read of rule files)
   */
  invalidateCache(): void {
    invalidateRulesCache();
  }

  /**
   * Register a tool
   */
  registerTool(tool: AddieTool, handler: ToolHandler): void {
    this.tools.push(tool);
    this.toolHandlers.set(tool.name, handler);
  }

  /** Confirm a production client has every definition and handler in a bounded profile. */
  hasRegisteredTools(toolNames: readonly string[]): boolean {
    const definitions = new Set(this.tools.map((tool) => tool.name));
    return toolNames.every((name) => definitions.has(name) && this.toolHandlers.has(name));
  }

  /**
   * Copy the registered tool surface into a provider-isolated client. This is
   * deliberately not a production selector: alternate providers remain
   * blocked by the operational guards in both message entry points.
   */
  forkForIsolatedProvider(
    model: string,
    providerBinding: AddieModelProviderBinding,
  ): AddieClaudeClient {
    const fork = new AddieClaudeClient('', model, undefined, providerBinding);
    fork.tools = [...this.tools];
    fork.toolHandlers = new Map(this.toolHandlers);
    fork.webSearchEnabled = false;
    return fork;
  }

  /** Assemble the shared prompt, tool surface, history, and attachments for either delivery mode. */
  private prepareFirstInvocation(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    rulesOverride?: RulesOverride,
    options?: ProcessMessageOptions,
    delivery: 'non_streaming' | 'streaming' = 'non_streaming',
  ) {
    const requestWebSearchEnabled = delivery === 'non_streaming'
      && this.webSearchEnabled
      && !isIsolatedExecution(options)
      && options?.disableServerTools !== true;
    const effectiveModel = options?.modelOverride ?? this.model;
    const allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : null;
    const assembledTools = assembleAddieRequestTools(
      this.tools,
      this.toolHandlers,
      requestTools,
      options?.allowedToolNames,
      allowedToolNames,
    );
    const allTools = assembledTools.tools;
    const allHandlers = assembledTools.handlers;

    const promptStart = Date.now();
    const systemBlocks = this.buildSystemBlocks(
      allTools.map(tool => tool.name),
      options?.selectedToolSetNames,
      options?.requestContext,
      rulesOverride,
    );
    const systemPromptMs = Date.now() - promptStart;

    const toolCount = allTools.length + (requestWebSearchEnabled ? 1 : 0);
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
    const messageTurnsResult = buildMessageTurnsWithMetadata(userMessage, threadContext, {
      model: effectiveModel,
      toolCount,
      maxMessages: options?.maxMessages,
      compactToolResults: true,
      currentSpeakerName: options?.currentSpeakerName,
    });

    if (messageTurnsResult.wasTrimmed && messageTurnsResult.messagesRemoved > 10) {
      const summary = messageTurnsResult.droppedMessages
        ? buildDroppedMessagesSummary(messageTurnsResult.droppedMessages)
        : null;
      const contextWarning = summary
        || `\n\n## Context Warning\n${messageTurnsResult.messagesRemoved} earlier messages were dropped from this conversation to fit the context window. If the user references something you don't recall, let them know and suggest starting a new thread for better accuracy.`;
      systemBlocks.push({ text: contextWarning });
    }

    const modelMessages = appendModelInputAttachments(
      toModelMessages(messageTurnsResult.messages),
      options?.inputAttachments,
    );
    const modelTools = buildModelToolDefinitions(allTools);

    return {
      effectiveModel,
      systemBlocks,
      allHandlers,
      toolsByName,
      toolCount,
      messageTurnsResult,
      modelMessages,
      modelTools,
      requestWebSearchEnabled,
      systemPromptMs,
    };
  }

  private buildModelRequest(
    effectiveModel: string,
    systemBlocks: ModelSystemBlock[],
    tools: ModelToolDefinition[],
    messages: ModelMessage[],
    providerWebSearchEnabled: boolean,
    maxOutputTokens?: number,
    streaming = false,
    toolChoice?: ModelToolChoice,
  ): ModelRequest {
    const safeMaxOutputTokens = !streaming && /^claude-sonnet-5(?:-|$)/.test(effectiveModel)
      ? Math.min(
        SONNET_5_MAX_NONSTREAMING_OUTPUT_TOKENS,
        maxOutputTokens ?? SONNET_5_MAX_NONSTREAMING_OUTPUT_TOKENS,
      )
      : maxOutputTokens;
    const controls = addieModelOutputControls(effectiveModel, safeMaxOutputTokens);
    return {
      model: effectiveModel,
      system: systemBlocks.map((block) => ({
        text: block.text,
        ...(this.modelProvider.id === 'anthropic'
          && block.cacheHint === 'ephemeral'
          ? { cacheHint: 'ephemeral' as const }
          : {}),
      })),
      messages,
      tools,
      ...(toolChoice && { toolChoice }),
      ...(providerWebSearchEnabled && { providerTools: [{ type: 'web_search' as const }] }),
      ...(controls.reasoning && { reasoning: controls.reasoning }),
      maxOutputTokens: controls.maxOutputTokens,
    };
  }

  /**
   * Prepare provenance for the exact first non-streaming model invocation.
   * This performs prompt/tool/message assembly only: it does not call the
   * provider, invoke tools, run cost/config tracking, or fire the callback.
   */
  prepareMessageInvocation(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    rulesOverride?: RulesOverride,
    options?: ProcessMessageOptions,
  ): InvocationPreparedSnapshot {
    const prepared = this.prepareFirstInvocation(
      userMessage,
      threadContext,
      requestTools,
      rulesOverride,
      options,
    );
    const modelRequest = this.buildModelRequest(
      prepared.effectiveModel,
      prepared.systemBlocks,
      prepared.modelTools,
      prepared.modelMessages,
      prepared.requestWebSearchEnabled,
      undefined,
      false,
      options?.initialToolChoice,
    );
    const preparedInvocation = this.modelProvider.prepare(modelRequest);
    return this.buildInvocationPreparedSnapshot(
      options,
      modelRequest,
      preparedInvocation,
      1,
      1,
    );
  }

  /**
   * Process a message and return a response
   * Uses database-backed rules for the system prompt when available
   *
   * @param userMessage - The user's message
   * @param threadContext - Optional thread history
   * @param requestTools - Optional per-request tools (e.g., user-scoped member tools)
   * @param rulesOverride - Optional rules override for eval framework (bypasses DB lookup)
   * @param options - Optional processing options (e.g., maxIterations for admin users)
   */
  async processMessage(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    rulesOverride?: RulesOverride,
    options?: ProcessMessageOptions
  ): Promise<AddieResponse> {
    const operationalExecution = !isIsolatedExecution(options);
    const requestedModel = options?.modelOverride ?? this.model;
    if (operationalExecution && this.modelProvider.id !== 'anthropic') {
      throw new Error('Alternate Addie model providers are restricted to isolated execution');
    }

    // #2950: warn when a caller has neither `costScope` nor explicit
    // `uncapped: true`. Silent default meant a future user-facing
    // caller could ship uncapped and nobody would notice — this log
    // turns that into an observability signal. A hard throw would
    // break legitimate callers we haven't migrated yet; loud-log
    // lets audit rules alert on the event.
    if (operationalExecution && !options?.costScope && !options?.uncapped) {
      logger.warn(
        { event: 'cost_cap_unwired', method: 'processMessage' },
        'claude-client called without costScope or uncapped:true — cost cap silently bypassed',
      );
    }

    // #2790: per-user model cost cap. Check exact pricing at entry; when the
    // user has exhausted their daily budget, return a friendly
    // "try again later" response instead of firing another
    // (billable) Claude call. The caller's ProcessMessageOptions
    // carries both `userId` and `tier` so we don't have to resolve
    // the subscription tier here.
    if (operationalExecution) {
      const capResult = await checkCostCap(
        options?.costScope?.userId,
        options?.costScope?.tier ?? 'anonymous',
        { selection: { provider: this.modelProvider.id, model: requestedModel } },
      );
      if (!capResult.ok) {
        const message = formatCapExceededMessage(capResult)
          + (options?.costScope?.certificationReserveUsd ? ' Your certification progress is saved.' : '');
        logger.warn(
          {
            userId: options?.costScope?.userId,
            tier: options?.costScope?.tier,
            spentCents: capResult.spentCents,
            retryAfterMs: capResult.retryAfterMs,
          },
          'Addie cost admission refused — refusing model call',
        );
        return {
          text: message,
          tools_used: [],
          tool_executions: [],
          flagged: true,
          flag_reason: 'cost_cap_exceeded',
          model_execution: localModelExecution(
            'cost_cap_exceeded',
            this.modelProvider.id,
            requestedModel,
          ),
        };
      }
    }

    // Reserve a half-open probe only after local gates have passed so a
    // request that never reaches the provider cannot hold the probe lease.
    if (operationalExecution) {
      const availability = this.providerHealth.acquire(this.modelProvider.id, 'chat');
      if (!availability.allowed) {
        return providerUnavailableResponse(
          availability,
          this.modelProvider.id,
          requestedModel,
        );
      }
    }

    const executionLedger = new AddieToolExecutionLedger();
    const toolsUsed = executionLedger.toolsUsed;
    const toolExecutions = executionLedger.executions;

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    const prepared = this.prepareFirstInvocation(
      userMessage,
      threadContext,
      requestTools,
      rulesOverride,
      options,
    );
    const {
      effectiveModel,
      systemBlocks,
      allHandlers,
      toolsByName,
      toolCount,
      messageTurnsResult,
      modelMessages,
      modelTools,
      requestWebSearchEnabled,
    } = prepared;
    const executeToolCall = createAddieToolExecutor(
      [...toolsByName.values()],
      allHandlers,
      {
        executionMode: options?.executionMode ?? 'production',
        policy: options?.toolExecutionPolicy,
        notificationContext: {
          slackUserId: options?.slackUserId,
          userDisplayName: options?.userDisplayName,
          threadId: options?.threadId,
        },
      },
    );
    systemPromptMs = prepared.systemPromptMs;

    if (rulesOverride) {
      logger.debug('Addie: Using rules override');
    }

    // Get config version ID for this interaction (skip for eval mode)
    const configVersionId = rulesOverride || !operationalExecution
      ? undefined
      : await getCurrentConfigVersionId();

    const modelLoop = new ModelTurnLoopState(options?.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    const recordAccumulatedCost = async () => {
      if (!operationalExecution || !options?.costScope) return;
      for (const event of modelLoop.accountedUsage) {
        await recordCost(options.costScope.userId, event);
      }
    };

    // Log if using precision model
    if (options?.modelOverride && options.modelOverride !== this.model) {
      logger.info({ model: effectiveModel, defaultModel: this.model }, 'Addie: Using precision model for billing/financial query');
    }

    if (messageTurnsResult.wasTrimmed) {
      logger.info(
        {
          messagesRemoved: messageTurnsResult.messagesRemoved,
          estimatedTokens: formatTokenCount(messageTurnsResult.estimatedTokens),
          tokenLimit: formatTokenCount(getConversationTokenLimit(effectiveModel, toolCount)),
          toolCount,
        },
        'Addie: Trimmed conversation history to fit context limit'
      );
    }
    let iteration = 0;
    let hasExecutedCustomTool = false;
    let activeModel = effectiveModel;
    let modelFallbackReason: ModelFallbackReason | null = null;

    while (modelLoop.hasRemaining) {
      const activeTurn = modelLoop.beginNext();
      iteration = activeTurn.iteration;

      // Use beta API to access web search
      const llmStart = Date.now();
      let response!: ModelResponse;
      let reusedEmptyResponse = false;
      const recoveryInvocation = modelLoop.emptyResponseRecovery.prepareInvocation();
      const invocationTools = recoveryInvocation.toolsAllowed ? modelTools : [];
      let invocationAttempt = 0;
      let lastModelRequest: ModelRequest | undefined;
      const invokeProvider = async (exactlyOnce: boolean, model = activeModel) => {
        invocationAttempt++;
        const modelRequest = this.buildModelRequest(
          model,
          systemBlocks,
          invocationTools,
          modelMessages,
          recoveryInvocation.toolsAllowed && requestWebSearchEnabled,
          recoveryInvocation.isRecovery ? DEFAULT_MAX_OUTPUT_TOKENS : undefined,
          false,
          iteration === 1 && invocationTools.length > 0
            ? options?.initialToolChoice
            : undefined,
        );
        lastModelRequest = modelRequest;
        const provider = exactlyOnce
          ? this.exactlyOnceModelProvider
          : this.modelProvider;
        return activeTurn.invoke(
          provider,
          modelRequest,
          {
            beforeDispatch: async (preparedInvocation) => {
              await this.notifyInvocationPrepared(
                options,
                modelRequest,
                preparedInvocation,
                iteration,
                invocationAttempt,
              );
            },
          },
        );
      };
      try {
        // Replay and shadow are exactly-once paid experiments. A timeout can
        // occur after provider acceptance, so neither our outer retry helper
        // nor the provider SDK may submit the request again.
        response = isExactlyOnceExecution(options) || recoveryInvocation.requiresExactlyOnce
          ? await invokeProvider(true)
          : await withRetry(
            () => invokeProvider(false),
            { maxRetries: 3, initialDelayMs: 1000 },
            'processMessage',
          );
        if (operationalExecution) this.providerHealth.recordSuccess(this.modelProvider.id, 'chat');
        modelLoop.emptyResponseRecovery.completeInvocation(recoveryInvocation);
      } catch (error) {
        let invocationError = error;
        let fallbackSucceeded = false;
        const fallbackAttempt = await attemptSiblingModelFallback(
          {
            provider: this.modelProvider.id,
            model: activeModel,
            executionMode: options?.executionMode ?? 'production',
            iteration,
            retriesExhausted: error instanceof RetriesExhaustedError,
            isRecoveryInvocation: recoveryInvocation.isRecovery,
            hasExecutedCustomTool,
            hasProviderContinuation: modelLoop.pinnedProvider !== null,
            receivedDeltaCount: 0,
            error,
          },
          model => invokeProvider(true, model),
        );
        if (fallbackAttempt.status === 'succeeded') {
          const { decision: fallback } = fallbackAttempt;
          response = fallbackAttempt.response;
          activeModel = fallback.model;
          modelFallbackReason = fallback.reason;
          modelLoop.emptyResponseRecovery.completeInvocation(recoveryInvocation);
          if (operationalExecution) {
            this.providerHealth.recordSuccess(this.modelProvider.id, 'chat');
          }
          logger.warn(
            {
              event: 'addie_model_fallback',
              requestedModel,
              fallbackModel: fallback.model,
              reason: fallback.reason,
              disclosure: fallback.disclosure,
            },
            'Addie: Preferred model unavailable; sibling fallback succeeded',
          );
          fallbackSucceeded = true;
        } else if (fallbackAttempt.status === 'failed') {
          const { decision: fallback } = fallbackAttempt;
          invocationError = fallbackAttempt.error;
          logger.warn(
            {
              event: 'addie_model_fallback_failed',
              requestedModel,
              fallbackModel: fallback.model,
              reason: fallback.reason,
            },
            'Addie: Sibling model fallback failed',
          );
        }
        if (!fallbackSucceeded) {
          const fallbackResponse = modelLoop.emptyResponseRecovery
            .fallbackAfterInvocationFailure(recoveryInvocation);
          if (fallbackResponse) {
            // The empty end_turn was a valid terminal response. Recovery is
            // best-effort: if its one extra call fails, retain that terminal and
            // its already-accounted usage rather than turning fallback into an
            // exception. Do not log a provider error that may echo input text.
            logger.warn({ iteration }, 'Addie: Empty-response recovery failed');
            response = fallbackResponse;
            reusedEmptyResponse = true;
          } else {
            if (!lastModelRequest) {
              throw invocationError;
            }
            const stats = this.buildPayloadDebugStats(
              lastModelRequest,
              iteration,
              options?.requestContext?.trim() ? options.requestContext.length : 0,
            );
            if (isIsolatedExecution(options)) {
              // Provider errors may echo request text. Isolated executions log
              // only categorical metadata; the caller's ledger records the outcome.
              logger.error(
                { source: 'processMessage', payload: stats },
                'Addie: Isolated provider invocation failed',
              );
            } else {
              this.logPromptOverflow(invocationError, stats, 'processMessage');
            }
            if (operationalExecution) {
              const availability = this.providerHealth.recordFailure(
                this.modelProvider.id,
                'chat',
                invocationError,
              );
              if (!availability.allowed) {
                return providerUnavailableResponse(
                  availability,
                  this.modelProvider.id,
                  requestedModel,
                  toolsUsed,
                  toolExecutions,
                );
              }
            }
            throw invocationError;
          }
        }
      }

      const llmDuration = Date.now() - llmStart;
      totalLlmMs += llmDuration;

      logger.debug({
        stopReason: response.providerFinishReason,
        contentTypes: response.content.map(c => c.type),
        iteration,
        llmDurationMs: llmDuration,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      }, 'Addie: Model response received');

      const turn = activeTurn.acceptResponse(response, { countUsage: !reusedEmptyResponse });
      response = turn.response;
      if (turn.discardedRecoveryToolCalls) {
        logger.warn({ iteration }, 'Addie: Ignoring tool use from text-only recovery');
      }
      const acceptedTurnText = turn.textBlocks.map((block) => block.text).join('\n\n');

      let turnDecision: AddieAcceptedTurnDecision | undefined;
      for await (const event of orchestrateAcceptedAddieTurn({
        turn,
        provider: this.modelProvider,
        executionMode: options?.executionMode ?? 'production',
        messages: modelMessages,
        ledger: executionLedger,
        execute: executeToolCall,
        emptyResponseRecovery: {
          loop: modelLoop,
          deliverableText: stripBannedRituals(acceptedTurnText.trim()),
          eligibility: {
            allowInitial: operationalExecution,
            initialEligible: !hasExecutedCustomTool && toolExecutions.length === 0,
            postToolEligible: hasExecutedCustomTool,
          },
        },
      })) {
        if (event.type === 'provider_tool') {
          logger.debug(
            {
              toolName: event.recorded.execution.tool_name,
              resultCount: event.recorded.result.resultCount,
              parameterKeys: Object.keys(event.recorded.receipt.parameters).sort(),
            },
            'Addie: Provider tool completed',
          );
        } else if (event.type === 'turn_decision') {
          turnDecision = event.decision;
          hasExecutedCustomTool ||= event.decision.hasCustomToolCalls;
        } else if (event.type === 'start') {
          logger.debug(
            {
              toolName: event.call.name,
              ...(operationalExecution && { toolInput: event.call.input }),
            },
            'Addie: Calling tool',
          );
        }
      }
      if (!turnDecision) throw new Error('Accepted model turn produced no orchestration decision');

      if (turnDecision.disposition.type === 'continue') {
        if (
          turnDecision.disposition.reason === 'continue'
          || turnDecision.disposition.reason === 'continue_provider_tools'
        ) {
          // Anthropic pause_turn and compaction responses are resumable only
          // when their content is included in the next request. Repeating the
          // unchanged prompt can loop or repeat server-side work.
          logger.info(
            { stopReason: response.providerFinishReason, iteration },
            'Addie: Continuing resumable provider turn',
          );
        }
        continue;
      }

      if (turnDecision.disposition.type === 'recover') {
        if (turnDecision.disposition.reason === 'initial') {
          logger.warn({ iteration }, 'Addie: Retrying wholly empty initial response');
        } else {
          logger.warn({ iteration, toolsUsed }, 'Addie: Retrying empty response after tool use');
        }
        continue;
      }

      if (turnDecision.disposition.reason === 'truncated') {
        const rawText = turnDecision.text.trim();
        totalToolExecutionMs = toolExecutions.reduce((sum, execution) => sum + execution.duration_ms, 0);
        const finalUsage = toAddieUsage(modelLoop.usage);
        const terminal = buildTerminalAddieResponse({
          kind: 'provider',
          disposition: 'truncated',
          userMessage,
          rawText,
          toolsUsed,
          toolExecutions,
          requestedProvider: this.modelProvider.id,
          requestedModel: effectiveModel,
          fallbackReason: modelFallbackReason,
          providerResponse: response,
          configVersionId,
          usage: finalUsage,
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: iteration,
          },
        });
        if (terminal.finalized.emptyReason) {
          reportEmptyResponseFallback(terminal.finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessage', effectiveModel, iteration);
        }
        logger.error(
          {
            event: 'addie_response_truncated',
            source: 'processMessage',
            stopReason: response.providerFinishReason,
            iteration,
            originalLength: rawText.length,
            deliveredLength: terminal.response.text.length,
            contentTypes: boundedModelContentTypes(response.content),
            outputTokens: response.usage.outputTokens,
          },
          'Addie: Model provider stopped before response completion',
        );
        if (operationalExecution && options?.costScope) {
          await recordAccumulatedCost();
        }
        return terminal.response;
      }

      // Done - no tool use, just text
      if (turnDecision.disposition.reason === 'complete') {
        // Collect ALL text blocks (web search responses have multiple text blocks)
        const rawText = turnDecision.text.trim();
        // Calculate total tool execution time from tool_executions
        totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
        const finalUsage = toAddieUsage(modelLoop.usage);
        const terminal = buildTerminalAddieResponse({
          kind: 'provider',
          disposition: 'complete',
          userMessage,
          rawText,
          toolsUsed,
          toolExecutions,
          requestedProvider: this.modelProvider.id,
          requestedModel: effectiveModel,
          fallbackReason: modelFallbackReason,
          providerResponse: response,
          configVersionId,
          usage: finalUsage,
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: iteration,
          },
        });

        // Detect possible hallucinated actions (text claims success without successful tool calls)
        if (terminal.hallucinationReason) {
          logger.warn({ toolsUsed, reason: terminal.hallucinationReason }, 'Addie: Possible hallucinated action detected');
        }

        if (terminal.finalized.emptyReason) {
          reportEmptyResponseFallback(terminal.finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessage', effectiveModel, iteration);
        }
        if (terminal.finalized.lengthExceeded) {
          logger.error(
            {
              event: 'addie_response_truncated',
              source: 'processMessage',
              stopReason: response.providerFinishReason,
              iteration,
              originalLength: rawText.length,
              deliveredLength: terminal.response.text.length,
              localCapExceeded: true,
            },
            'Addie: Normally completed response exceeded output cap',
          );
        }
        // Record the call against the user's daily budget (#2790).
        // Runs after the response is built so a successful charge
        // counts even if a downstream flag/logging failure occurs.
        // recordCost no-ops for missing userId / system users.
        if (operationalExecution && options?.costScope) {
          await recordAccumulatedCost();
        }
        return terminal.response;
      }

      // Custom tool execution and continuation state are owned by the shared
      // accepted-turn orchestration boundary above.
    }

    logger.warn('Addie: Hit max tool iterations');
    totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
    const maxIterationsUsage = toAddieUsage(modelLoop.usage);
    const terminal = buildTerminalAddieResponse({
      kind: 'max_iterations',
      userMessage,
      rawText: '',
      toolsUsed,
      toolExecutions,
      requestedProvider: this.modelProvider.id,
      requestedModel: effectiveModel,
      fallbackReason: modelFallbackReason,
      lastProviderModel: null,
      configVersionId,
      usage: maxIterationsUsage,
      timing: {
        system_prompt_ms: systemPromptMs,
        total_llm_ms: totalLlmMs,
        total_tool_execution_ms: totalToolExecutionMs,
        iterations: modelLoop.limit,
      },
    });
    // Still charge the user for tokens actually consumed on the way to
    // hitting max-iterations. Production delivery is Anthropic-only here.
    if (operationalExecution && options?.costScope) {
      await recordAccumulatedCost();
    }
    return terminal.response;
  }

  /**
   * Process a message as a stream of delivery events.
   *
   * Provider attempts are buffered here and may be retried only before that
   * attempt exposes model content/tool events or executes a requested tool
   * (a retry-status event may still describe the discarded attempt).
   * Once a prior iteration has emitted text or a tool receipt, a later terminal
   * provider failure becomes `stream_error`; this method never restarts the
   * logical turn. Delivery adapters persist that boundary and own any explicit
   * user-triggered continuation. These phases cannot use the one-shot
   * `withRetry` helper because it has no event/tool visibility.
   *
   * Tool use pauses delivery while the tool executes, then resumes with its
   * result. The final `done` event includes the complete response.
   *
   * @param userMessage - The user's message
   * @param threadContext - Optional thread history
   * @param requestTools - Optional per-request tools (e.g., user-scoped member tools)
   * @param options - Optional processing options (e.g., maxIterations for admin users)
   */
  async *processMessageStream(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    options?: ProcessMessageOptions
  ): AsyncGenerator<StreamEvent> {
    const operationalExecution = !isIsolatedExecution(options);
    const requestedModel = options?.modelOverride ?? this.model;
    if (operationalExecution && this.modelProvider.id !== 'anthropic') {
      throw new Error('Alternate Addie model providers are restricted to isolated execution');
    }

    // #2950: matching fail-closed warn on the stream path.
    if (operationalExecution && !options?.costScope && !options?.uncapped) {
      logger.warn(
        { event: 'cost_cap_unwired', method: 'processMessageStream' },
        'claude-client stream called without costScope or uncapped:true — cost cap silently bypassed',
      );
    }

    // #2790: provider-neutral cost admission (streaming path). Same
    // contract as `processMessage` — yield a `done` event with the
    // friendly cap-exceeded text and return early instead of firing
    // another billable Claude call.
    let certificationReserveUsed = false;
    let certificationLeaseId: string | undefined;
    let certificationLeaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    if (operationalExecution) {
      const capResult = await checkCostCap(
        options?.costScope?.userId,
        options?.costScope?.tier ?? 'anonymous',
        {
          certificationReserveUsd: options?.costScope?.certificationReserveUsd,
          selection: { provider: this.modelProvider.id, model: requestedModel },
        },
      );
      certificationReserveUsed = capResult.usedCertificationReserve === true;
      certificationLeaseId = capResult.certificationLeaseId;
      if (!capResult.ok) {
        const message = formatCapExceededMessage(capResult)
          + (options?.costScope?.certificationReserveUsd ? ' Your certification progress is saved.' : '');
        logger.warn(
          {
            userId: options?.costScope?.userId,
            tier: options?.costScope?.tier,
            spentCents: capResult.spentCents,
            retryAfterMs: capResult.retryAfterMs,
          },
          'Addie cost admission refused — refusing model stream',
        );
        yield {
          type: 'done',
          response: {
            text: message,
            tools_used: [],
            tool_executions: [],
            flagged: true,
            flag_reason: 'cost_cap_exceeded',
            model_execution: localModelExecution(
              'cost_cap_exceeded',
              this.modelProvider.id,
              requestedModel,
            ),
          },
        };
        return;
      }
    }

    // As above, cost-capped requests must not consume the one half-open probe.
    if (operationalExecution) {
      const availability = this.providerHealth.acquire(this.modelProvider.id, 'chat');
      if (!availability.allowed) {
        await releaseCertificationReserve(options?.costScope?.userId, certificationLeaseId);
        certificationLeaseId = undefined;
        yield {
          type: 'done',
          response: providerUnavailableResponse(
            availability,
            this.modelProvider.id,
            requestedModel,
          ),
        };
        return;
      }
    }
    if (certificationLeaseId) {
      certificationLeaseHeartbeat = setInterval(() => {
        void renewCertificationReserve(options?.costScope?.userId, certificationLeaseId);
      }, 30_000);
    }

    const executionLedger = new AddieToolExecutionLedger();
    const toolsUsed = executionLedger.toolsUsed;
    const toolExecutions = executionLedger.executions;
    let logicalText = '';
    let totalReceivedDeltas = 0;
    let streamErrorEmitted = false;

    try {

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    // Get config version ID for this interaction (for tracking/analysis)
    const configVersionId = operationalExecution
      ? await getCurrentConfigVersionId()
      : undefined;

    const prepared = this.prepareFirstInvocation(
      userMessage,
      threadContext,
      requestTools,
      undefined,
      options,
      'streaming',
    );
    const {
      effectiveModel,
      systemBlocks,
      allHandlers,
      toolsByName,
      toolCount,
      messageTurnsResult,
      modelMessages,
      modelTools,
    } = prepared;
    systemPromptMs = prepared.systemPromptMs;

    if (options?.modelOverride && options.modelOverride !== this.model) {
      logger.info({ model: effectiveModel, defaultModel: this.model }, 'Addie Stream: Using precision model for billing/financial query');
    }

    const executeToolCall = createAddieToolExecutor([...toolsByName.values()], allHandlers, {
      executionMode: options?.executionMode ?? 'production',
      policy: options?.toolExecutionPolicy,
      notificationContext: {
        slackUserId: options?.slackUserId,
        userDisplayName: options?.userDisplayName,
        threadId: options?.threadId,
      },
    });

    if (messageTurnsResult.wasTrimmed) {
      logger.info(
        {
          messagesRemoved: messageTurnsResult.messagesRemoved,
          estimatedTokens: formatTokenCount(messageTurnsResult.estimatedTokens),
          tokenLimit: formatTokenCount(getConversationTokenLimit(effectiveModel, toolCount)),
          toolCount,
        },
        'Addie Stream: Trimmed conversation history to fit context limit'
      );
    }
    const modelLoop = new ModelTurnLoopState(options?.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    const recordAccumulatedCost = async () => {
      if (!operationalExecution || !options?.costScope) return;
      for (const event of modelLoop.accountedUsage) {
        await recordCost(options.costScope.userId, event);
      }
    };
    let iteration = 0;
    let lastProviderModel: string | undefined;
    let activeModel = effectiveModel;
    let modelFallbackReason: ModelFallbackReason | null = null;

      while (modelLoop.hasRemaining) {
        const activeTurn = modelLoop.beginNext();
        iteration = activeTurn.iteration;

        const llmStart = Date.now();

        // Collect full response for tool handling
        let currentResponse: ModelResponse | null = null;
        let reusedEmptyResponse = false;

        // Provider-attempt retry (the pre-first-content/tool-event phase).
        // Logical response buffering means no model output from this attempt is
        // exposed and none of its requested tools executes until the response
        // is complete.
        // A failed sample is therefore safe to discard even after provider
        // deltas arrive. This loop never restarts the surrounding logical turn.
        const maxStreamRetries = isExactlyOnceExecution(options) ? 0 : 3;
        let streamRetryCount = 0;
        let streamSucceeded = false;
        let receivedDeltaCount = 0;

        while (!streamSucceeded && streamRetryCount <= maxStreamRetries) {
          const recoveryInvocation = modelLoop.emptyResponseRecovery.prepareInvocation();
          const invocationTools = recoveryInvocation.toolsAllowed ? modelTools : [];
          const modelRequest = this.buildModelRequest(
            activeModel,
            systemBlocks,
            invocationTools,
            modelMessages,
            false,
            recoveryInvocation.isRecovery ? DEFAULT_MAX_OUTPUT_TOKENS : undefined,
            true,
            iteration === 1 && invocationTools.length > 0
              ? options?.initialToolChoice
              : undefined,
          );
          try {
            const provider = isExactlyOnceExecution(options) || recoveryInvocation.requiresExactlyOnce
              ? this.exactlyOnceModelProvider
              : this.modelProvider;
            currentResponse = await activeTurn.invoke(
              provider,
              modelRequest,
              {
                stream: true,
                onStreamProgress: () => {
                  totalReceivedDeltas++;
                  receivedDeltaCount++;
                },
                beforeDispatch: async (preparedInvocation) => {
                  await this.notifyInvocationPrepared(
                    options,
                    modelRequest,
                    preparedInvocation,
                    iteration,
                    streamRetryCount + 1,
                  );
                },
              },
            );

            if (operationalExecution) this.providerHealth.recordSuccess(this.modelProvider.id, 'chat');
            streamSucceeded = true;
            lastProviderModel = currentResponse.model;
            modelLoop.emptyResponseRecovery.completeInvocation(recoveryInvocation);
          } catch (streamError) {
            const fallbackResponse = modelLoop.emptyResponseRecovery
              .fallbackAfterInvocationFailure(recoveryInvocation);
            if (fallbackResponse) {
              // See the non-streaming path: recovery is an optional UX
              // improvement, not a reason to discard the valid first terminal.
              logger.warn({ iteration }, 'Addie Stream: Empty-response recovery failed');
              currentResponse = fallbackResponse;
              reusedEmptyResponse = true;
              receivedDeltaCount = 0;
              break;
            }
            streamRetryCount++;
            const stats = this.buildPayloadDebugStats(
              modelRequest,
              iteration,
              options?.requestContext?.trim() ? options.requestContext.length : 0,
            );
            if (isIsolatedExecution(options)) {
              // Provider errors may echo request text. Isolated executions log
              // only categorical metadata; the caller's ledger records the outcome.
              logger.error(
                { source: 'processMessageStream', payload: stats },
                'Addie Stream: Isolated provider invocation failed',
              );
            } else {
              this.logPromptOverflow(streamError, stats, 'processMessageStream');
            }

            const retryable = isRetryableError(streamError);
            const retryAfterSeconds = getProviderRetryAfterSeconds(streamError);
            const retryAfterWithinRequestBudget = retryAfterSeconds === undefined
              || retryAfterSeconds <= 30;
            const canRetry = retryable &&
                             streamRetryCount <= maxStreamRetries &&
                             retryAfterWithinRequestBudget;

            if (!canRetry) {
              const isExhausted = retryable && (
                streamRetryCount > maxStreamRetries || !retryAfterWithinRequestBudget
              );
              let terminalError = streamError;
              const fallbackAttempt = await attemptSiblingModelFallback(
                {
                  provider: this.modelProvider.id,
                  model: activeModel,
                  executionMode: options?.executionMode ?? 'production',
                  iteration,
                  retriesExhausted: isExhausted,
                  isRecoveryInvocation: recoveryInvocation.isRecovery,
                  hasExecutedCustomTool: toolExecutions.length > 0,
                  hasProviderContinuation: modelLoop.pinnedProvider !== null,
                  receivedDeltaCount: totalReceivedDeltas,
                  error: streamError,
                },
                async (model) => {
                  const fallbackTools = recoveryInvocation.toolsAllowed ? modelTools : [];
                  const fallbackRequest = this.buildModelRequest(
                    model,
                    systemBlocks,
                    fallbackTools,
                    modelMessages,
                    false,
                    undefined,
                    true,
                    iteration === 1 && fallbackTools.length > 0
                      ? options?.initialToolChoice
                      : undefined,
                  );
                  return activeTurn.invoke(
                    this.exactlyOnceModelProvider,
                    fallbackRequest,
                    {
                      stream: true,
                      onStreamProgress: () => {
                        totalReceivedDeltas++;
                        receivedDeltaCount++;
                      },
                      beforeDispatch: async (preparedInvocation) => {
                        await this.notifyInvocationPrepared(
                          options,
                          fallbackRequest,
                          preparedInvocation,
                          iteration,
                          streamRetryCount + 1,
                        );
                      },
                    },
                  );
                },
              );
              if (fallbackAttempt.status === 'succeeded') {
                const { decision: fallback } = fallbackAttempt;
                currentResponse = fallbackAttempt.response;
                activeModel = fallback.model;
                modelFallbackReason = fallback.reason;
                lastProviderModel = currentResponse.model;
                modelLoop.emptyResponseRecovery.completeInvocation(recoveryInvocation);
                if (operationalExecution) {
                  this.providerHealth.recordSuccess(this.modelProvider.id, 'chat');
                }
                logger.warn(
                  {
                    event: 'addie_model_fallback',
                    requestedModel,
                    fallbackModel: fallback.model,
                    reason: fallback.reason,
                    disclosure: fallback.disclosure,
                  },
                  'Addie Stream: Preferred model unavailable; sibling fallback succeeded',
                );
                break;
              }
              if (fallbackAttempt.status === 'failed') {
                const { decision: fallback } = fallbackAttempt;
                terminalError = fallbackAttempt.error;
                logger.warn(
                  {
                    event: 'addie_model_fallback_failed',
                    requestedModel,
                    fallbackModel: fallback.model,
                    reason: fallback.reason,
                  },
                  'Addie Stream: Sibling model fallback failed',
                );
              }
              if (operationalExecution) {
                const availability = this.providerHealth.recordFailure(
                  this.modelProvider.id,
                  'chat',
                  terminalError,
                );
                if (!availability.allowed) {
                  const terminalResponse = providerUnavailableResponse(
                    availability,
                    this.modelProvider.id,
                    requestedModel,
                    toolsUsed,
                    toolExecutions,
                    certificationReserveUsed,
                  );
                  // A terminal provider response is separate from any partial
                  // prose already emitted. Surface it as a final chunk so every
                  // consumer retains the recovery and mutation-safety warning.
                  if (receivedDeltaCount > 0) {
                    yield { type: 'text', text: `\n\n${terminalResponse.text}` };
                  }
                  yield {
                    type: 'done',
                    response: terminalResponse,
                  };
                  return;
                }
              }
              if (isExhausted) {
                if (receivedDeltaCount > 0) {
                  const errorMsg = terminalError instanceof Error
                    ? terminalError.message
                    : String(terminalError);
                  const reason = errorMsg.includes('overloaded') ? 'API is busy' :
                                errorMsg.includes('rate') ? 'Rate limited' :
                                errorMsg.includes('timeout') ? 'Request timed out' :
                                'Connection broke mid-reply';
                  streamErrorEmitted = true;
                  yield {
                    type: 'stream_error',
                    reason,
                    deltasBeforeError: receivedDeltaCount,
                    tool_executions: [...toolExecutions],
                    certification_reserve_used: certificationReserveUsed,
                  };
                }
                throw new RetriesExhaustedError(terminalError, streamRetryCount);
              }
              // Non-retryable failures are surfaced by the outer error path.
              throw terminalError;
            }

            // Calculate delay with exponential backoff
            const delayMs = Math.min(1000 * Math.pow(2, streamRetryCount - 1), 30000);
            const jitter = delayMs * 0.25 * (Math.random() * 2 - 1);
            const retryAfterMs = retryAfterSeconds === undefined ? 0 : retryAfterSeconds * 1000;
            const totalDelay = Math.max(Math.round(delayMs + jitter), retryAfterMs);

            // Determine user-friendly reason
            const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
            const reason = errorMsg.includes('overloaded') ? 'API is busy' :
                          errorMsg.includes('rate') ? 'Rate limited' :
                          errorMsg.includes('timeout') ? 'Request timed out' :
                          'Temporary issue';

            logger.warn(
              {
                attempt: streamRetryCount,
                maxRetries: maxStreamRetries,
                delayMs: totalDelay,
                retryAfterSeconds,
                error: errorMsg,
              },
              'Addie Stream: Retryable error, waiting before retry'
            );

            // Emit retry event so UI can show status
            yield {
              type: 'retry',
              attempt: streamRetryCount,
              maxRetries: maxStreamRetries,
              delayMs: totalDelay,
              reason,
            };

            await new Promise(resolve => setTimeout(resolve, totalDelay));

            // Discard the failed, never-exposed sample before retrying.
            receivedDeltaCount = 0;
            currentResponse = null;
          }
        }

        const llmDuration = Date.now() - llmStart;
        totalLlmMs += llmDuration;

        if (!currentResponse) {
          throw new Error('Stream completed without response');
        }

        logger.debug({
          stopReason: currentResponse.providerFinishReason,
          iteration,
          llmDurationMs: llmDuration,
          inputTokens: currentResponse.usage.inputTokens,
          outputTokens: currentResponse.usage.outputTokens,
        }, 'Addie Stream: Model response received');

        const turn = activeTurn.acceptResponse(currentResponse, { countUsage: !reusedEmptyResponse });
        currentResponse = turn.response;
        if (turn.discardedRecoveryToolCalls) {
          logger.warn({ iteration }, 'Addie Stream: Ignoring tool use from text-only recovery');
        }
        const acceptedTurnText = turn.textBlocks.map((block) => block.text).join('\n\n');

        let turnDecision: AddieAcceptedTurnDecision | undefined;
        for await (const event of orchestrateAcceptedAddieTurn({
          turn,
          provider: this.modelProvider,
          executionMode: options?.executionMode ?? 'production',
          messages: modelMessages,
          ledger: executionLedger,
          execute: executeToolCall,
          emptyResponseRecovery: {
            loop: modelLoop,
            deliverableText: stripBannedRituals(acceptedTurnText),
            eligibility: {
              allowInitial: operationalExecution,
              initialEligible: toolExecutions.length === 0 && logicalText.length === 0,
              postToolEligible: toolExecutions.length > 0,
            },
          },
        })) {
          if (event.type === 'provider_tool') {
            yield {
              type: 'tool_start',
              tool_name: event.recorded.execution.tool_name,
              parameters: event.recorded.execution.parameters,
            };
            yield {
              type: 'tool_end',
              tool_name: event.recorded.execution.tool_name,
              result: event.recorded.execution.result,
              is_error: event.recorded.execution.is_error,
              normalized_result: event.recorded.execution.normalized_result,
              execution: event.recorded.execution,
            };
            logger.debug(
              {
                toolName: event.recorded.execution.tool_name,
                resultCount: event.recorded.result.resultCount,
                parameterKeys: Object.keys(event.recorded.receipt.parameters).sort(),
              },
              'Addie Stream: Provider tool completed',
            );
          } else if (event.type === 'turn_decision') {
            turnDecision = event.decision;
            if (
              event.decision.disposition.type === 'continue'
              && event.decision.disposition.reason === 'execute_tools'
            ) {
              // Preserve accepted text before a tool handler can fail.
              logicalText += event.decision.text;
            }
          } else if (event.type === 'start') {
            logger.debug(
              {
                toolName: event.call.name,
                ...(operationalExecution && { toolInput: event.call.input }),
              },
              'Addie Stream: Calling tool',
            );
            yield {
              type: 'tool_start',
              tool_name: event.call.name,
              parameters: this.recordedToolParameters(options, event.call.input),
            };
          } else {
            yield {
              type: 'tool_end',
              tool_name: event.call.name,
              result: event.executed.execution.result,
              is_error: event.executed.execution.is_error,
              normalized_result: event.executed.execution.normalized_result,
              execution: event.executed.execution,
            };
          }
        }
        if (!turnDecision) throw new Error('Accepted model turn produced no orchestration decision');

        // Build the final usage block + charge the user's cost
        // budget (#2790). Both stream terminal paths (end_turn and
        // no-tool-blocks) serialize the same normalized accumulator.
        const buildStreamUsage = () => toAddieUsage(modelLoop.usage);
        const chargeStreamCost = async () => {
          await recordAccumulatedCost();
        };

        const iterationText = turnDecision.text;
        if (turnDecision.disposition.type === 'continue') {
          if (
            turnDecision.disposition.reason === 'continue'
            || turnDecision.disposition.reason === 'continue_provider_tools'
          ) {
            // Resume from the provider response without exposing interim text.
            logger.info(
              { stopReason: currentResponse.providerFinishReason, iteration },
              'Addie Stream: Continuing resumable provider turn',
            );
          } else if (logicalText.length > 0 && !logicalText.endsWith('\n')) {
            // Add spacing between tool use and subsequent text to prevent run-on text.
            logicalText += '\n\n';
          }
          continue;
        }

        if (turnDecision.disposition.type === 'recover') {
          if (turnDecision.disposition.reason === 'initial') {
            logger.warn({ iteration }, 'Addie Stream: Retrying wholly empty initial response');
          } else {
            // Logical-turn buffering means no text from this iteration has
            // been emitted, so retrying ritual-only output cannot duplicate text.
            logger.warn({ iteration, toolsUsed }, 'Addie Stream: Retrying empty response after tool use');
          }
          continue;
        }

        if (turnDecision.disposition.reason === 'truncated') {
          logicalText += iterationText;
          totalToolExecutionMs = toolExecutions.reduce((sum, execution) => sum + execution.duration_ms, 0);
          const streamUsage = buildStreamUsage();
          const terminal = buildTerminalAddieResponse({
            kind: 'provider',
            disposition: 'truncated',
            userMessage,
            rawText: logicalText,
            toolsUsed,
            toolExecutions,
            requestedProvider: this.modelProvider.id,
            requestedModel: effectiveModel,
            fallbackReason: modelFallbackReason,
            providerResponse: currentResponse,
            configVersionId,
            usage: streamUsage,
            timing: {
              system_prompt_ms: systemPromptMs,
              total_llm_ms: totalLlmMs,
              total_tool_execution_ms: totalToolExecutionMs,
              iterations: iteration,
            },
            certificationReserveUsed,
          });
          if (terminal.finalized.emptyReason) {
            reportEmptyResponseFallback(terminal.finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessageStream', effectiveModel, iteration);
          }
          logger.error(
            {
              event: 'addie_response_truncated',
              source: 'processMessageStream',
              stopReason: currentResponse.providerFinishReason,
              iteration,
              originalLength: logicalText.length,
              deliveredLength: terminal.response.text.length,
              localCapExceeded: terminal.finalized.lengthExceeded,
              contentTypes: boundedModelContentTypes(currentResponse.content),
              outputTokens: currentResponse.usage.outputTokens,
            },
            'Addie Stream: Response stopped before completion',
          );
          await chargeStreamCost();
          yield { type: 'text', text: terminal.response.text };
          yield {
            type: 'done',
            response: terminal.response,
          };
          return;
        }

        // Done - no tool use
        if (turnDecision.disposition.reason === 'complete') {
          logicalText += iterationText;
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
          const streamUsage = buildStreamUsage();
          const terminal = buildTerminalAddieResponse({
            kind: 'provider',
            disposition: 'complete',
            userMessage,
            rawText: logicalText,
            toolsUsed,
            toolExecutions,
            requestedProvider: this.modelProvider.id,
            requestedModel: effectiveModel,
            fallbackReason: modelFallbackReason,
            providerResponse: currentResponse,
            configVersionId,
            usage: streamUsage,
            timing: {
              system_prompt_ms: systemPromptMs,
              total_llm_ms: totalLlmMs,
              total_tool_execution_ms: totalToolExecutionMs,
              iterations: iteration,
            },
            certificationReserveUsed,
          });
          if (terminal.finalized.emptyReason) {
            reportEmptyResponseFallback(terminal.finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessageStream', effectiveModel, iteration);
          }

          if (terminal.hallucinationReason) {
            logger.warn({ toolsUsed, reason: terminal.hallucinationReason }, 'Addie Stream: Possible hallucinated action detected');
          }
          if (terminal.finalized.lengthExceeded) {
            logger.error(
              {
                event: 'addie_response_truncated',
                source: 'processMessageStream',
                stopReason: currentResponse.providerFinishReason,
                iteration,
                originalLength: logicalText.length,
                deliveredLength: terminal.response.text.length,
                localCapExceeded: true,
              },
              'Addie Stream: Normally completed response exceeded output cap',
            );
          }
          await chargeStreamCost();
          yield { type: 'text', text: terminal.response.text };
          yield {
            type: 'done',
            response: terminal.response,
          };
          return;
        }

      }

      // Max iterations reached
      logger.warn('Addie Stream: Hit max tool iterations');
      totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
      const maxIterUsage = toAddieUsage(modelLoop.usage);
      const terminal = buildTerminalAddieResponse({
        kind: 'max_iterations',
        userMessage,
        rawText: logicalText,
        toolsUsed,
        toolExecutions,
        requestedProvider: this.modelProvider.id,
        requestedModel: effectiveModel,
        fallbackReason: modelFallbackReason,
        lastProviderModel,
        configVersionId,
        usage: maxIterUsage,
        timing: {
          system_prompt_ms: systemPromptMs,
          total_llm_ms: totalLlmMs,
          total_tool_execution_ms: totalToolExecutionMs,
          iterations: modelLoop.limit,
        },
        certificationReserveUsed,
      });
      // Charge the tokens consumed up to the max-iteration wall —
      // the API calls happened regardless of whether we converged.
      if (operationalExecution && options?.costScope) {
        await recordAccumulatedCost();
      }
      if (terminal.finalized.lengthExceeded) {
        logger.error(
          { event: 'addie_response_truncated', source: 'processMessageStream', originalLength: logicalText.length, deliveredLength: terminal.response.text.length, localCapExceeded: true },
          'Addie Stream: Max-iteration response exceeded output cap',
        );
      }
      yield { type: 'text', text: terminal.response.text };
      yield {
        type: 'done',
        response: terminal.response,
      };
    } catch (error) {
      if (isIsolatedExecution(options)) {
        logger.error(
          { source: 'processMessageStream' },
          'Addie Stream: Isolated execution terminated',
        );
      } else {
        logger.error({ error }, 'Addie Stream: Error during streaming');
      }
      if (!streamErrorEmitted) {
        yield {
          type: 'stream_error',
          reason: error instanceof Error ? error.message : 'Unknown error',
          deltasBeforeError: totalReceivedDeltas,
          tool_executions: [...toolExecutions],
          certification_reserve_used: certificationReserveUsed,
        };
      }
    } finally {
      if (certificationLeaseHeartbeat) clearInterval(certificationLeaseHeartbeat);
      if (operationalExecution) {
        await releaseCertificationReserve(options?.costScope?.userId, certificationLeaseId);
      }
    }
  }

  /**
   * Get list of registered tools
   */
  getRegisteredTools(): string[] {
    return this.tools.map((t) => t.name);
  }
}
