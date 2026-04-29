import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

// Storyboard sample_requests declare `idempotency_key: "$generate:uuid_v4#<alias>"`
// per the convention in static/compliance/source/universal/idempotency.yaml.
// The runtime runner substitutes a stable UUID per alias per run; this test
// walks the YAML directly, so it performs the same substitution here — a
// fresh UUID per alias per test invocation. Aliases are test-local; we don't
// need the cached cross-step reuse the runner implements.
function resolveIdempotencyPlaceholder(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('$generate:uuid_v4#')) return value;
  return `test-${randomUUID()}`;
}

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key === undefined) {
    return { ...args, idempotency_key: `test-${randomUUID()}` };
  }
  const resolved = resolveIdempotencyPlaceholder(args.idempotency_key);
  if (resolved === args.idempotency_key) return args;
  return { ...args, idempotency_key: resolved };
}

const REPO_ROOT = join(process.cwd());
const STORYBOARD_PATH = join(
  REPO_ROOT,
  'static/compliance/source/specialisms/collection-lists/index.yaml',
);
const SCHEMA_BASE_DIR = join(REPO_ROOT, 'static/schemas/source');

interface Step {
  id: string;
  task: string;
  response_schema_ref?: string;
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
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  const result = (parsed.adcp_error as Record<string, unknown> | undefined) ?? parsed;
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

async function loadExternalSchema(uri: string): Promise<object> {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot load external schema: ${uri}`);
  }
  const schemaPath = join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}

async function validateAgainstSchema(
  data: unknown,
  schemaRef: string,
): Promise<{ valid: boolean; errors: string }> {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: loadExternalSchema,
  });
  addFormats(ajv);
  const schema = await loadExternalSchema('/schemas/' + schemaRef);
  const validate = await ajv.compileAsync(schema);
  const ok = validate(data);
  if (ok) return { valid: true, errors: '' };
  const errs = (validate.errors ?? [])
    .map(e => `${e.instancePath || '(root)'}: ${e.message}`)
    .join('; ');
  return { valid: false, errors: errs };
}

// Two tests live here:
//   1. An end-to-end walk of the storyboard's phases against in-process
//      handlers. Each step's response is validated against its declared
//      response_schema (via ajv) plus field_present/field_value/correlation_id
//      echo assertions from the storyboard YAML.
//   2. A tools/list invariant asserting every CRUD tool declares `account` in
//      its inputSchema — MCP clients strip undeclared keys, collapsing the
//      session key. The storyboard walk in (1) passes `account` into handlers
//      directly so it does NOT catch that regression; this second test does.
describe('collection-lists specialism storyboard', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;
  const ctx: TrainingContext = { mode: 'open' };

  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
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
          if (v.check === 'response_schema' && step.response_schema_ref) {
            const { valid, errors } = await validateAgainstSchema(result, step.response_schema_ref);
            expect(valid, `step ${step.id}: ${step.response_schema_ref} validation failed: ${errors}`).toBe(true);
          } else if (v.check === 'field_present' && v.path) {
            expect(
              getByPath(result, v.path),
              `step ${step.id}: ${v.description}`,
            ).toBeDefined();
          } else if (v.check === 'field_value' && v.path) {
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

  it('tool inputSchemas declare account so MCP clients do not strip it', async () => {
    const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
    const handler = requestHandlers.get('tools/list');
    if (!handler) throw new Error('ListTools handler not found');
    const { tools } = await handler({ method: 'tools/list' }, {});

    const collectionTools = (tools as {
      name: string;
      inputSchema: { properties?: Record<string, any> };
    }[]).filter(t => /^(create|get|list|update|delete)_collection_list/.test(t.name));
    expect(collectionTools.length).toBe(5);

    for (const tool of collectionTools) {
      expect(
        tool.inputSchema.properties,
        `${tool.name} has no inputSchema.properties`,
      ).toBeDefined();
      const account = tool.inputSchema.properties?.account;
      expect(
        account,
        `${tool.name} inputSchema does not declare 'account' — @adcp/sdk will strip it, collapsing session key to open:default`,
      ).toBeDefined();
      expect(
        account?.oneOf,
        `${tool.name} declares 'account' but not the oneOf shape (account_id | {brand, operator}) — agents need the shape hint`,
      ).toBeDefined();
    }
  });
});
