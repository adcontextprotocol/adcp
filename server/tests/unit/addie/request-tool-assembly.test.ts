import { describe, expect, it, vi } from 'vitest';
import type { ToolHandler } from '../../../src/addie/model-providers/tool-orchestration.js';
import * as requestToolAssembly from '../../../src/addie/request-tool-assembly.js';
import type { AddieRequestTools } from '../../../src/addie/request-tool-assembly.js';
import { mergeAddieToolDefinitions } from '../../../src/addie/tool-wire-shape.js';
import type { AddieTool } from '../../../src/addie/types.js';

function tool(name: string, description = name): AddieTool {
  return {
    name,
    description,
    input_schema: { type: 'object', properties: {} },
  };
}

function handler(): ToolHandler {
  return vi.fn(async () => 'unused');
}

function assemble(
  globalTools: AddieTool[] = [],
  globalHandlers = new Map<string, ToolHandler>(),
  requestTools?: AddieRequestTools,
  allowedToolNames?: readonly string[],
) {
  const actual = requestToolAssembly.assembleAddieRequestTools(
    globalTools,
    globalHandlers,
    requestTools,
    allowedToolNames,
  );
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  const beforeExtraction = {
    tools: mergeAddieToolDefinitions(globalTools, requestTools?.tools, allowedToolNames),
    handlers: new Map(
      [...globalHandlers, ...(requestTools?.handlers || [])]
        .filter(([name]) => !allowed || allowed.has(name)),
    ),
  };
  expect(actual).toEqual(beforeExtraction);
  return actual;
}

describe('request-local custom-tool assembly', () => {
  it('keeps global-only data unchanged when no request tools are supplied', () => {
    const alpha = handler();
    const beta = handler();

    const result = assemble(
      [tool('alpha'), tool('beta')],
      new Map([['alpha', alpha], ['beta', beta]]),
    );

    expect(result.tools.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect([...result.handlers.entries()]).toEqual([['alpha', alpha], ['beta', beta]]);
  });

  it('uses request-local-only data when no global tools are registered', () => {
    const local = handler();

    const result = assemble([], new Map(), {
      tools: [tool('local')],
      handlers: new Map([['local', local]]),
    });

    expect(result.tools.map((entry) => entry.name)).toEqual(['local']);
    expect([...result.handlers.entries()]).toEqual([['local', local]]);
  });

  it('keeps global definition position while request-local definitions and handlers win by name', () => {
    const globalBeta = handler();
    const localBeta = handler();

    const result = assemble(
      [tool('alpha'), tool('beta', 'global beta')],
      new Map([['beta', globalBeta]]),
      {
        tools: [tool('beta', 'request beta'), tool('gamma')],
        handlers: new Map([['beta', localBeta]]),
      },
    );

    expect(result.tools.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.tools[1]?.description).toBe('request beta');
    expect(result.handlers.get('beta')).toBe(localBeta);
  });

  it('filters definitions and handlers by allowed name without changing definition order', () => {
    const alpha = handler();
    const beta = handler();
    const gamma = handler();

    const result = assemble(
      [tool('alpha'), tool('beta')],
      new Map([['alpha', alpha], ['beta', beta]]),
      { tools: [tool('gamma')], handlers: new Map([['gamma', gamma]]) },
      ['gamma', 'alpha'],
    );

    expect(result.tools.map((entry) => entry.name)).toEqual(['alpha', 'gamma']);
    expect([...result.handlers.keys()]).toEqual(['alpha', 'gamma']);
  });

  it('retains a definition with no handler and leaves unknown data non-executable', () => {
    const orphanHandler = handler();
    const result = assemble(
      [tool('declared_without_handler')],
      new Map([['unknown_handler', orphanHandler]]),
      {
        tools: [tool('unknown_definition')],
        handlers: new Map(),
      },
    );

    expect(result.tools.map((entry) => entry.name)).toEqual([
      'declared_without_handler',
      'unknown_definition',
    ]);
    expect(result.handlers.has('declared_without_handler')).toBe(false);
    expect(result.handlers.get('unknown_handler')).toBe(orphanHandler);
  });

  it('preserves duplicate last-winner values for the existing execution intersection', () => {
    const first = handler();
    const second = handler();
    const result = assemble(
      [tool('duplicate', 'first'), tool('duplicate', 'second')],
      new Map([['duplicate', first]]),
      {
        tools: [tool('duplicate', 'request first'), tool('duplicate', 'request second')],
        handlers: new Map([['duplicate', second]]),
      },
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.description).toBe('request second');
    expect(result.handlers.get('duplicate')).toBe(second);
  });

  it('keeps the official-docs two-tool input isolated and ordered', () => {
    const search = handler();
    const get = handler();
    const result = assemble(
      [tool('search_docs'), tool('get_doc'), tool('other')],
      new Map([['search_docs', search], ['get_doc', get]]),
      undefined,
      ['search_docs', 'get_doc'],
    );

    expect(result.tools.map((entry) => entry.name)).toEqual(['search_docs', 'get_doc']);
    expect([...result.handlers.keys()]).toEqual(['search_docs', 'get_doc']);
  });

  it('exports only neutral assembly data and performs no handler dispatch', () => {
    const local = handler();
    const result = assemble([], new Map(), {
      tools: [tool('local')],
      handlers: new Map([['local', local]]),
    });

    expect(Object.keys(requestToolAssembly))
      .toEqual(['assembleAddieRequestTools']);
    expect(result.handlers.get('local')).toBe(local);
    expect(local).not.toHaveBeenCalled();
  });
});
