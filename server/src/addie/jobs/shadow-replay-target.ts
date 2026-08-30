import {
  GOOGLE_ROUTER_MODEL,
  GoogleGenerateContentProvider,
} from '../model-providers/google-generate-content-provider.js';

interface ShadowReplayTargetEnvironment {
  SHADOW_EVAL_FULL_RESPONSE_GOOGLE_ENABLED?: string;
  SHADOW_EVAL_FULL_RESPONSE_GOOGLE_PRODUCTION_DATA_APPROVED?: string;
  SHADOW_EVAL_FULL_RESPONSE_GOOGLE_MODEL?: string;
  GEMINI_API_KEY?: string;
}

export type ShadowReplayTargetSelection =
  | { mode: 'source'; reason: 'google_disabled' }
  | {
      mode: 'blocked';
      reason:
        | 'google_production_data_not_approved'
        | 'google_model_invalid'
        | 'google_credentials_unavailable';
    }
  | {
      mode: 'alternate';
      reason: 'google_enabled';
      provider: 'google';
      model: typeof GOOGLE_ROUTER_MODEL;
    };

/**
 * Alternate full-response replay is independently default-off. A partially
 * enabled target blocks rather than falling back to the source provider and
 * contaminating the requested-provider cohort.
 */
export function selectShadowReplayTarget(
  env: ShadowReplayTargetEnvironment = process.env,
): ShadowReplayTargetSelection {
  if (env.SHADOW_EVAL_FULL_RESPONSE_GOOGLE_ENABLED !== 'true') {
    return { mode: 'source', reason: 'google_disabled' };
  }
  if (env.SHADOW_EVAL_FULL_RESPONSE_GOOGLE_PRODUCTION_DATA_APPROVED !== 'true') {
    return { mode: 'blocked', reason: 'google_production_data_not_approved' };
  }
  if (env.SHADOW_EVAL_FULL_RESPONSE_GOOGLE_MODEL?.trim() !== GOOGLE_ROUTER_MODEL) {
    return { mode: 'blocked', reason: 'google_model_invalid' };
  }
  if (!env.GEMINI_API_KEY?.trim()) {
    return { mode: 'blocked', reason: 'google_credentials_unavailable' };
  }
  return {
    mode: 'alternate',
    reason: 'google_enabled',
    provider: 'google',
    model: GOOGLE_ROUTER_MODEL,
  };
}

export function createGoogleShadowReplayProvider(
  env: ShadowReplayTargetEnvironment = process.env,
): GoogleGenerateContentProvider | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  return apiKey ? new GoogleGenerateContentProvider(apiKey) : null;
}
