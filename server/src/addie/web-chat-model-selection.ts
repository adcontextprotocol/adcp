import type { ThreadMessage } from './thread-service.js';

export type WebChatModelPreference = 'default' | 'gemini' | 'sonnet';

export class WebChatModelPreferenceError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

/** A model choice never supplies a provider/model ID or changes account permissions. */
export function parseWebChatModelPreference(value: unknown, authenticated: boolean, evaluation = false): WebChatModelPreference {
  if (value === undefined || value === 'default') return 'default';
  if (value !== 'gemini' && value !== 'sonnet') {
    throw new WebChatModelPreferenceError('model_preference must be default, gemini, or sonnet.', 400);
  }
  if (!authenticated) throw new WebChatModelPreferenceError('Sign in to choose a model.', 403);
  if (evaluation) throw new WebChatModelPreferenceError('Model selection is unavailable on evaluation routes.', 400);
  return value;
}

export interface WebChatModelInfo {
  selected: WebChatModelPreference;
  source: 'provider' | 'local' | 'legacy';
  model: string | null;
  requested_model: string | null;
  fallback: boolean;
  latency_ms: number | null;
}

/** Render stored execution evidence, including replayed and historical replies. */
export function webChatModelInfo(message: Pick<ThreadMessage,
  'model_preference' | 'model_execution_source' | 'provider_model' | 'requested_model'
  | 'provider_model_resolution' | 'model_provider' | 'latency_ms'>): WebChatModelInfo {
  const selected = message.model_preference ?? 'default';
  const source = message.model_execution_source ?? 'legacy';
  return {
    selected,
    source,
    model: source === 'provider' ? message.provider_model ?? null : null,
    requested_model: message.requested_model ?? null,
    fallback: source === 'provider' && (message.provider_model_resolution === 'fallback'
      || (selected === 'gemini' && message.model_provider !== 'google')),
    latency_ms: message.latency_ms ?? null,
  };
}
