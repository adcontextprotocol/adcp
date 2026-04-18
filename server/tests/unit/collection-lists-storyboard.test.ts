import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const STORYBOARD_PATH = join(
  process.cwd(),
  'static/compliance/source/specialisms/collection-lists/index.yaml',
);

interface Step {
  id: string;
  task: string;
  sample_request?: Record<string, unknown>;
  context_outputs?: { path: string; key: string }[];
  validations: Validation[];
}

interface Validation {
  check: 'field_present' | 'field_value' | 'response_schema';
  path?: string;
  value?: unknown;
  description: string;
}

interface Phase {
  id: string;
  steps: Step[];
}

async function simulateCallTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : {};
  const result = parsed.adcp_error ?? parsed;
  return { result, isError: response.isError };
}

function resolveContextRefs(
  value: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof value === 'string' && value.startsWith('$context.')) {
    return context[value.slice('$context.'.length)];
  }
  if (Array.isArray(value)) return value.map(v => resolveContextRefs(v, context));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveContextRefs(v, context);
    return out;
  }
  return value;
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Two tests live here:
//   1. An end-to-end walk of the storyboard's phases against in-process handlers.
//      This passes `brand` into handlers directly, so it does NOT catch the
//      "inputSchema missing brand" regression.
//   2. A tools/list invariant that asserts every CRUD tool declares `brand` in
//      its inputSchema — MCP clients strip undeclared keys, collapsing the
//      session key and breaking multi-step flows. The smoke test against live
//      agents catches that, but this unit test catches it faster.
describe('collection-lists specialism storyboard', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;
  const ctx: TrainingContext = { mode: 'open' };

  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(ctx);
  });

  it('runs the full CRUD lifecycle end-to-end', async () => {
    const storyboard = YAML.parse(readFileSync(STORYBOARD_PATH, 'utf8'));
    expect(storyboard.id).toBe('collection_lists');
    expect(storyboard.phases).toBeDefined();

    const context: Record<string, unknown> = {};

    for (const phase of storyboard.phases as Phase[]) {
      for (const step of phase.steps) {
        const args = resolveContextRefs(step.sample_request ?? {}, context) as Record<
          string,
          unknown
        >;
        const { result, isError } = await simulateCallTool(server, step.task, args);

        expect(
          isError,
          `step ${step.id} (${step.task}) returned isError: ${JSON.stringify(result)}`,
        ).toBeFalsy();
        expect(
          (result as any).errors,
          `step ${step.id} (${step.task}) returned errors: ${JSON.stringify((result as any).errors)}`,
        ).toBeUndefined();

        for (const v of step.validations) {
          if (v.check === 'field_present' && v.path && !v.path.startsWith('context')) {
            expect(
              getByPath(result, v.path),
              `step ${step.id}: ${v.description}`,
            ).toBeDefined();
          }
          if (v.check === 'field_value' && v.path && !v.path.startsWith('context')) {
            expect(getByPath(result, v.path), `step ${step.id}: ${v.description}`).toEqual(
              v.value,
            );
          }
        }

        for (const out of step.context_outputs ?? []) {
          context[out.key] = getByPath(result, out.path);
        }
      }
    }

    expect(context.collection_list_id).toBeTruthy();
  });

  it('tool inputSchemas declare brand so MCP clients do not strip it', async () => {
    const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
    const handler = requestHandlers.get('tools/list');
    if (!handler) throw new Error('ListTools handler not found');
    const { tools } = await handler({ method: 'tools/list' }, {});

    const collectionTools = (tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[]).filter(
      t => /^(create|get|list|update|delete)_collection_list/.test(t.name),
    );
    expect(collectionTools.length).toBe(5);

    for (const tool of collectionTools) {
      expect(
        tool.inputSchema.properties,
        `${tool.name} has no inputSchema.properties`,
      ).toBeDefined();
      expect(
        tool.inputSchema.properties?.brand,
        `${tool.name} inputSchema does not declare 'brand' — @adcp/client will strip it, collapsing session key to open:default`,
      ).toBeDefined();
    }
  });
});
