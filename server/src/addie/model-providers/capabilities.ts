import {
  UnsupportedModelCapabilityError,
  type ModelProviderCapabilities,
  type ModelProviderId,
  type ModelRequest,
  type JsonValue,
} from './model-provider.js';

export interface ModelCapabilityRequirements {
  streaming?: boolean;
}

export function assertPlainJson(value: unknown, label: string): asserts value is JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes++;
    if (nodes > 20_000 || depth > 100) throw new Error(`${label} exceeds JSON complexity limit`);
    if (
      candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
    ) return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error(`${label} must contain finite JSON numbers`);
      return;
    }
    if (typeof candidate !== 'object') throw new Error(`${label} must contain only JSON values`);
    if (seen.has(candidate)) throw new Error(`${label} must not contain cycles`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} must use plain JSON objects`);
      }
      for (const item of Object.values(candidate)) visit(item, depth + 1);
    }
    seen.delete(candidate);
  };
  visit(value, 0);
}

/** Fail closed before an adapter silently drops a requested feature. */
export function validateModelCapabilities(
  provider: ModelProviderId,
  capabilities: ModelProviderCapabilities,
  request: ModelRequest,
  requirements: ModelCapabilityRequirements = {},
): void {
  if (!request.model.trim()) throw new Error('Model request requires a model');
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    throw new Error('Model request maxOutputTokens must be a positive safe integer');
  }
  const toolNames = new Set<string>();
  for (const tool of request.tools) {
    if (!tool.name.trim()) throw new Error('Model tool requires a name');
    if (toolNames.has(tool.name)) throw new Error(`Duplicate model tool: ${tool.name}`);
    toolNames.add(tool.name);
    assertPlainJson(tool.inputSchema, `Model tool schema ${tool.name}`);
  }
  const providerToolTypes = new Set<string>();
  for (const providerTool of request.providerTools ?? []) {
    if (providerToolTypes.has(providerTool.type)) {
      throw new Error(`Duplicate provider tool: ${providerTool.type}`);
    }
    providerToolTypes.add(providerTool.type);
    if (providerTool.type === 'web_search' && toolNames.has('web_search')) {
      throw new Error('Custom tool name collides with provider tool: web_search');
    }
  }
  if (request.toolChoice) {
    if (request.tools.length === 0 && (request.providerTools?.length ?? 0) === 0) {
      throw new Error('Model tool choice requires at least one tool');
    }
    if (request.toolChoice.type === 'tool') {
      if (!request.toolChoice.name.trim()) {
        throw new Error('Named model tool choice requires a name');
      }
      if (!toolNames.has(request.toolChoice.name)) {
        throw new Error(`Named model tool choice is unavailable: ${request.toolChoice.name}`);
      }
    }
  }

  const requireCapability = (
    required: boolean,
    capability: keyof ModelProviderCapabilities,
  ) => {
    if (required && !capabilities[capability]) {
      throw new UnsupportedModelCapabilityError(provider, capability);
    }
  };

  requireCapability(requirements.streaming === true, 'streaming');
  requireCapability(request.outputSchema !== undefined, 'structuredOutput');
  if (request.outputSchema) {
    assertPlainJson(request.outputSchema.schema, `Model output schema ${request.outputSchema.name}`);
  }
  requireCapability(
    request.reasoning !== undefined && request.reasoning.effort !== 'none',
    'reasoning',
  );
  if (
    request.reasoning
    && !capabilities.reasoningEfforts.includes(request.reasoning.effort)
  ) {
    throw new UnsupportedModelCapabilityError(provider, 'reasoning');
  }
  requireCapability(request.tools.length > 0, 'customTools');
  requireCapability(
    request.providerTools?.some((tool) => tool.type === 'web_search') === true,
    'providerWebSearch',
  );

  let hasImage = false;
  let hasDocument = false;
  for (const message of request.messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call') {
        assertPlainJson(content.input, `Model tool input ${content.name}`);
      }
      if (content.type === 'image') hasImage = true;
      if (content.type === 'document') hasDocument = true;
      if (content.type === 'tool_result' && Array.isArray(content.content)) {
        hasImage ||= content.content.some((item) => item.type === 'image');
        hasDocument ||= content.content.some((item) => item.type === 'document');
      }
    }
  }
  requireCapability(hasImage, 'imageInput');
  requireCapability(hasDocument, 'documentInput');
}
