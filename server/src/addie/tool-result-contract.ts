/**
 * Addie's application-level tool result contract.
 *
 * Tool handlers may keep returning strings while they migrate. Every result is
 * normalized at the orchestration boundary so provider context, user fallback
 * text, and optional structured display data cannot accidentally become the
 * same unbounded blob.
 */

export const TOOL_RESULT_STATUSES = [
  'ok',
  'empty',
  'access_denied',
  'invalid_input',
  'recoverable_error',
  'error',
] as const;

export type ToolResultStatus = typeof TOOL_RESULT_STATUSES[number];

export interface ToolResultExposure {
  /** Short, audience-appropriate explanation. */
  summary: string;
  /** Machine-data fields explicitly approved for this audience. */
  fields?: readonly string[];
}

export interface StructuredToolResult {
  status: ToolResultStatus;
  /** Internal machine data. It is never exposed implicitly. */
  data?: Readonly<Record<string, unknown>>;
  model_context: string | ToolResultExposure;
  user_summary: string | ToolResultExposure;
  /**
   * Optional structured presentation. Only registered display types and the
   * explicitly named data fields survive normalization.
   */
  display?: unknown;
}

export type ToolHandlerResult = string | StructuredToolResult;

export interface ToolDisplayPayload {
  type: 'fields';
  data: Readonly<Record<string, unknown>>;
}

export interface ToolResultPresentation {
  status: ToolResultStatus;
  user_summary: string;
  display?: ToolDisplayPayload;
  /** Classified and structured results are safe to use as surface fallbacks. */
  source: 'legacy' | 'classified' | 'structured';
}

export interface NormalizedToolResult {
  status: ToolResultStatus;
  model_context: string;
  presentation: ToolResultPresentation;
  display_degradation?:
    | 'malformed_result'
    | 'malformed_display'
    | 'unsupported_display'
    | 'display_data_unreadable';
  model_context_truncated: boolean;
  user_summary_truncated: boolean;
}

export const MAX_TOOL_MODEL_CONTEXT_LENGTH = 20_000;
export const MAX_TOOL_USER_SUMMARY_LENGTH = 1_000;
const MAX_DISPLAY_FIELDS = 20;
const MAX_DISPLAY_DEPTH = 4;
const MAX_DISPLAY_COLLECTION_SIZE = 40;
const UNSAFE_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const STATUS_SET = new Set<string>(TOOL_RESULT_STATUSES);
const CLASSIFIED_SEARCH_TOOLS = new Set([
  'search_docs',
  'get_doc',
  'search_repos',
  'search_slack',
  'get_channel_activity',
  'search_resources',
  'get_recent_news',
  'web_search',
]);

const STATUS_FALLBACKS: Record<ToolResultStatus, string> = {
  ok: 'The tool completed successfully.',
  empty: 'No results were returned.',
  access_denied: 'You do not have access to that result.',
  invalid_input: 'The tool could not use the supplied input.',
  recoverable_error: 'The tool is temporarily unavailable. Please try again.',
  error: 'The tool could not complete the request.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): { value: string; truncated: boolean } {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return { value: trimmed, truncated: false };
  return {
    value: `${trimmed.slice(0, Math.max(0, limit - 24)).trimEnd()}\n\n[content truncated]`,
    truncated: true,
  };
}

function safeDisplayValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth >= MAX_DISPLAY_DEPTH || typeof value !== 'object') return '[nested value omitted]';
  if (seen.has(value)) return '[circular value omitted]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_DISPLAY_COLLECTION_SIZE)
        .map((entry) => safeDisplayValue(entry, depth + 1, seen));
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, MAX_DISPLAY_COLLECTION_SIZE)) {
      if (UNSAFE_FIELD_NAMES.has(key)) continue;
      const safeValue = safeDisplayValue((value as Record<string, unknown>)[key], depth + 1, seen);
      if (safeValue !== undefined) output[key] = safeValue;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function readAllowlistedFields(
  data: Readonly<Record<string, unknown>> | undefined,
  fields: readonly string[] | undefined,
): { data: Record<string, unknown>; unreadable: boolean } {
  const selected: Record<string, unknown> = {};
  if (!data || !fields) return { data: selected, unreadable: false };

  let unreadable = false;
  for (const field of [...new Set(fields)].slice(0, MAX_DISPLAY_FIELDS)) {
    if (
      typeof field !== 'string'
      || UNSAFE_FIELD_NAMES.has(field)
      || !Object.prototype.hasOwnProperty.call(data, field)
    ) continue;
    try {
      const value = safeDisplayValue(data[field], 0, new Set());
      if (value !== undefined) selected[field] = value;
    } catch {
      unreadable = true;
    }
  }
  return { data: selected, unreadable };
}

function formatFields(fields: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => {
    let rendered: string;
    try {
      rendered = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      rendered = '[unavailable]';
    }
    return `${key}: ${rendered}`;
  }).join('\n');
}

