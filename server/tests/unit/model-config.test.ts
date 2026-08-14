import { describe, expect, it } from 'vitest';

import { disableAdaptiveThinking, GeminiModelConfig } from '../../src/config/models.js';

describe('disableAdaptiveThinking', () => {
  it.each([
    'claude-sonnet-5',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
  ])('disables thinking only on supported model %s', (model) => {
    expect(disableAdaptiveThinking(model)).toEqual({ thinking: { type: 'disabled' } });
  });

  it.each([
    'claude-fable-5',
    'claude-mythos-5',
    'claude-mythos-preview',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'custom-model',
  ])('omits unsupported thinking configuration for %s', (model) => {
    expect(disableAdaptiveThinking(model)).toEqual({});
  });
});

describe('GeminiModelConfig', () => {
  it('keeps C2PA version provenance aligned with the selected image model', () => {
    const expectedVersion = process.env.GEMINI_MODEL_IMAGE_VERSION
      || GeminiModelConfig.image.replace(/^gemini-/, '');
    expect(GeminiModelConfig.imageVersion).toBe(expectedVersion);
  });
});
