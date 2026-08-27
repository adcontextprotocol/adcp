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
import { ADDIE_FALLBACK_PROMPT, ADDIE_TOOL_REFERENCE, buildMessageTurnsWithMetadata } from './prompts.js';
import { AddieDatabase } from '../db/addie-db.js';
import { AddieModelConfig } from '../config/models.js';
import { getCurrentConfigVersionId } from './config-version.js';
import { loadRules, loadResponseStyle, invalidateRulesCache } from './rules/index.js';
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
  ModelMessage,
  ModelMessageContent,
  ModelRequest,
  ModelResponse,
  ModelToolCallContent,
  ModelToolDefinition,
  ModelToolResultContent,
  ModelUsage,
} from './model-providers/model-provider.js';
import {
  AnthropicModelProvider,
  type AnthropicMessagesTransport,
} from './model-providers/anthropic-provider.js';
import {
  appendModelTurnContinuation,
  ModelTurnLoopState,
} from './model-providers/model-turn.js';
import {
  createAddieToolExecutor,
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
  buildAddieWireTools,
  mergeAddieToolDefinitions,
} from './tool-wire-shape.js';
import { assembleAddieFallbackPrompt, assembleAddieSystemPrompt } from './prompt-assembly.js';
import {
  MAX_OUTPUT_LENGTH,
  formatTruncatedOutput,
} from './security.js';
import {
  isToolResultError,
  normalizeToolResult,
  renderToolExecutionsFallback,
  type NormalizedToolResult,
  type ToolResultPresentation,
} from './tool-result-contract.js';

export interface InvocationPreparedSnapshot {
  execution_mode: AddieExecutionMode;
  model: string;
  iteration: number;
  attempt: number;
  system_blocks: Array<{ index: number; sha256: string }>;
  tool_schemas: Array<{ index: number; name: string; sha256: string }>;
  message_payloads: Array<{ index: number; sha256: string }>;
  message_count: number;
  /** HMAC/SHA-256 of the exact object handed to the Anthropic SDK. */
  provider_request_sha256: string;
}

interface PreparedProviderRequest {
  model: string;
  max_tokens: number;
  output_config?: Anthropic.Beta.BetaOutputConfig;
  system: Anthropic.TextBlockParam[];
  tools: Array<Record<string, unknown>>;
  messages: Anthropic.MessageParam[];
  betas?: readonly string[];
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
): Pick<PreparedProviderRequest, 'max_tokens' | 'output_config'> {
  if (/^claude-sonnet-5(?:-|$)/.test(model)) {
    return {
      max_tokens: Math.min(SONNET_5_MAX_OUTPUT_TOKENS, maxOutputTokens ?? SONNET_5_MAX_OUTPUT_TOKENS),
      output_config: { effort: 'medium' },
    };
  }
  return { max_tokens: Math.min(DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) };
}

function isEvaluationExecution(options?: ProcessMessageOptions): boolean {
  return options?.executionMode === 'evaluation' || options?.executionMode === 'replay';
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
  if (hasKey || hasDomain || executionMode === 'evaluation' || executionMode === 'replay') {
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

/**
 * A successful first turn is safe to resample only when it has no visible
 * answer and every provider block is side-effect-free. Sonnet 5 may return
 * private thinking or allowlisted ritual-only text before an otherwise empty
 * `end_turn`; those bytes must neither block recovery nor reach logs. Persona
 * disclosures may contain semantic refusals, so they are not retryable.
 * Unknown, tool, server-tool, and result blocks remain fail-closed.
 */
function isSideEffectFreeEmptyModelResponse(
  response: ModelResponse,
  visibleText: string,
): boolean {
  const deliverableText = stripBannedRituals(visibleText);
  if (response.providerFinishReason !== 'end_turn' || deliverableText.trim().length > 0) {
    return false;
  }
  return response.content.every((content) => (
    content.type === 'text'
    || (content.type === 'provider_state'
      && (content.kind === 'thinking' || content.kind === 'redacted_thinking'))
  ));
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

/**
 * Convert MessageTurn[] into Anthropic.MessageParam[] with proper tool_use/tool_result
 * content blocks. When an assistant message has toolCalls, we:
 * 1. Build the assistant content as [text, tool_use, tool_use, ...]
 * 2. Insert a synthetic user message with [tool_result, tool_result, ...]
 *
 * This prevents the model from hallucinating tool calls as text (which happens when
 * tool results are flattened into plain text in conversation history).
 */
function toAnthropicMessages(turns: MessageTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let toolIdCounter = 0;

  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
      // Build assistant content blocks: text + tool_use blocks
      const content: Anthropic.ContentBlockParam[] = [];
      if (turn.content.trim()) {
        content.push({ type: 'text', text: turn.content });
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tc of turn.toolCalls) {
        const toolUseId = `hist_${toolIdCounter++}`;
        content.push({
          type: 'tool_use',
          id: toolUseId,
          name: tc.name,
          input: (tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)) ? tc.input : {},
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: tc.result,
          is_error: tc.is_error ?? false,
        });
      }

      // Defensive: skip if no content blocks were produced
      if (content.length === 0) {
        messages.push({ role: turn.role, content: turn.content });
      } else {
        messages.push({ role: 'assistant', content });
        // Insert tool_result in a user turn (required by Anthropic API)
        messages.push({ role: 'user', content: toolResults });
      }
    } else {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  // Anthropic API requires alternating roles — merge consecutive same-role messages
  // The first merge (in buildMessageTurnsWithMetadata) handles raw MessageTurns for
  // token estimation. This second merge handles synthetic user messages (tool_result
  // blocks) that toAnthropicMessages inserts, which may collide with real user messages.
  const merged: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      // Normalize both to arrays and concatenate
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content }];
      const newContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text' as const, text: msg.content }];
      prev.content = [...prevContent, ...newContent];
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

function buildInputAttachmentBlocks(
  attachments?: AddieInputAttachment[]
): Anthropic.ContentBlockParam[] {
  if (!attachments || attachments.length === 0) return [];

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      if (!isAllowedImageType(attachment.media_type)) {
        logger.warn({ mediaType: attachment.media_type }, 'Addie: Invalid image media type in user attachment');
        continue;
      }
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.media_type,
          data: attachment.data,
        },
      });
      blocks.push({
        type: 'text',
        text: `[Uploaded image: ${attachment.filename || 'image'}]`,
      });
    } else if (attachment.type === 'document') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: attachment.data,
        },
      });
      blocks.push({
        type: 'text',
        text: `[Uploaded PDF: ${attachment.filename || 'document'}]`,
      });
    }
  }
  return blocks;
}