function normalizeExposure(
  exposure: string | ToolResultExposure,
  data: Readonly<Record<string, unknown>> | undefined,
  fallback: string,
  limit: number,
): { text: string; truncated: boolean; unreadable: boolean } {
  const summary = typeof exposure === 'string' ? exposure : exposure.summary;
  const selected = typeof exposure === 'string'
    ? { data: {}, unreadable: false }
    : readAllowlistedFields(data, exposure.fields);
  const details = formatFields(selected.data);
  const combined = `${typeof summary === 'string' && summary.trim() ? summary.trim() : fallback}${details ? `\n${details}` : ''}`;
  const bounded = truncate(combined, limit);
  return { text: bounded.value, truncated: bounded.truncated, unreadable: selected.unreadable };
}

function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/, 1)[0]?.trim() || '';
}

function classifySearchResult(toolName: string, text: string): {
  status: ToolResultStatus;
  summary: string;
} | null {
  if (!CLASSIFIED_SEARCH_TOOLS.has(toolName)) return null;
  const lower = text.toLowerCase();

  if (/cannot (?:search|access)|access denied|permission denied/.test(lower)) {
    return { status: 'access_denied', summary: firstParagraph(text) };
  }
  if (/unknown documentation version|invalid (?:repo_id|input|query)/.test(lower)) {
    return { status: 'invalid_input', summary: firstParagraph(text) };
  }
  if (/not (?:ready|yet indexed)|search failed|temporarily unavailable/.test(lower)) {
    return { status: 'recoverable_error', summary: firstParagraph(text) };
  }
  if (/^(?:no |document not found)/i.test(text.trim())) {
    return { status: 'empty', summary: firstParagraph(text) };
  }

  const found = text.match(/\bFound (\d+) ([^.\n:]+)/i);
  if (found) {
    return { status: 'ok', summary: `Found ${found[1]} ${found[2].trim()}.` };
  }
  return { status: 'ok', summary: STATUS_FALLBACKS.ok };
}

function normalizeLegacy(toolName: string, raw: string): NormalizedToolResult {
  const boundedModel = truncate(
    raw.trim() ? raw : 'The tool returned no content.',
    MAX_TOOL_MODEL_CONTEXT_LENGTH,
  );
  if (!raw.trim()) {
    return {
      status: 'empty',
      model_context: boundedModel.value,
      presentation: {
        status: 'empty',
        user_summary: STATUS_FALLBACKS.empty,
        source: 'classified',
      },
      model_context_truncated: boundedModel.truncated,
      user_summary_truncated: false,
    };
  }

  const classified = classifySearchResult(toolName, raw);
  const status = classified?.status ?? (/^error:/i.test(raw.trim()) ? 'error' : 'ok');
  const source = classified ? 'classified' : 'legacy';
  const boundedSummary = truncate(
    classified?.summary || STATUS_FALLBACKS[status],
    MAX_TOOL_USER_SUMMARY_LENGTH,
  );
  return {
    status,
    model_context: boundedModel.value,
    presentation: {
      status,
      user_summary: boundedSummary.value || STATUS_FALLBACKS[status],
      source,
    },
    model_context_truncated: boundedModel.truncated,
    user_summary_truncated: boundedSummary.truncated,
  };
}

function normalizeStructured(raw: StructuredToolResult): NormalizedToolResult {
  const status = raw.status;
  const fallback = STATUS_FALLBACKS[status];
  const model = normalizeExposure(
    raw.model_context,
    raw.data,
    fallback,
    MAX_TOOL_MODEL_CONTEXT_LENGTH,
  );
  const user = normalizeExposure(
    raw.user_summary,
    raw.data,
    fallback,
    MAX_TOOL_USER_SUMMARY_LENGTH,
  );

  let display: ToolDisplayPayload | undefined;
  let displayDegradation: NormalizedToolResult['display_degradation'];
  if (raw.display !== undefined) {
    if (!isRecord(raw.display) || typeof raw.display.type !== 'string') {
      displayDegradation = 'malformed_display';
    } else if (raw.display.type !== 'fields') {
      displayDegradation = 'unsupported_display';
    } else if (!Array.isArray(raw.display.fields)) {
      displayDegradation = 'malformed_display';
    } else {
      const selected = readAllowlistedFields(
        raw.data,
        raw.display.fields.filter((field): field is string => typeof field === 'string'),
      );
      display = { type: 'fields', data: selected.data };
      if (selected.unreadable) displayDegradation = 'display_data_unreadable';
    }
  }

  if (!displayDegradation && (model.unreadable || user.unreadable)) {
    displayDegradation = 'display_data_unreadable';
  }

  return {
    status,
    model_context: model.text || fallback,
    presentation: {
      status,
      user_summary: user.text || fallback,
      ...(display && { display }),
      source: 'structured',
    },
    ...(displayDegradation && { display_degradation: displayDegradation }),
    model_context_truncated: model.truncated,
    user_summary_truncated: user.truncated,
  };
}

