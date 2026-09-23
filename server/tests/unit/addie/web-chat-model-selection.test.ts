import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWebChatModelPreference, webChatModelInfo } from '../../../src/addie/web-chat-model-selection.js';

const execution = {
  model_preference: 'gemini' as const, model_execution_source: 'provider' as const,
  model_provider: 'anthropic' as const, provider_model: 'claude-sonnet-4-6',
  requested_model: 'gemini-3.7-flash', provider_model_resolution: 'fallback' as const, latency_ms: 1250,
  provider_fallback_reason: 'primary_unavailable' as const,
};

describe('Web chat model choice and evidence', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts named choices only for authenticated production requests', () => {
    expect(parseWebChatModelPreference(undefined, false)).toBe('default');
    vi.stubEnv('ADDIE_RESPONSE_PROVIDER', 'gemini');
    expect(() => parseWebChatModelPreference('sonnet', true)).toThrow('response provider policy');
    expect(parseWebChatModelPreference('gemini', true)).toBe('default');
    expect(() => parseWebChatModelPreference('gemini', false)).toThrow('Sign in');
    expect(() => parseWebChatModelPreference('gemini', true, true)).toThrow('evaluation');
    for (const invalid of [null, {}, [], 'gemini-arbitrary']) {
      expect(() => parseWebChatModelPreference(invalid, true)).toThrow('model_preference');
    }
  });

  it('lets operator rollback override stale browser choices without recording a manual experiment choice', () => {
    vi.stubEnv('ADDIE_RESPONSE_PROVIDER', 'sonnet');
    expect(parseWebChatModelPreference('sonnet', true)).toBe('default');
    expect(parseWebChatModelPreference('gemini', true)).toBe('default');
  });

  it('uses actual provider evidence for a handoff instead of the requested model', () => {
    expect(webChatModelInfo(execution)).toEqual({ selected: 'gemini', source: 'provider',
      model: 'claude-sonnet-4-6', requested_model: 'gemini-3.7-flash', fallback: true, fallback_reason: 'primary_unavailable', latency_ms: 1250 });
    expect(webChatModelInfo({ ...execution, provider_model_resolution: 'exact' }).fallback).toBe(true);
  });

  it('does not invent provider evidence for local or legacy responses', () => {
    expect(webChatModelInfo({ ...execution, model_execution_source: 'local' })).toMatchObject({ source: 'local', model: null, fallback: false });
    expect(webChatModelInfo({ ...execution, model_execution_source: undefined })).toMatchObject({ source: 'legacy', model: null, fallback: false });
  });
});
