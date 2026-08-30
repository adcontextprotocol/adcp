import { describe, expect, it } from 'vitest';
import type { AddieTool } from '../../../src/addie/types.js';
import {
  buildAddieProviderTools,
  buildAddieWireTools,
  buildModelToolDefinitions,
  mergeAddieToolDefinitions,
} from '../../../src/addie/tool-wire-shape.js';
import {
  assembleAddieFallbackPrompt,
  assembleAddieSystemPrompt,
} from '../../../src/addie/prompt-assembly.js';

function tool(name: string, description = name): AddieTool {
  return {
    name,
    description,
    input_schema: { type: 'object', properties: {} },
  };
}

describe('Addie tool wire shape', () => {
  it('preserves global order while request definitions shadow by name', () => {
    const merged = mergeAddieToolDefinitions(
      [tool('alpha'), tool('beta', 'global beta')],
      [tool('beta', 'request beta'), tool('gamma')],
    );

    expect(merged.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(merged[1]?.description).toBe('request beta');
  });

  it('applies an explicit allowlist after merging', () => {
    expect(mergeAddieToolDefinitions(
      [tool('alpha'), tool('beta')],
      [tool('gamma')],
      ['gamma', 'alpha'],
    ).map((entry) => entry.name)).toEqual(['alpha', 'gamma']);
  });

  it('projects only provider fields and marks exactly the final tool cacheable', () => {
    expect(buildAddieWireTools([tool('alpha'), tool('beta')])).toEqual([
      {
        name: 'alpha',
        description: 'alpha',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'beta',
        description: 'beta',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('projects the same canonical tools to the provider-neutral model shape', () => {
    expect(buildModelToolDefinitions([tool('alpha'), tool('beta')])).toEqual([
      {
        name: 'alpha',
        description: 'alpha',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'beta',
        description: 'beta',
        inputSchema: { type: 'object', properties: {} },
        cacheHint: 'ephemeral',
      },
    ]);
  });

  it('projects provider-native web search through the shared request seam', () => {
    expect(buildAddieProviderTools(false)).toEqual([]);
    expect(buildAddieProviderTools(true)).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
    ]);
  });
});

describe('Addie prompt assembly', () => {
  it('preserves the production rules, tool reference, and response-style order', () => {
    expect(assembleAddieSystemPrompt('rules', 'tools', 'style')).toBe(
      'rules\n\n---\n\ntools\n\n---\n\nstyle',
    );
  });

  it('keeps the fallback prompt intentionally reduced', () => {
    expect(assembleAddieFallbackPrompt('fallback', 'tools')).toBe(
      'fallback\n\n---\n\ntools',
    );
  });
});
