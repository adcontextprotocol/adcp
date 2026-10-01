import { describe, expect, it } from 'vitest';

import {
  disableAdaptiveThinking,
  forcedToolChoice,
  GeminiModelConfig,
  supportsForcedToolChoice,
} from '../../src/config/models.js';

describe('disableAdaptiveThinking', () => {
  it.each([
    'claude-sonnet-5',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
  ])('disables thinking only on supported model %s', (model) => {
    expect(disableAdaptiveThinking(model)).toEqual({ thinking: { type: 'disabled' } });
  });

  it('uses between_tools on Sonnet 5.5, which rejects disabled thinking', () => {
    expect(disableAdaptiveThinking('claude-sonnet-5-5')).toEqual({ thinking: { type: 'between_tools' } });
  });

  it.each([
    'claude-opus-5-5',
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

describe('forcedToolChoice', () => {
  it.each(['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5-20260601'])(
    'forces the tool on %s',
    (model) => {
      expect(supportsForcedToolChoice(model)).toBe(true);
      expect(forcedToolChoice(model, 'classify_brand')).toEqual({ tool_choice: { type: 'tool', name: 'classify_brand' } });
    },
  );

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-sonnet-5-5-20261001'])(
    'falls back to auto on %s, which rejects forced tool use',
    (model) => {
      expect(supportsForcedToolChoice(model)).toBe(false);
      expect(forcedToolChoice(model, 'classify_brand')).toEqual({ tool_choice: { type: 'auto' } });
    },
  );
});

describe('GeminiModelConfig', () => {
  it('keeps C2PA version provenance aligned with the selected image model', () => {
    const expectedVersion = process.env.GEMINI_MODEL_IMAGE_VERSION
      || GeminiModelConfig.image.replace(/^gemini-/, '');
    expect(GeminiModelConfig.imageVersion).toBe(expectedVersion);
  });
});