function malformedToolResult(): NormalizedToolResult {
  const fallback = STATUS_FALLBACKS.error;
  return {
    status: 'error',
    model_context: 'Error: Tool returned a malformed result.',
    presentation: {
      status: 'error',
      user_summary: fallback,
      source: 'structured',
    },
    display_degradation: 'malformed_result',
    model_context_truncated: false,
    user_summary_truncated: false,
  };
}

export function normalizeToolResult(toolName: string, raw: unknown): NormalizedToolResult {
  if (typeof raw === 'string') return normalizeLegacy(toolName, raw);
  try {
    if (isRecord(raw) && typeof raw.status === 'string' && STATUS_SET.has(raw.status)) {
      if (
        (typeof raw.model_context === 'string' || isRecord(raw.model_context))
        && (typeof raw.user_summary === 'string' || isRecord(raw.user_summary))
      ) {
        return normalizeStructured(raw as unknown as StructuredToolResult);
      }
    }
  } catch {
    return malformedToolResult();
  }
  return malformedToolResult();
}

/**
 * `recoverable_error` means a retry on a later turn is expected to succeed;
 * `error` means retrying unchanged input is not expected to help.
 */
export function normalizeToolError(
  toolName: string,
  error: unknown,
  options: { expected: boolean },
): NormalizedToolResult {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const lower = message.toLowerCase();
  let status: ToolResultStatus = 'error';
  if (/access denied|not authorized|not authenticated|permission/.test(lower)) {
    status = 'access_denied';
  } else if (/\b(required|invalid|must be|cannot be empty|unsupported)\b/.test(lower)) {
    status = 'invalid_input';
  } else if (options.expected && /try again|temporar|timeout|timed out|unavailable|failed to (?:fetch|load|reach)/.test(lower)) {
    status = 'recoverable_error';
  }

  const normalized = normalizeLegacy(toolName, `Error: ${message}`);
  const summary = truncate(STATUS_FALLBACKS[status], MAX_TOOL_USER_SUMMARY_LENGTH);
  return {
    ...normalized,
    status,
    presentation: {
      status,
      user_summary: summary.value,
      source: 'classified',
    },
    user_summary_truncated: summary.truncated,
  };
}

export function isToolResultError(status: ToolResultStatus): boolean {
  return status === 'access_denied'
    || status === 'invalid_input'
    || status === 'recoverable_error'
    || status === 'error';
}

export function renderToolResultForUser(
  presentation: ToolResultPresentation,
  onDegraded?: (reason: 'renderer_failure') => void,
): string {
  try {
    const summary = presentation.user_summary.trim() || STATUS_FALLBACKS[presentation.status];
    if (!presentation.display || Object.keys(presentation.display.data).length === 0) return summary;
    const details = formatFields(presentation.display.data);
    return truncate(`${summary}${details ? `\n${details}` : ''}`, MAX_TOOL_USER_SUMMARY_LENGTH).value;
  } catch {
    onDegraded?.('renderer_failure');
    return STATUS_FALLBACKS[presentation.status] || STATUS_FALLBACKS.error;
  }
}

export function renderToolExecutionsFallback(
  executions: ReadonlyArray<{ tool_name: string; normalized_result?: ToolResultPresentation }>,
  onDegraded?: (toolName: string, reason: 'renderer_failure') => void,
): string | null {
  const eligible = executions
    .filter((execution) => execution.normalized_result !== undefined
      && execution.normalized_result.source !== 'legacy')
    .slice(-3);
  if (eligible.length === 0) return null;

  const rendered = eligible.map((execution) => renderToolResultForUser(
    execution.normalized_result!,
    (reason) => onDegraded?.(execution.tool_name, reason),
  )).filter((text) => text.trim().length > 0);
  if (rendered.length === 0) return STATUS_FALLBACKS.error;
  if (rendered.length === 1) return rendered[0];
  return rendered.map((text) => `- ${text}`).join('\n');
}