function appendInputAttachments(
  messages: Anthropic.MessageParam[],
  attachments?: AddieInputAttachment[]
): Anthropic.MessageParam[] {
  const attachmentBlocks = buildInputAttachmentBlocks(attachments);
  if (attachmentBlocks.length === 0) return messages;

  const nextMessages = messages.map((message) => ({ ...message }));
  let currentTurn = nextMessages[nextMessages.length - 1];
  if (!currentTurn || currentTurn.role !== 'user') {
    currentTurn = { role: 'user', content: [] };
    nextMessages.push(currentTurn);
  }

  const currentContent = Array.isArray(currentTurn.content)
    ? currentTurn.content
    : currentTurn.content.trim()
      ? [{ type: 'text' as const, text: currentTurn.content }]
      : [];
  currentTurn.content = [...currentContent, ...attachmentBlocks];
  return nextMessages;
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

function buildModelToolDefinitions(tools: readonly AddieTool[]): ModelToolDefinition[] {
  const definitions: ModelToolDefinition[] = tools.map((tool): ModelToolDefinition => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as ModelToolDefinition['inputSchema'],
  }));
  if (definitions.length > 0) {
    definitions[definitions.length - 1] = {
      ...definitions[definitions.length - 1],
      cacheHint: 'ephemeral',
    };
  }
  return definitions;
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
export function detectHallucinatedAction(text: string, toolExecutions: ToolExecution[]): string | null {
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
export function detectEmptyTurn(text: string, toolExecutions: ToolExecution[]): string | null {
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
export function detectEmptyResponse(text: string, toolExecutions: ToolExecution[]): string | null {
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
  toolExecutions: ToolExecution[],
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
  lengthExceeded: boolean;
}

/** Apply the safety/style pipeline exactly once before any terminal delivery. */
function finalizeAssistantText(
  question: string,
  rawText: string,
  toolExecutions: ToolExecution[],
  forceTruncation: boolean = false,
): FinalizedAssistantText {
  const processed = applyResponsePipelineWithEmptyMonitoring(question, rawText, toolExecutions);
  const lengthExceeded = processed.text.length > MAX_OUTPUT_LENGTH;
  const truncated = forceTruncation || lengthExceeded;
  return {
    text: truncated ? formatTruncatedOutput(processed.text) : processed.text,
    emptyReason: processed.reason,
    lengthExceeded,
  };
}

function reportEmptyResponseFallback(
  reason: string,
  toolsUsed: string[],
  toolExecutions: ToolExecution[],
  options: ProcessMessageOptions | undefined,
  source: 'processMessage' | 'processMessageStream',
  model: string,
  iteration: number,
): void {
  if (isEvaluationExecution(options)) return;

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
  /** Request-local execution mode. Evaluation/replay suppress operational side effects. */
  executionMode?: AddieExecutionMode;
  /** Exclude provider-managed tools such as web search for this request only. */
  disableServerTools?: boolean;
  /**
   * Exact request-local custom-tool allowlist. When present, global and
   * request-scoped tools outside this list are omitted before prompt sizing,
   * schema construction, and handler dispatch.
   */
  allowedToolNames?: readonly string[];
  /** Dedicated key for HMACing private invocation payloads in evaluation provenance. */
  invocationHashKey?: string;
  /** Caller-owned HMAC domain separator. Must be supplied with invocationHashKey. */
  invocationHashDomain?: string;
  /** Fail-closed hook evaluated immediately before each custom handler dispatch. */
  toolExecutionPolicy?: ToolExecutionPolicy;
  /**
   * Called immediately before an Anthropic invocation with hashes of the exact,
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
  /** Token usage from Claude API */
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

function anthropicModelExecution(model: string, requestedModel: string): ModelExecution {
  return {
    source: 'provider',
    requested_provider: 'anthropic',
    requested_model: requestedModel,
    provider: 'anthropic',
    model,
    model_resolution: model === requestedModel ? 'exact' : 'provider_canonicalized',
    fallback_reason: null,
  };
}

function localModelExecution(
  reason: Extract<ModelExecution, { source: 'local' }>['reason'],
  requestedModel: string,
): ModelExecution {
  return {
    source: 'local',
    requested_provider: 'anthropic',
    requested_model: requestedModel,
    reason,
  };
}

function providerUnavailableResponse(
  availability: ProviderAvailability,
  requestedModel: string,
  toolsUsed: string[] = [],
  toolExecutions: ToolExecution[] = [],
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
    model_execution: localModelExecution('provider_error', requestedModel),
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

export class AddieClaudeClient {
  private client: Anthropic;
  private readonly anthropicProvider: AnthropicModelProvider;
  private readonly exactlyOnceAnthropicProvider: AnthropicModelProvider;
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
  ) {
    this.client = new Anthropic({ apiKey });
    const transport = this.client as unknown as AnthropicMessagesTransport;
    this.anthropicProvider = new AnthropicModelProvider(
      apiKey,
      transport,
      { transportMaxRetries: 2 },
    );
    this.exactlyOnceAnthropicProvider = new AnthropicModelProvider(
      apiKey,
      transport,
      { transportMaxRetries: 0 },
    );
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
   * Get the system prompt from markdown rule files, with tool reference and
   * response-style.md appended in that order so the shape rules are the
   * last thing the model reads before generating.
   *
   * Validated by the prompt-variant eval (server/tests/manual/prompt-variant-eval.ts):
   * on Sonnet 4.6, this ordering cuts mean response length 13% and shape
   * violations 2/12 vs the prior order on a fixed question battery, with
   * zero default-template or banned-ritual regressions.
   *
   * Rules are loaded from ./rules/*.md files (cached in memory after first
   * read). Tool reference (ADDIE_TOOL_REFERENCE) is always appended (tied
   * to code). Fallback prompt used only when rule files can't be read.
   */
  private getSystemPrompt(): { prompt: string } {
    try {
      const basePrompt = loadRules();
      const responseStyle = loadResponseStyle();
      const prompt = assembleAddieSystemPrompt(basePrompt, ADDIE_TOOL_REFERENCE, responseStyle);
      return { prompt };
    } catch (error) {
      logger.warn({ error }, 'Addie: Failed to load rules from files, using fallback prompt');
      const fallbackPrompt = assembleAddieFallbackPrompt(ADDIE_FALLBACK_PROMPT, ADDIE_TOOL_REFERENCE);
      return { prompt: fallbackPrompt };
    }
  }

  private estimateMessageContentChars(content: Anthropic.MessageParam['content']): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;

    let total = 0;
    for (const block of content) {
      if ('text' in block && typeof block.text === 'string') {
        total += block.text.length;
      }
      if ('name' in block && typeof block.name === 'string') {
        total += block.name.length;
      }
      if ('input' in block && block.input !== undefined) {
        total += JSON.stringify(block.input).length;
      }
      if ('content' in block && typeof block.content === 'string') {
        total += block.content.length;
      } else if ('content' in block && Array.isArray(block.content)) {
        total += JSON.stringify(block.content).length;
      }
      // Base64 image data
      if ('source' in block) {
        const source = (block as unknown as { source: { data?: string } }).source;
        if (typeof source?.data === 'string') {
          total += source.data.length;
        }
      }
    }
    return total;
  }

  private buildPayloadDebugStats(
    effectiveModel: string,
    systemBlocks: Anthropic.TextBlockParam[],
    customTools: Anthropic.Tool[],
    messages: Anthropic.MessageParam[],
    iteration: number = 0,
    extraToolCount: number = 0,
  ): PayloadDebugStats {
    const systemChars = systemBlocks.reduce((sum, block) => sum + block.text.length, 0);
    const requestContextChars = systemBlocks.slice(1).reduce((sum, block) => sum + block.text.length, 0);

    let largestMessage: PayloadDebugStats['largest_message'];
    let messageChars = 0;
    for (let i = 0; i < messages.length; i++) {
      const chars = this.estimateMessageContentChars(messages[i].content);
      messageChars += chars;
      if (!largestMessage || chars > largestMessage.chars) {
        largestMessage = { index: i, role: messages[i].role, chars };
      }
    }

    return {
      model: effectiveModel,
      iteration,
      system_block_count: systemBlocks.length,
      system_chars: systemChars,
      request_context_chars: requestContextChars,
      tool_count: customTools.length + extraToolCount,
      tool_chars: JSON.stringify(customTools).length,
      message_count: messages.length,
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
    providerRequest: PreparedProviderRequest,
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
    return {
      execution_mode: executionMode,
      model: providerRequest.model,
      iteration,
      attempt,
      system_blocks: providerRequest.system.map((block, index) => ({
        index,
        sha256: hash(block),
      })),
      tool_schemas: providerRequest.tools.map((tool, index) => ({
        index,
        name: typeof tool.name === 'string' ? tool.name : `tool_${index}`,
        sha256: hash(tool),
      })),
      message_payloads: providerRequest.messages.map((message, index) => ({
        index,
        sha256: hash(message),
      })),
      message_count: providerRequest.messages.length,
      provider_request_sha256: hash(providerRequest),
    };
  }

  private async notifyInvocationPrepared(
    options: ProcessMessageOptions | undefined,
    providerRequest: PreparedProviderRequest,
    iteration: number,
    attempt: number,
  ): Promise<void> {
    if (!options?.onInvocationPrepared) return;
    await options.onInvocationPrepared(this.buildInvocationPreparedSnapshot(
      options,
      providerRequest,
      iteration,
      attempt,
    ));
  }

  private recordedToolParameters(
    options: ProcessMessageOptions | undefined,
    toolInput: Record<string, unknown>,
  ): Record<string, unknown> {
    return isEvaluationExecution(options) ? {} : toolInput;
  }

  private recordedToolResult(
    options: ProcessMessageOptions | undefined,
    result: string,
    kind: 'success' | 'error',
  ): string {
    if (!isEvaluationExecution(options)) return result;
    return kind === 'error' ? 'Error: Tool execution failed' : 'Tool execution completed';
  }

  private observeNormalizedToolResult(
    toolName: string,
    normalized: NormalizedToolResult,
  ): NormalizedToolResult {
    if (normalized.display_degradation) {
      logger.warn(
        {
          event: 'addie_tool_result_display_degraded',
          toolName,
          reason: normalized.display_degradation,
        },
        'Addie: Tool result display payload degraded; text result preserved',
      );
    }
    if (normalized.model_context_truncated || normalized.user_summary_truncated) {
      logger.warn(
        {
          event: 'addie_tool_result_content_bounded',
          toolName,
          modelContextTruncated: normalized.model_context_truncated,
          userSummaryTruncated: normalized.user_summary_truncated,
        },
        'Addie: Oversized tool result content bounded',
      );
    }
    return normalized;
  }

  private recordedToolPresentation(
    options: ProcessMessageOptions | undefined,
    normalized: NormalizedToolResult,
  ): ToolResultPresentation {
    if (!isEvaluationExecution(options)) return normalized.presentation;
    return {
      status: normalized.status,
      user_summary: isToolResultError(normalized.status)
        ? 'Tool execution failed'
        : 'Tool execution completed',
      source: normalized.presentation.source,
    };
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

  private prepareFirstNonStreamingInvocation(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    rulesOverride?: RulesOverride,
    options?: ProcessMessageOptions,
  ) {
    const requestWebSearchEnabled = this.webSearchEnabled
      && !isEvaluationExecution(options)
      && options?.disableServerTools !== true;
    const effectiveModel = options?.modelOverride ?? this.model;

    const promptStart = Date.now();
    const systemPrompt = rulesOverride
      ? rulesOverride.systemPrompt
      : this.getSystemPrompt().prompt;
    const systemPromptMs = Date.now() - promptStart;

    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    if (options?.requestContext?.trim()) {
      systemBlocks.push({ type: 'text', text: options.requestContext });
    }

    const allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : null;
    const allTools = mergeAddieToolDefinitions(
      this.tools,
      requestTools?.tools,
      options?.allowedToolNames,
    );
    const allHandlers = new Map(
      [...this.toolHandlers, ...(requestTools?.handlers || [])]
        .filter(([name]) => !allowedToolNames || allowedToolNames.has(name)),
    );
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
      systemBlocks.push({ type: 'text', text: contextWarning });
    }

    const messages: Anthropic.MessageParam[] = appendInputAttachments(
      toAnthropicMessages(messageTurnsResult.messages),
      options?.inputAttachments,
    );
    const modelMessages = appendModelInputAttachments(
      toModelMessages(messageTurnsResult.messages),
      options?.inputAttachments,
    );
    const customTools = buildAddieWireTools(allTools) as Anthropic.Tool[];
    const modelTools = buildModelToolDefinitions(allTools);

    return {
      effectiveModel,
      systemBlocks,
      allHandlers,
      toolsByName,
      toolCount,
      messageTurnsResult,
      messages,
      modelMessages,
      customTools,
      modelTools,
      requestWebSearchEnabled,
      systemPromptMs,
    };
  }

  private buildModelRequest(
    effectiveModel: string,
    systemBlocks: Anthropic.TextBlockParam[],
    tools: ModelToolDefinition[],
    messages: ModelMessage[],
    providerWebSearchEnabled: boolean,
    maxOutputTokens?: number,
    streaming = false,
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
        ...('cache_control' in block && block.cache_control?.type === 'ephemeral'
          ? { cacheHint: 'ephemeral' as const }
          : {}),
      })),
      messages,
      tools,
      ...(providerWebSearchEnabled && { providerTools: [{ type: 'web_search' as const }] }),
      ...(controls.output_config?.effort === 'medium' && {
        reasoning: { effort: 'medium' as const },
      }),
      maxOutputTokens: controls.max_tokens,
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
    const prepared = this.prepareFirstNonStreamingInvocation(
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
    );
    const providerRequest = this.anthropicProvider.prepare(modelRequest)
      .providerRequest as unknown as PreparedProviderRequest;
    return this.buildInvocationPreparedSnapshot(
      options,
      providerRequest,
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
    const operationalExecution = !isEvaluationExecution(options);
    const requestedModel = options?.modelOverride ?? this.model;

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

    // #2790: per-user Anthropic cost cap. Check at entry; when the
    // user has exhausted their daily budget, return a friendly
    // "try again later" response instead of firing another
    // (billable) Claude call. The caller's ProcessMessageOptions
    // carries both `userId` and `tier` so we don't have to resolve
    // the subscription tier here.
    if (operationalExecution && options?.costScope) {
      const capResult = await checkCostCap(
        options.costScope.userId,
        options.costScope.tier,
      );
      if (!capResult.ok) {
        const message = formatCapExceededMessage(capResult)
          + (options.costScope.certificationReserveUsd ? ' Your certification progress is saved.' : '');
        logger.warn(
          {
            userId: options.costScope.userId,
            tier: options.costScope.tier,
            spentCents: capResult.spentCents,
            retryAfterMs: capResult.retryAfterMs,
          },
          'Addie cost cap exceeded — refusing Claude call',
        );
        return {
          text: message,
          tools_used: [],
          tool_executions: [],
          flagged: true,
          flag_reason: 'cost_cap_exceeded',
          model_execution: {
            source: 'local',
            requested_provider: 'anthropic',
            requested_model: requestedModel,
            reason: 'cost_cap_exceeded',
          },
        };
      }
    }

    // Reserve a half-open probe only after local gates have passed so a
    // request that never reaches the provider cannot hold the probe lease.
    if (operationalExecution) {
      const availability = this.providerHealth.acquire('anthropic', 'chat');
      if (!availability.allowed) {
        return providerUnavailableResponse(availability, requestedModel);
      }
    }

    const toolsUsed: string[] = [];
    const toolExecutions: ToolExecution[] = [];
    let executionSequence = 0;

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    const prepared = this.prepareFirstNonStreamingInvocation(
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
      messages: anthropicMessages,
      modelMessages,
      customTools,
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

    while (modelLoop.hasRemaining) {
      const activeTurn = modelLoop.beginNext();
      iteration = activeTurn.iteration;

      // Use beta API to access web search
      const llmStart = Date.now();
      let response: ModelResponse;
      let reusedEmptyResponse = false;
      const invocationTools = modelLoop.emptyResponseRecovery.toolsAllowed ? modelTools : [];
      let invocationAttempt = 0;
      const isEmptyResponseRecovery = modelLoop.emptyResponseRecovery.pending;
      try {
        const invokeProvider = async (exactlyOnce: boolean) => {
          invocationAttempt++;
          const modelRequest = this.buildModelRequest(
            effectiveModel,
            systemBlocks,
            invocationTools,
            modelMessages,
            modelLoop.emptyResponseRecovery.toolsAllowed && requestWebSearchEnabled,
            isEmptyResponseRecovery ? DEFAULT_MAX_OUTPUT_TOKENS : undefined,
          );
          const provider = exactlyOnce
            ? this.exactlyOnceAnthropicProvider
            : this.anthropicProvider;
          return activeTurn.invoke(
            provider,
            modelRequest,
            {
              beforeDispatch: async (preparedInvocation) => {
                await this.notifyInvocationPrepared(
                  options,
                  preparedInvocation.providerRequest as unknown as PreparedProviderRequest,
                  iteration,
                  invocationAttempt,
                );
              },
            },
          );
        };
        // A replay is an exactly-once paid experiment. A timeout can occur
        // after provider acceptance, so neither our outer retry helper nor the
        // Anthropic SDK may submit the request again.
        response = options?.executionMode === 'replay' || isEmptyResponseRecovery
          ? await invokeProvider(true)
          : await withRetry(
            () => invokeProvider(false),
            { maxRetries: 3, initialDelayMs: 1000 },
            'processMessage',
          );
        if (operationalExecution) this.providerHealth.recordSuccess('anthropic', 'chat');
        if (isEmptyResponseRecovery) modelLoop.emptyResponseRecovery.resolve();
      } catch (error) {
        const fallbackResponse = isEmptyResponseRecovery
          ? modelLoop.emptyResponseRecovery.takeFallback()
          : null;
        if (fallbackResponse) {
          // The empty end_turn was a valid terminal response. Recovery is
          // best-effort: if its one extra call fails, retain that terminal and
          // its already-accounted usage rather than turning fallback into an
          // exception. Do not log a provider error that may echo input text.
          logger.warn({ iteration }, 'Addie: Empty-response recovery failed');
          response = fallbackResponse;
          reusedEmptyResponse = true;
        } else {
          const stats = this.buildPayloadDebugStats(effectiveModel, systemBlocks, customTools, anthropicMessages, iteration, requestWebSearchEnabled ? 1 : 0);
          if (options?.executionMode === 'replay') {
            // Provider errors may echo request text. Replay logs only categorical
            // metadata; the signed ledger records the terminal outcome.
            logger.error(
              { source: 'processMessage', payload: stats },
              'Addie: Replay provider invocation failed',
            );
          } else {
            this.logPromptOverflow(error, stats, 'processMessage');
          }
          if (operationalExecution) {
            const availability = this.providerHealth.recordFailure('anthropic', 'chat', error);
            if (!availability.allowed) {
              return providerUnavailableResponse(
                availability,
                requestedModel,
                toolsUsed,
                toolExecutions,
              );
            }
          }
          throw error;
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
      }, 'Addie: Claude response received');

      // Post-tool empty-response recovery is intentionally text-only. Defend
      // against a malformed provider response that nevertheless contains a
      // tool request: discard it instead of risking a duplicate mutation.
      if (modelLoop.emptyResponseRecovery.postToolAttempted && response.finishReason === 'tool_calls') {
        logger.warn({ iteration }, 'Addie: Ignoring tool use from text-only recovery');
        response = {
          ...response,
          finishReason: 'stop',
          providerFinishReason: 'end_turn',
          content: [],
        };
      }
      const turn = activeTurn.acceptResponse(response, { countUsage: !reusedEmptyResponse });

      // Provider-managed web results may accompany either a terminal answer or
      // another tool-call turn. Derive their receipts through the selected
      // adapter so private provider payloads never enter common orchestration.
      const earlyWebSearchResults = turn.providerToolResults;
      const earlyServerToolBlocks = turn.providerToolCalls;

      if (earlyWebSearchResults.length > 0) {
        for (const result of earlyWebSearchResults) {
          executionSequence++;
          toolsUsed.push('web_search');
          const correspondingToolUse = earlyServerToolBlocks.find((call) => call.id === result.toolCallId);
          const receipt = correspondingToolUse
            ? this.anthropicProvider.deriveProviderToolReceipt(
              correspondingToolUse,
              result,
              operationalExecution ? 'production' : 'redacted',
            )
            : {
              parameters: {},
              resultSummary: result.isError
                ? 'Web search failed'
                : `Web search completed (${result.resultCount} results)`,
              resultDetails: result.isError
                ? 'Web search failed'
                : `Web search completed (${result.resultCount} results)`,
              isError: result.isError,
            };
          const normalized = this.observeNormalizedToolResult('web_search', normalizeToolResult('web_search', {
            status: receipt.isError ? 'error' : result.resultCount === 0 ? 'empty' : 'ok',
            model_context: receipt.resultDetails,
            user_summary: receipt.resultSummary,
          }));
          const presentation = this.recordedToolPresentation(options, normalized);

          toolExecutions.push({
            tool_name: 'web_search',
            parameters: this.recordedToolParameters(options, receipt.parameters),
            result: this.recordedToolResult(options, normalized.model_context, receipt.isError ? 'error' : 'success'),
            result_summary: this.recordedToolResult(options, presentation.user_summary, receipt.isError ? 'error' : 'success'),
            is_error: receipt.isError,
            duration_ms: 0,
            sequence: executionSequence,
            normalized_result: presentation,
          });

          logger.debug(
            {
              resultCount: result.resultCount,
              ...(operationalExecution && {
                query: (receipt.parameters as Record<string, unknown>).query,
              }),
            },
            'Addie: Web search completed',
          );
        }
      }

      const stopAction = turn.action;

      if (stopAction === 'continue') {
        // Anthropic pause_turn and compaction responses are resumable only
        // when their content is included in the next request. Repeating the
        // unchanged prompt can loop or repeat server-side work.
        appendModelTurnContinuation(modelMessages, response);
        logger.info(
          { stopReason: response.providerFinishReason, iteration },
          'Addie: Continuing resumable Anthropic turn',
        );
        continue;
      }

      if (stopAction === 'truncated') {
        const rawText = turn.textBlocks
          .map((block) => block.text)
          .join('\n\n')
          .trim();
        const finalized = finalizeAssistantText(userMessage, rawText, toolExecutions, true);
        if (finalized.emptyReason) {
          reportEmptyResponseFallback(finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessage', effectiveModel, iteration);
        }
        const text = finalized.text;
        totalToolExecutionMs = toolExecutions.reduce((sum, execution) => sum + execution.duration_ms, 0);
        const finalUsage = toAddieUsage(modelLoop.usage);
        logger.error(
          {
            event: 'addie_response_truncated',
            source: 'processMessage',
            stopReason: response.providerFinishReason,
            iteration,
            originalLength: rawText.length,
            deliveredLength: text.length,
            contentTypes: boundedModelContentTypes(response.content),
            outputTokens: response.usage.outputTokens,
          },
          'Addie: Anthropic stopped before response completion',
        );
        if (operationalExecution && options?.costScope) {
          await recordCost(
            options.costScope.userId,
            options.modelOverride ?? AddieModelConfig.chat,
            finalUsage,
          );
        }
        return {
          text,
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: true,
          flag_reason: `Response truncated: ${response.providerFinishReason}`,
          active_rule_ids: undefined,
          config_version_id: configVersionId ?? undefined,
          model_execution: finalized.emptyReason
            ? localModelExecution('no_provider_response', effectiveModel)
            : anthropicModelExecution(response.model, effectiveModel),
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: iteration,
          },
          usage: finalUsage,
        };
      }

      // Done - no tool use, just text
      if (stopAction === 'complete') {
        // Collect ALL text blocks (web search responses have multiple text blocks)
        const rawText = turn.textBlocks
          .map((block) => block.text)
          .join('\n\n')
          .trim();
        // A provider-successful but wholly empty first sample has no visible
        // output or side effect. Production may safely resample it once; eval
        // and replay preserve the original terminal outcome for integrity.
        if (
          operationalExecution
          && response.providerFinishReason === 'end_turn'
          && iteration === 1
          && !modelLoop.emptyResponseRecovery.hasAttempted('initial')
          && !hasExecutedCustomTool
          && toolExecutions.length === 0
          && isSideEffectFreeEmptyModelResponse(response, rawText)
          && modelLoop.hasRemaining
        ) {
          modelLoop.emptyResponseRecovery.schedule('initial', response);
          logger.warn({ iteration }, 'Addie: Retrying wholly empty initial response');
          continue;
        }
        // Anthropic can occasionally return an empty end_turn immediately
        // after a tool result. Resampling the unchanged post-tool turn once is
        // safe because no assistant response has reached the caller yet.
        if (
          response.providerFinishReason === 'end_turn'
          && isSideEffectFreeEmptyModelResponse(response, rawText)
          && hasExecutedCustomTool
          && !modelLoop.emptyResponseRecovery.hasAttempted('post_tool')
          && modelLoop.hasRemaining
        ) {
          modelLoop.emptyResponseRecovery.schedule('post_tool', response);
          logger.warn({ iteration, toolsUsed }, 'Addie: Retrying empty response after tool use');
          continue;
        }
        const finalized = finalizeAssistantText(userMessage, rawText, toolExecutions);
        const text = finalized.text;

        // Calculate total tool execution time from tool_executions
        totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);

        // Detect possible hallucinated actions (text claims success without successful tool calls)
        const hallucinationReason = detectHallucinatedAction(text, toolExecutions);
        if (hallucinationReason) {
          logger.warn({ toolsUsed, reason: hallucinationReason }, 'Addie: Possible hallucinated action detected');
        }

        if (finalized.emptyReason) {
          reportEmptyResponseFallback(finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessage', effectiveModel, iteration);
        }
        if (finalized.lengthExceeded) {
          logger.error(
            {
              event: 'addie_response_truncated',
              source: 'processMessage',
              stopReason: response.providerFinishReason,
              iteration,
              originalLength: rawText.length,
              deliveredLength: text.length,
              localCapExceeded: true,
            },
            'Addie: Normally completed response exceeded output cap',
          );
        }
        const flagReason = finalized.lengthExceeded
          ? 'Output truncated due to length'
          : hallucinationReason ?? finalized.emptyReason;

        const finalUsage = toAddieUsage(modelLoop.usage);
        // Record the call against the user's daily budget (#2790).
        // Runs after the response is built so a successful charge
        // counts even if a downstream flag/logging failure occurs.
        // recordCost no-ops for missing userId / system users.
        if (operationalExecution && options?.costScope) {
          await recordCost(
            options.costScope.userId,
            options?.modelOverride ?? AddieModelConfig.chat,
            finalUsage,
          );
        }

        return {
          text,
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: !!flagReason,
          flag_reason: flagReason ?? undefined,
          active_rule_ids: undefined,
          config_version_id: configVersionId ?? undefined,
          model_execution: finalized.emptyReason
            ? localModelExecution('no_provider_response', effectiveModel)
            : anthropicModelExecution(response.model, effectiveModel),
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: iteration,
          },
          usage: finalUsage,
        };
      }

      // Handle tool use (both custom tools and server-managed tools like web_search)
      if (stopAction === 'tool_use') {
        // Get custom tool use blocks (these need our handlers)
        const toolUseBlocks = turn.toolCalls;

        // Get server tool use blocks (web_search - handled by Anthropic)
        const serverToolBlocks = turn.providerToolCalls;

        // Get web search results (already executed by Anthropic)
        const webSearchResults = turn.providerToolResults;

        // Track server-managed tool uses (web search)
        for (const block of serverToolBlocks) {
          executionSequence++;
          toolsUsed.push(block.name);

          // Find corresponding result by matching tool_use_id
          const resultBlock = webSearchResults.find((result) => result.toolCallId === block.id);
          const receipt = resultBlock
            ? this.anthropicProvider.deriveProviderToolReceipt(
              block,
              resultBlock,
              operationalExecution ? 'production' : 'redacted',
            )
            : {
              parameters: {},
              resultSummary: 'Web search completed',
              resultDetails: 'Web search completed',
              isError: false,
            };
          const normalized = this.observeNormalizedToolResult(block.name, normalizeToolResult(block.name, {
            status: receipt.isError ? 'error' : (resultBlock?.resultCount ?? 0) === 0 ? 'empty' : 'ok',
            model_context: receipt.resultDetails,
            user_summary: receipt.resultSummary,
          }));
          const presentation = this.recordedToolPresentation(options, normalized);

          toolExecutions.push({
            tool_name: block.name,
            parameters: this.recordedToolParameters(options, receipt.parameters),
            result: this.recordedToolResult(options, normalized.model_context, receipt.isError ? 'error' : 'success'),
            result_summary: this.recordedToolResult(options, presentation.user_summary, receipt.isError ? 'error' : 'success'),
            is_error: receipt.isError,
            duration_ms: 0, // Server-managed, we don't have timing
            sequence: executionSequence,
            normalized_result: presentation,
          });

          logger.debug({
            toolName: block.name,
            ...(operationalExecution && { inputKeys: block.inputKeys }),
            resultCount: resultBlock?.resultCount ?? 0,
          }, 'Addie: Server tool executed (web_search)');
        }

        // If only server tools were used (no custom tools), continue the loop
        // The web search results are already in the response, we just need to continue
        if (toolUseBlocks.length === 0 && serverToolBlocks.length > 0) {
          // Add the response content (including provider continuation state).
          appendModelTurnContinuation(modelMessages, response);
          continue;
        }

        if (toolUseBlocks.length === 0 && serverToolBlocks.length === 0) {
          const rawText = turn.textBlocks[0]?.text ?? '';
          const finalized = finalizeAssistantText(userMessage, rawText, toolExecutions);
          const text = finalized.text;
          if (finalized.emptyReason) {
            reportEmptyResponseFallback(finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessage', effectiveModel, iteration);
          }
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
          const terminalUsage = toAddieUsage(modelLoop.usage);
          if (finalized.lengthExceeded) {
            logger.error(
              { event: 'addie_response_truncated', source: 'processMessage', originalLength: rawText.length, deliveredLength: text.length, localCapExceeded: true },
              'Addie: Normally completed response exceeded output cap',
            );
          }
          if (operationalExecution && options?.costScope) {
            await recordCost(options.costScope.userId, options.modelOverride ?? AddieModelConfig.chat, terminalUsage);
          }
          return {
            text,
            tools_used: toolsUsed,
            tool_executions: toolExecutions,
            flagged: finalized.lengthExceeded || !!finalized.emptyReason,
            flag_reason: finalized.lengthExceeded ? 'Output truncated due to length' : finalized.emptyReason ?? undefined,
            active_rule_ids: undefined,
            config_version_id: configVersionId ?? undefined,
            model_execution: finalized.emptyReason
              ? localModelExecution('no_provider_response', effectiveModel)
              : anthropicModelExecution(response.model, effectiveModel),
            timing: {
              system_prompt_ms: systemPromptMs,
              total_llm_ms: totalLlmMs,
              total_tool_execution_ms: totalToolExecutionMs,
              iterations: iteration,
            },
            usage: terminalUsage,
          };
        }

        const toolResults: ModelToolResultContent[] = [];

        for (const block of toolUseBlocks) {
          const toolName = block.name;
          hasExecutedCustomTool = true;
          const toolInput = block.input;

          logger.debug(
            { toolName, ...(operationalExecution && { toolInput }) },
            'Addie: Calling tool',
          );
          toolsUsed.push(toolName);
          executionSequence++;
          const executed = await executeToolCall(block, executionSequence);
          toolResults.push(executed.result);
          toolExecutions.push(executed.execution);
        }

        appendModelTurnContinuation(modelMessages, response, toolResults);
      }
    }

    logger.warn('Addie: Hit max tool iterations');
    totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
    const maxIterationsUsage = toAddieUsage(modelLoop.usage);
    // Still charge the user for tokens actually consumed on the way
    // to hitting max-iterations — those bytes DID go to Anthropic
    // and DID cost money, regardless of whether the session converged.
    if (operationalExecution && options?.costScope) {
      await recordCost(
        options.costScope.userId,
        options?.modelOverride ?? AddieModelConfig.chat,
        maxIterationsUsage,
      );
    }
    return {
      text: "I'm having trouble completing that request. Could you try rephrasing?",
      tools_used: toolsUsed,
      tool_executions: toolExecutions,
      flagged: true,
      flag_reason: 'Max tool iterations reached',
      active_rule_ids: undefined,
      config_version_id: configVersionId ?? undefined,
      model_execution: localModelExecution('canned_response', effectiveModel),
      timing: {
        system_prompt_ms: systemPromptMs,
        total_llm_ms: totalLlmMs,
        total_tool_execution_ms: totalToolExecutionMs,
        iterations: modelLoop.limit,
      },
      usage: maxIterationsUsage,
    };
  }

  /**
   * Process a message with streaming - yields events as they occur
   *
   * Note: Tool use temporarily pauses text streaming while the tool executes,
   * then resumes with the response. The final 'done' event includes the complete response.
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
    const operationalExecution = !isEvaluationExecution(options);
    const requestedModel = options?.modelOverride ?? this.model;

    // #2950: matching fail-closed warn on the stream path.
    if (operationalExecution && !options?.costScope && !options?.uncapped) {
      logger.warn(
        { event: 'cost_cap_unwired', method: 'processMessageStream' },
        'claude-client stream called without costScope or uncapped:true — cost cap silently bypassed',
      );
    }

    // #2790: per-user Anthropic cost cap (streaming path). Same
    // contract as `processMessage` — yield a `done` event with the
    // friendly cap-exceeded text and return early instead of firing
    // another billable Claude call.
    let certificationReserveUsed = false;
    let certificationLeaseId: string | undefined;
    let certificationLeaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    if (operationalExecution && options?.costScope) {
      const capResult = await checkCostCap(
        options.costScope.userId,
        options.costScope.tier,
        { certificationReserveUsd: options.costScope.certificationReserveUsd },
      );
      certificationReserveUsed = capResult.usedCertificationReserve === true;
      certificationLeaseId = capResult.certificationLeaseId;
      if (!capResult.ok) {
        const message = formatCapExceededMessage(capResult)
          + (options.costScope.certificationReserveUsd ? ' Your certification progress is saved.' : '');
        logger.warn(
          {
            userId: options.costScope.userId,
            tier: options.costScope.tier,
            spentCents: capResult.spentCents,
            retryAfterMs: capResult.retryAfterMs,
          },
          'Addie cost cap exceeded — refusing Claude stream',
        );
        yield {
          type: 'done',
          response: {
            text: message,
            tools_used: [],
            tool_executions: [],
            flagged: true,
            flag_reason: 'cost_cap_exceeded',
            model_execution: {
              source: 'local',
              requested_provider: 'anthropic',
              requested_model: requestedModel,
              reason: 'cost_cap_exceeded',
            },
          },
        };
        return;
      }
    }

    // As above, cost-capped requests must not consume the one half-open probe.
    if (operationalExecution) {
      const availability = this.providerHealth.acquire('anthropic', 'chat');
      if (!availability.allowed) {
        await releaseCertificationReserve(options?.costScope?.userId, certificationLeaseId);
        certificationLeaseId = undefined;
        yield {
          type: 'done',
          response: providerUnavailableResponse(availability, requestedModel),
        };
        return;
      }
    }
    if (certificationLeaseId) {
      certificationLeaseHeartbeat = setInterval(() => {
        void renewCertificationReserve(options?.costScope?.userId, certificationLeaseId);
      }, 30_000);
    }

    const toolsUsed: string[] = [];
    const toolExecutions: ToolExecution[] = [];
    let executionSequence = 0;
    let logicalText = '';
    let totalReceivedDeltas = 0;
    let streamErrorEmitted = false;

    try {

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    // Get system prompt from rule files (or fallback)
    const promptStart = Date.now();
    const { prompt: systemPrompt } = this.getSystemPrompt();
    systemPromptMs = Date.now() - promptStart;

    // Build system content as array: base prompt is cached, requestContext is not.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    if (options?.requestContext?.trim()) {
      systemBlocks.push({ type: 'text', text: options.requestContext });
    }

    // Get config version ID for this interaction (for tracking/analysis)
    const configVersionId = operationalExecution
      ? await getCurrentConfigVersionId()
      : undefined;

    // Determine effective model (support precision mode override for billing/financial)
    const effectiveModel = options?.modelOverride ?? this.model;
    if (options?.modelOverride && options.modelOverride !== this.model) {
      logger.info({ model: effectiveModel, defaultModel: this.model }, 'Addie Stream: Using precision model for billing/financial query');
    }

    // Combine global tools with per-request tools, deduplicating by name (last wins)
    // Calculate tool count first to inform token budget for conversation history
    const allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : null;
    const allTools = mergeAddieToolDefinitions(
      this.tools,
      requestTools?.tools,
      options?.allowedToolNames,
    );
    const allHandlers = new Map(
      [...this.toolHandlers, ...(requestTools?.handlers || [])]
        .filter(([name]) => !allowedToolNames || allowedToolNames.has(name)),
    );
    const executeToolCall = createAddieToolExecutor(allTools, allHandlers, {
      executionMode: options?.executionMode ?? 'production',
      policy: options?.toolExecutionPolicy,
      notificationContext: {
        slackUserId: options?.slackUserId,
        userDisplayName: options?.userDisplayName,
        threadId: options?.threadId,
      },
    });
    const toolCount = allTools.length; // Note: streaming doesn't use web search

    // Build proper message turns from thread context
    // This sends conversation history as actual user/assistant turns, not flattened text
    // Token-aware: automatically trims older messages if conversation exceeds limits
    // Compact old tool results in all conversations to reclaim context
    const messageTurnsResult = buildMessageTurnsWithMetadata(userMessage, threadContext, {
      model: effectiveModel,
      toolCount,
      maxMessages: options?.maxMessages,
      compactToolResults: true,
      currentSpeakerName: options?.currentSpeakerName,
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
      // Inject dropped conversation summary so Addie has context from earlier turns
      if (messageTurnsResult.messagesRemoved > 10) {
        const summary = messageTurnsResult.droppedMessages
          ? buildDroppedMessagesSummary(messageTurnsResult.droppedMessages)
          : null;
        const contextWarning = summary
          || `\n\n## Context Warning\n${messageTurnsResult.messagesRemoved} earlier messages were dropped from this conversation to fit the context window. If the user references something you don't recall, let them know and suggest starting a new thread for better accuracy.`;
        systemBlocks.push({ type: 'text', text: contextWarning });
      }
    }

    const messages: Anthropic.MessageParam[] = appendInputAttachments(
      toAnthropicMessages(messageTurnsResult.messages),
      options?.inputAttachments,
    );
    const modelMessages = appendModelInputAttachments(
      toModelMessages(messageTurnsResult.messages),
      options?.inputAttachments,
    );

    // Build tool list once — rebuilt every iteration is wasteful since tools don't change.
    // Mark the last tool with cache_control so Anthropic caches all tool definitions.
    const customTools = buildAddieWireTools(allTools) as Anthropic.Tool[];
    const modelTools = buildModelToolDefinitions(allTools);
    const modelLoop = new ModelTurnLoopState(options?.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    let iteration = 0;
    let lastProviderModel: string | undefined;

      while (modelLoop.hasRemaining) {
        const activeTurn = modelLoop.beginNext();
        iteration = activeTurn.iteration;

        const llmStart = Date.now();

        // Collect full response for tool handling
        let currentResponse: ModelResponse | null = null;
        let reusedEmptyResponse = false;

        // Retry loop for streaming API calls (handles overloaded_error).
        // Logical-turn buffering means no model output is exposed and no
        // custom tool executes until a complete response is assembled, so a
        // failed sample is safe to discard and retry even after deltas arrive.
        const maxStreamRetries = 3;
        let streamRetryCount = 0;
        let streamSucceeded = false;
        let receivedDeltaCount = 0;

        while (!streamSucceeded && streamRetryCount <= maxStreamRetries) {
          const isEmptyResponseRecovery = modelLoop.emptyResponseRecovery.pending;
          try {
            const invocationTools = modelLoop.emptyResponseRecovery.toolsAllowed ? modelTools : [];
            const modelRequest = this.buildModelRequest(
              effectiveModel,
              systemBlocks,
              invocationTools,
              modelMessages,
              false,
              isEmptyResponseRecovery ? DEFAULT_MAX_OUTPUT_TOKENS : undefined,
              true,
            );
            const provider = isEmptyResponseRecovery
              ? this.exactlyOnceAnthropicProvider
              : this.anthropicProvider;
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
                    preparedInvocation.providerRequest as unknown as PreparedProviderRequest,
                    iteration,
                    streamRetryCount + 1,
                  );
                },
              },
            );

            if (operationalExecution) this.providerHealth.recordSuccess('anthropic', 'chat');
            streamSucceeded = true;
            lastProviderModel = currentResponse.model;
            if (isEmptyResponseRecovery) modelLoop.emptyResponseRecovery.resolve();
          } catch (streamError) {
            const fallbackResponse = isEmptyResponseRecovery
              ? modelLoop.emptyResponseRecovery.takeFallback()
              : null;
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
            const stats = this.buildPayloadDebugStats(effectiveModel, systemBlocks, customTools, messages, iteration);
            this.logPromptOverflow(streamError, stats, 'processMessageStream');

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
              if (operationalExecution) {
                const availability = this.providerHealth.recordFailure('anthropic', 'chat', streamError);
                if (!availability.allowed) {
                  const terminalResponse = providerUnavailableResponse(
                    availability,
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
                  const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
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
                throw new RetriesExhaustedError(streamError, streamRetryCount);
              }
              // Non-retryable failures are surfaced by the outer error path.
              throw streamError;
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
        }, 'Addie Stream: Claude response received');

        // The post-tool recovery iteration has no tools. If the provider still returns
        // a tool_use block, ignore it rather than executing a mutation twice.
        if (modelLoop.emptyResponseRecovery.postToolAttempted && currentResponse.finishReason === 'tool_calls') {
          logger.warn({ iteration }, 'Addie Stream: Ignoring tool use from text-only recovery');
          currentResponse = {
            ...currentResponse,
            finishReason: 'stop',
            providerFinishReason: 'end_turn',
            content: [],
          };
        }

        // Build the final usage block + charge the user's cost
        // budget (#2790). Both stream terminal paths (end_turn and
        // no-tool-blocks) serialize the same normalized accumulator.
        const buildStreamUsage = () => toAddieUsage(modelLoop.usage);
        const chargeStreamCost = async (usage: ReturnType<typeof buildStreamUsage>) => {
          if (operationalExecution && options?.costScope) {
            await recordCost(
              options.costScope.userId,
              options?.modelOverride ?? AddieModelConfig.chat,
              usage,
            );
          }
        };

        const turn = activeTurn.acceptResponse(currentResponse, { countUsage: !reusedEmptyResponse });
        const stopAction = turn.action;
        const iterationText = turn.textBlocks
          .map((block) => block.text)
          .join('\n\n');
        if (stopAction === 'continue') {
          // Resume from the provider response without exposing interim text.
          appendModelTurnContinuation(modelMessages, currentResponse);
          logger.info(
            { stopReason: currentResponse.providerFinishReason, iteration },
            'Addie Stream: Continuing resumable Anthropic turn',
          );
          continue;
        }

        if (stopAction === 'truncated') {
          logicalText += iterationText;
          const finalized = finalizeAssistantText(userMessage, logicalText, toolExecutions, true);
          if (finalized.emptyReason) {
            reportEmptyResponseFallback(finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessageStream', effectiveModel, iteration);
          }
          totalToolExecutionMs = toolExecutions.reduce((sum, execution) => sum + execution.duration_ms, 0);
          const streamUsage = buildStreamUsage();
          logger.error(
            {
              event: 'addie_response_truncated',
              source: 'processMessageStream',
              stopReason: currentResponse.providerFinishReason,
              iteration,
              originalLength: logicalText.length,
              deliveredLength: finalized.text.length,
              localCapExceeded: finalized.lengthExceeded,
              contentTypes: boundedModelContentTypes(currentResponse.content),
              outputTokens: currentResponse.usage.outputTokens,
            },
            'Addie Stream: Response stopped before completion',
          );
          await chargeStreamCost(streamUsage);
          yield { type: 'text', text: finalized.text };
          yield {
            type: 'done',
            response: {
              text: finalized.text,
              tools_used: toolsUsed,
              tool_executions: toolExecutions,
              flagged: true,
              flag_reason: `Response truncated: ${currentResponse.providerFinishReason}`,
              active_rule_ids: undefined,
              config_version_id: configVersionId ?? undefined,
              model_execution: finalized.emptyReason
                ? localModelExecution('no_provider_response', effectiveModel)
                : anthropicModelExecution(currentResponse.model, effectiveModel),
              timing: {
                system_prompt_ms: systemPromptMs,
                total_llm_ms: totalLlmMs,
                total_tool_execution_ms: totalToolExecutionMs,
                iterations: iteration,
              },
              usage: streamUsage,
              capacity: { certification_reserve_used: certificationReserveUsed },
            },
          };
          return;
        }

        // Done - no tool use
        if (stopAction === 'complete') {
          if (
            operationalExecution
            && currentResponse.providerFinishReason === 'end_turn'
            && iteration === 1
            && !modelLoop.emptyResponseRecovery.hasAttempted('initial')
            && toolExecutions.length === 0
            && logicalText.length === 0
            && isSideEffectFreeEmptyModelResponse(currentResponse, iterationText)
            && modelLoop.hasRemaining
          ) {
            modelLoop.emptyResponseRecovery.schedule('initial', currentResponse);
            logger.warn({ iteration }, 'Addie Stream: Retrying wholly empty initial response');
            continue;
          }

          // Logical-turn buffering means no text from this iteration has been
          // emitted, so retrying ritual-only output cannot duplicate text.
          if (
            currentResponse.providerFinishReason === 'end_turn'
            && isSideEffectFreeEmptyModelResponse(currentResponse, iterationText)
            && toolExecutions.length > 0
            && !modelLoop.emptyResponseRecovery.hasAttempted('post_tool')
            && modelLoop.hasRemaining
          ) {
            modelLoop.emptyResponseRecovery.schedule('post_tool', currentResponse);
            logger.warn({ iteration, toolsUsed }, 'Addie Stream: Retrying empty response after tool use');
            continue;
          }

          logicalText += iterationText;
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
          const finalized = finalizeAssistantText(userMessage, logicalText, toolExecutions);
          if (finalized.emptyReason) {
            reportEmptyResponseFallback(finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessageStream', effectiveModel, iteration);
          }

          const finalText = finalized.text;
          const hallucinationReason = detectHallucinatedAction(finalText, toolExecutions);
          if (hallucinationReason) {
            logger.warn({ toolsUsed, reason: hallucinationReason }, 'Addie Stream: Possible hallucinated action detected');
          }
          if (finalized.lengthExceeded) {
            logger.error(
              {
                event: 'addie_response_truncated',
                source: 'processMessageStream',
                stopReason: currentResponse.providerFinishReason,
                iteration,
                originalLength: logicalText.length,
                deliveredLength: finalText.length,
                localCapExceeded: true,
              },
              'Addie Stream: Normally completed response exceeded output cap',
            );
          }
          const flagReason = finalized.lengthExceeded
            ? 'Output truncated due to length'
            : hallucinationReason ?? finalized.emptyReason;

          const streamUsage = buildStreamUsage();
          await chargeStreamCost(streamUsage);
          yield { type: 'text', text: finalText };
          yield {
            type: 'done',
            response: {
              text: finalText,
              tools_used: toolsUsed,
              tool_executions: toolExecutions,
              flagged: !!flagReason,
              flag_reason: flagReason ?? undefined,
              active_rule_ids: undefined,
              config_version_id: configVersionId ?? undefined,
              model_execution: finalized.emptyReason
                ? localModelExecution('no_provider_response', effectiveModel)
                : anthropicModelExecution(currentResponse.model, effectiveModel),
              timing: {
                system_prompt_ms: systemPromptMs,
                total_llm_ms: totalLlmMs,
                total_tool_execution_ms: totalToolExecutionMs,
                iterations: iteration,
              },
              usage: streamUsage,
              capacity: { certification_reserve_used: certificationReserveUsed },
            },
          };
          return;
        }

        // Handle tool use
        if (stopAction === 'tool_use') {
          logicalText += iterationText;
          const toolUseBlocks = turn.toolCalls;

          if (toolUseBlocks.length === 0) {
            // No tools to execute, return current text
            totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
            const streamUsage = buildStreamUsage();
            const finalized = finalizeAssistantText(userMessage, logicalText, toolExecutions);
            if (finalized.emptyReason) {
              reportEmptyResponseFallback(finalized.emptyReason, toolsUsed, toolExecutions, options, 'processMessageStream', effectiveModel, iteration);
            }
            if (finalized.lengthExceeded) {
              logger.error(
                { event: 'addie_response_truncated', source: 'processMessageStream', originalLength: logicalText.length, deliveredLength: finalized.text.length, localCapExceeded: true },
                'Addie Stream: Normally completed response exceeded output cap',
              );
            }
            await chargeStreamCost(streamUsage);
            yield { type: 'text', text: finalized.text };
            yield {
              type: 'done',
              response: {
                text: finalized.text,
                tools_used: toolsUsed,
                tool_executions: toolExecutions,
                flagged: finalized.lengthExceeded || !!finalized.emptyReason,
                flag_reason: finalized.lengthExceeded ? 'Output truncated due to length' : finalized.emptyReason ?? undefined,
                active_rule_ids: undefined,
                config_version_id: configVersionId ?? undefined,
                model_execution: finalized.emptyReason
                  ? localModelExecution('no_provider_response', effectiveModel)
                  : anthropicModelExecution(currentResponse.model, effectiveModel),
                timing: {
                  system_prompt_ms: systemPromptMs,
                  total_llm_ms: totalLlmMs,
                  total_tool_execution_ms: totalToolExecutionMs,
                  iterations: iteration,
                },
                usage: streamUsage,
                capacity: { certification_reserve_used: certificationReserveUsed },
              },
            };
            return;
          }

          const toolResults: ModelToolResultContent[] = [];

          for (const block of toolUseBlocks) {
            const toolName = block.name;
            const toolInput = block.input;

            logger.debug(
              { toolName, ...(operationalExecution && { toolInput }) },
              'Addie Stream: Calling tool',
            );
            toolsUsed.push(toolName);
            executionSequence++;

            // Emit tool start event
            yield {
              type: 'tool_start',
              tool_name: toolName,
              parameters: this.recordedToolParameters(options, toolInput),
            };

            const executed = await executeToolCall(block, executionSequence);
            toolResults.push(executed.result);
            toolExecutions.push(executed.execution);
            yield {
              type: 'tool_end',
              tool_name: toolName,
              result: executed.execution.result,
              is_error: executed.execution.is_error,
              normalized_result: executed.execution.normalized_result,
            };
          }

          // Continue the conversation with tool results
          appendModelTurnContinuation(modelMessages, currentResponse, toolResults);

          // Add spacing between tool use and subsequent text to prevent run-on text
          if (logicalText.length > 0 && !logicalText.endsWith('\n')) {
            logicalText += '\n\n';
          }
        }
      }

      // Max iterations reached
      logger.warn('Addie Stream: Hit max tool iterations');
      totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
      const maxIterUsage = toAddieUsage(modelLoop.usage);
      // Charge the tokens consumed up to the max-iteration wall —
      // the API calls happened regardless of whether we converged.
      if (operationalExecution && options?.costScope) {
        await recordCost(
          options.costScope.userId,
          options?.modelOverride ?? AddieModelConfig.chat,
          maxIterUsage,
        );
      }
      const finalizedMaxIter = finalizeAssistantText(
        userMessage,
        logicalText || "I'm having trouble completing that request. Could you try rephrasing?",
        toolExecutions,
      );
      if (finalizedMaxIter.lengthExceeded) {
        logger.error(
          { event: 'addie_response_truncated', source: 'processMessageStream', originalLength: logicalText.length, deliveredLength: finalizedMaxIter.text.length, localCapExceeded: true },
          'Addie Stream: Max-iteration response exceeded output cap',
        );
      }
      yield { type: 'text', text: finalizedMaxIter.text };
      yield {
        type: 'done',
        response: {
          text: finalizedMaxIter.text,
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: true,
          flag_reason: 'Max tool iterations reached',
          active_rule_ids: undefined,
          config_version_id: configVersionId ?? undefined,
          model_execution: logicalText && lastProviderModel
            ? anthropicModelExecution(lastProviderModel, effectiveModel)
            : localModelExecution('canned_response', effectiveModel),
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: modelLoop.limit,
          },
          usage: maxIterUsage,
          capacity: { certification_reserve_used: certificationReserveUsed },
        },
      };
    } catch (error) {
      logger.error({ error }, 'Addie Stream: Error during streaming');
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
