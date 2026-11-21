import { types } from 'node:util';
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

// Objects whose whole subtree has been proven deep-frozen JSON data. Freezing
// is irreversible and the proof reads only data descriptors, so membership
// never goes stale: no later write, getter or trap can change what such an
// object serializes, clones or validates to.
const verifiedDeepFrozenJson = new WeakSet<object>();
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;
const DEEP_FROZEN_JSON_MAX_DEPTH = 100;
const DEEP_FROZEN_JSON_MAX_NODES = 20_000;

/**
 * True only when `value` is JSON data that can never change: every object in
 * it is frozen, proxy-free, a plain object (Object.prototype or null
 * prototype) or plain array, and holds only own enumerable data properties
 * with string keys; leaves are strings, booleans, null or finite numbers.
 * Caches keyed by the identity of such a value cannot return a stale result.
 *
 * The check never reads through a getter or a Proxy trap and never throws: a
 * cycle, an accessor, a mutable object or an input over the depth or node
 * bounds returns false, so the caller takes its ordinary uncached path (with
 * that path's own errors). Global intrinsic changes (for example a later
 * Object.prototype.toJSON) are outside what this predicate guards.
 */
export function isDeepFrozenJsonData(value: unknown): boolean {
  return verifyJsonData(value, true);
}

/**
 * True only for an object (or primitive) already proven by
 * isDeepFrozenJsonData. It never walks, so it is O(1); false means only "not
 * proven yet".
 */
export function isKnownDeepFrozenJsonData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value));
  }
  return verifiedDeepFrozenJson.has(value);
}

/**
 * The same proof without the frozen requirement: `value` is, right now,
 * accessor-free and proxy-free plain JSON data, so reading, cloning or
 * serializing it runs no caller code and loses nothing. A mutable value can
 * change later; nothing may be cached by its identity.
 */
export function isJsonData(value: unknown): boolean {
  return verifyJsonData(value, false);
}

function verifyJsonData(value: unknown, requireFrozen: boolean): boolean {
  const activeAncestors = new WeakSet<object>();
  let nodes = 0;
  const verify = (candidate: unknown, depth: number): boolean => {
    nodes++;
    if (nodes > DEEP_FROZEN_JSON_MAX_NODES || depth > DEEP_FROZEN_JSON_MAX_DEPTH) return false;
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object') return false;
    if (verifiedDeepFrozenJson.has(candidate)) return true;
    // Proxy identity is visible without running a trap; every reflective
    // call below would run one.
    if (types.isProxy(candidate) || activeAncestors.has(candidate)) return false;
    if (requireFrozen && !Object.isFrozen(candidate)) return false;
    if (Object.getOwnPropertySymbols(candidate).length !== 0) return false;
    activeAncestors.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<string, PropertyDescriptor>;
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) return false;
        const lengthDescriptor = descriptors['length'];
        if (!lengthDescriptor || !('value' in lengthDescriptor)) return false;
        const length = lengthDescriptor.value as number;
        for (const key of Object.keys(descriptors)) {
          if (key !== 'length' && (!ARRAY_INDEX.test(key) || Number(key) >= length)) return false;
        }
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
          if (!verify(descriptor.value, depth + 1)) return false;
        }
      } else {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null) return false;
        for (const descriptor of Object.values(descriptors)) {
          if (!('value' in descriptor) || !descriptor.enumerable) return false;
          if (!verify(descriptor.value, depth + 1)) return false;
        }
      }
    } finally {
      activeAncestors.delete(candidate);
    }
    // Recorded only in the frozen mode, after the whole subtree passed. Both
    // modes accept a recorded object: deep-frozen JSON data is JSON data.
    if (requireFrozen) verifiedDeepFrozenJson.add(candidate);
    return true;
  };
  return verify(value, 0);
}

// Tool schema roots that passed assertPlainJson and are deep-frozen JSON data.
// assertPlainJson is a pure function of such a value, so the walk (which a
// request repeats for every tool on every dispatch) need not run again. A
// root is recorded only after both checks pass; the predicate alone is not
// enough, because its node count skips already-verified subtrees.
const acceptedToolSchemas = new WeakSet<object>();

function assertPlainToolSchema(schema: unknown, label: string): void {
  if (typeof schema === 'object' && schema !== null && acceptedToolSchemas.has(schema)) return;
  assertPlainJson(schema, label);
  if (typeof schema === 'object' && schema !== null && isDeepFrozenJsonData(schema)) {
    acceptedToolSchemas.add(schema);
  }
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
    assertPlainToolSchema(tool.inputSchema, `Model tool schema ${tool.name}`);
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
