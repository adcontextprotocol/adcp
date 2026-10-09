import { AddieModelConfig } from '../config/models.js';
import { GOOGLE_ROUTER_MODEL } from './model-providers/google-generate-content-provider.js';

/** Response generation only. Internal routing/classification jobs keep their own models. */
export function getResponseProviderPolicy(env = process.env) {
  const provider = env.ADDIE_RESPONSE_PROVIDER ?? 'gemini';
  if (provider !== 'gemini' && provider !== 'sonnet') {
    throw new Error('ADDIE_RESPONSE_PROVIDER must be gemini or sonnet');
  }
  const fallback = env.ADDIE_RESPONSE_AUTOMATIC_FALLBACK ?? 'false';
  if (fallback !== 'true' && fallback !== 'false') {
    throw new Error('ADDIE_RESPONSE_AUTOMATIC_FALLBACK must be true or false');
  }
  return { provider, automaticFallback: fallback === 'true' } as const;
}

export function responseProviderModel(): string {
  return getResponseProviderPolicy().provider === 'gemini' ? GOOGLE_ROUTER_MODEL : AddieModelConfig.chat;
}

export function responseProviderId(): 'google' | 'anthropic' {
  return getResponseProviderPolicy().provider === 'gemini' ? 'google' : 'anthropic';
}
