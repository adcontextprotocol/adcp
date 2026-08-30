import { describe, expect, it } from 'vitest';
import {
  createGoogleShadowReplayProvider,
  selectShadowReplayTarget,
} from '../../../src/addie/jobs/shadow-replay-target.js';
import { GOOGLE_ROUTER_MODEL } from '../../../src/addie/model-providers/google-generate-content-provider.js';

const enabled = {
  SHADOW_EVAL_FULL_RESPONSE_GOOGLE_ENABLED: 'true',
  SHADOW_EVAL_FULL_RESPONSE_GOOGLE_PRODUCTION_DATA_APPROVED: 'true',
  SHADOW_EVAL_FULL_RESPONSE_GOOGLE_MODEL: GOOGLE_ROUTER_MODEL,
  GEMINI_API_KEY: 'test-key',
};

describe('shadow replay target admission', () => {
  it('preserves source replay when Google is disabled', () => {
    expect(selectShadowReplayTarget({})).toEqual({
      mode: 'source',
      reason: 'google_disabled',
    });
  });

  it('blocks partially configured production-data admission', () => {
    expect(selectShadowReplayTarget({
      ...enabled,
      SHADOW_EVAL_FULL_RESPONSE_GOOGLE_PRODUCTION_DATA_APPROVED: 'false',
    })).toEqual({ mode: 'blocked', reason: 'google_production_data_not_approved' });
    expect(selectShadowReplayTarget({
      ...enabled,
      SHADOW_EVAL_FULL_RESPONSE_GOOGLE_MODEL: 'gemini-other',
    })).toEqual({ mode: 'blocked', reason: 'google_model_invalid' });
    expect(selectShadowReplayTarget({
      ...enabled,
      GEMINI_API_KEY: ' ',
    })).toEqual({ mode: 'blocked', reason: 'google_credentials_unavailable' });
  });

  it('selects only the exact supported Google target', () => {
    expect(selectShadowReplayTarget(enabled)).toEqual({
      mode: 'alternate',
      reason: 'google_enabled',
      provider: 'google',
      model: GOOGLE_ROUTER_MODEL,
    });
    expect(createGoogleShadowReplayProvider(enabled)?.id).toBe('google');
    expect(createGoogleShadowReplayProvider({})).toBeNull();
  });
});
