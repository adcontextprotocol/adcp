/**
 * Provider-neutral model boundary for Addie.
 *
 * Keep application orchestration outside this contract: providers prepare and
 * execute model requests, but never dispatch Addie tools, choose retries, or
 * select a fallback provider. Those decisions belong to Addie's common loop.
 */

export type ModelProviderId = 'anthropic' | 'openai' | 'google';
export type ModelReasoningEffort = 'provider_default' | 'none' | 'low' | 'medium' | 'high';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface ModelProviderCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  reasoningEfforts: ReadonlyArray<ModelReasoningEffort>;
  customTools: boolean;
  providerWebSearch: boolean;
  imageInput: boolean;
  documentInput: boolean;
}

export interface ModelSystemBlock {
  text: string;
  /** Portable cache hint. Providers may reject unsupported hints. */
  cacheHint?: 'ephemeral';
}

export interface ModelTextContent {
  type: 'text';
  text: string;
}

export interface ModelImageContent {
  type: 'image';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export interface ModelDocumentContent {
  type: 'document';
  mediaType: 'application/pdf';
  data: string;
}

export interface ModelToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  input: JsonObject;
}

export interface ModelToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  content: string | Array<ModelTextContent | ModelImageContent | ModelDocumentContent>;
  isError?: boolean;
}

/**
 * Same-provider continuation state, such as Anthropic server-tool results or
 * thinking blocks. It is explicitly non-portable and must never be sent to a
 * different provider during fallback.
 */
export interface ModelProviderStateContent {
  type: 'provider_state';
  provider: ModelProviderId;
  kind: string;
}

export interface ModelProviderToolCallContent {
  type: 'provider_tool_call';
  provider: ModelProviderId;
  id: string;
  name: string;
  /** Bounded, non-secret shape metadata; raw provider input remains private. */
  inputKeys: string[];
}

export interface ModelProviderToolResultContent {
  type: 'provider_tool_result';
  provider: ModelProviderId;
  toolCallId: string;
  name: string;
  resultCount: number;
  isError: boolean;
  errorCode?: string;
}

export interface ModelProviderToolReceipt {
  toolCallId: string;
  toolName: string;
  parameters: JsonObject;
  resultSummary: string;
  resultDetails: string;
  isError: boolean;
}

export type ModelMessageContent =
  | ModelTextContent
  | ModelImageContent
  | ModelDocumentContent
  | ModelToolCallContent
  | ModelToolResultContent
  | ModelProviderToolCallContent
  | ModelProviderToolResultContent
  | ModelProviderStateContent;

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelMessageContent[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<JsonObject>;
  cacheHint?: 'ephemeral';
}

export interface ModelProviderWebSearchTool {
  type: 'web_search';
}

export type ModelProviderTool = ModelProviderWebSearchTool;

export interface ModelOutputSchema {
  name: string;
  description?: string;
  schema: Readonly<JsonObject>;
  strict?: boolean;
}

export interface ModelRequest {
  model: string;
  system: ModelSystemBlock[];
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  providerTools?: ModelProviderTool[];
  outputSchema?: ModelOutputSchema;
  reasoning?: { effort: ModelReasoningEffort };
  maxOutputTokens: number;
  requestMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export type ModelFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'refusal'
  | 'continue';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface ModelResponse {
  provider: ModelProviderId;
  model: string;
  id: string;
  content: ModelMessageContent[];
  finishReason: ModelFinishReason;
  /** Bounded provider value for diagnostics; orchestration must use finishReason. */
  providerFinishReason: string;
  usage: ModelUsage;
}

export type NormalizedModelEvent =
  | { type: 'response_start'; provider: ModelProviderId; model: string; id?: string }
  | { type: 'text_delta'; index: number; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      inputJsonDelta?: string;
    }
  | { type: 'tool_call'; index: number; call: ModelToolCallContent }
  | { type: 'provider_tool_call'; index: number; call: ModelProviderToolCallContent }
  | { type: 'provider_tool_result'; index: number; result: ModelProviderToolResultContent }
  | { type: 'provider_state'; index: number; state: ModelProviderStateContent }
  | { type: 'response_complete'; response: ModelResponse };

export interface PreparedModelInvocation {
  provider: ModelProviderId;
  model: string;
  capabilities: ModelProviderCapabilities;
  /** Application correlation metadata; not silently forwarded to providers. */
  requestMetadata?: Readonly<Record<string, string | number | boolean>>;
  /** Exact object handed to the SDK, exposed for last-moment signed parity. */
  providerRequest: Readonly<Record<string, unknown>>;
}

export interface ModelRespondOptions {
  signal?: AbortSignal;
  /** Runs immediately before the one SDK dispatch made by this iterator. */
  beforeDispatch?: (prepared: PreparedModelInvocation) => void | Promise<void>;
}

export interface ModelProvider {
  readonly id: ModelProviderId;
  readonly capabilities: ModelProviderCapabilities;
  prepare(request: ModelRequest): PreparedModelInvocation;
  respond(request: ModelRequest, options?: ModelRespondOptions): AsyncIterable<NormalizedModelEvent>;
  deriveProviderToolReceipt?(
    call: ModelProviderToolCallContent,
    result: ModelProviderToolResultContent,
    disclosure: 'production' | 'redacted',
  ): ModelProviderToolReceipt;
}

export class UnsupportedModelCapabilityError extends Error {
  constructor(
    readonly provider: ModelProviderId,
    readonly capability: keyof ModelProviderCapabilities,
  ) {
    super(`${provider} provider does not support requested capability: ${capability}`);
    this.name = 'UnsupportedModelCapabilityError';
  }
}
