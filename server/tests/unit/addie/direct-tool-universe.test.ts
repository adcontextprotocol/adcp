import { describe, expect, it, vi } from 'vitest';
import {
  admitDirectToolExecution,
  captureAddieRequestThreadFacts,
  captureAuthorizedDirectToolUniverse,
  createSyntheticDirectToolReceiptHandlers,
  FIXED_TRACE_DIRECT_TOOL_UNIVERSE,
  type AuthorizedToolBinding,
} from '../../../src/addie/direct-tool-universe.js';
import { getSafeReadOnlyFallbackTools } from '../../../src/addie/tool-sets.js';
import type { AddieTool } from '../../../src/addie/types.js';

function definition(name: string): AddieTool {
  return {
    name,
    description: `Synthetic ${name} definition.`,
    input_schema: { type: 'object', properties: {} },
  };
}

function facts(overrides: Partial<Parameters<typeof captureAddieRequestThreadFacts>[0]> = {}) {
  return captureAddieRequestThreadFacts({
    surface: 'dm',
    authenticatedPrincipalId: 'synthetic-principal-1',
    accountAccess: 'member',
    isAAOAdmin: false,
    threadId: 'synthetic-thread-1',
    isThread: true,
    channelPrivacy: 'private',
    confirmation: 'not_required',
    confirmedMutationToolNames: [],
    confirmedMutationIdempotencyKeys: [],
    idempotencyScope: 'synthetic-request-1',
    completedToolCallKeys: [],
    replayClassification: 'initial',
    ...overrides,
  });
}

function bindings(...names: string[]): AuthorizedToolBinding[] {
  return names.map((name) => ({
    definition: definition(name),
    handler: vi.fn(async () => '{"must_not":"run"}'),
    handlerIdentity: `production-contract/${name}/v1`,
  }));
}

describe('direct tool-universe capture', () => {
  it('keeps the fixed evaluator universe complete for the shared fallback, without provider-managed tools', () => {
    const expectedCustomNames = getSafeReadOnlyFallbackTools().filter((name) => name !== 'web_search');

    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames).toEqual(expectedCustomNames);
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.map((tool) => tool.definition.name))
      .toEqual(expectedCustomNames);
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames).not.toContain('web_search');
    expect(new Set(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames).size)
      .toBe(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames.length);
  });

  it('derives the bounded read-only universe from authenticated request facts, not a route or fixture', () => {
    const universe = captureAuthorizedDirectToolUniverse(
      facts(),
      bindings('create_payment_link', 'search_docs', 'add_prospect'),
    );

    expect(universe).toMatchObject({
      source: 'authenticated_request_definition_handler_intersection',
      policy: 'shared_deterministic_surface_policy',
      selectedToolSets: ['knowledge', 'community_research', 'schema_reference'],
      toolNames: ['search_docs'],
    });
    expect(universe.toolNamesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(universe.definitionHandlerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(universe.requestThreadFactsSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors public-channel and admin authorization through the shared surface policy', () => {
    const publicMention = captureAuthorizedDirectToolUniverse(
      facts({ surface: 'mention', channelPrivacy: 'public', isAAOAdmin: true }),
      bindings('search_docs', 'resolve_escalation', 'add_prospect'),
    );
    const privateMember = captureAuthorizedDirectToolUniverse(
      facts({ isAAOAdmin: false }),
      bindings('search_docs', 'add_prospect'),
    );

    expect(publicMention.toolNames).toEqual(['search_docs']);
    expect(privateMember.toolNames).toEqual(['search_docs']);
  });

  it('requires an exact definition/handler binding and preserves deterministic policy order and hashes', () => {
    const complete = bindings('get_schema', 'search_docs', 'list_schemas');
    const first = captureAuthorizedDirectToolUniverse(facts(), complete);
    const reorderedBindings = captureAuthorizedDirectToolUniverse(facts(), [...complete].reverse());

    expect(first.toolNames).toEqual(['search_docs', 'get_schema', 'list_schemas']);
    expect(reorderedBindings.toolNames).toEqual(first.toolNames);
    expect(reorderedBindings.toolNamesSha256).toBe(first.toolNamesSha256);
    expect(reorderedBindings.definitionHandlerSha256).toBe(first.definitionHandlerSha256);
    expect(() => captureAuthorizedDirectToolUniverse(facts(), [complete[0]!, complete[0]!]))
      .toThrow('Duplicate tool binding');
    expect(() => captureAuthorizedDirectToolUniverse(facts(), [{
      ...complete[0]!, handlerIdentity: '',
    }])).toThrow('Tool handler identity is required');
  });

  it('uses synthetic receipt handlers and never invokes a production handler', async () => {
    const productionBindings = bindings('search_docs');
    const universe = captureAuthorizedDirectToolUniverse(facts(), productionBindings);
    const handlers = createSyntheticDirectToolReceiptHandlers(universe);

    expect([...handlers.keys()]).toEqual(universe.toolNames);
    expect(universe.tools.map((tool) => tool.definition.name)).toEqual([...handlers.keys()]);
    const receipt = JSON.parse(await handlers.get('search_docs')!({ query: 'untrusted model input' }));
    expect(receipt).toEqual({
      kind: 'synthetic_direct_tool_receipt',
      toolName: 'search_docs',
      definitionSha256: universe.tools[0]!.definitionSha256,
      handlerIdentitySha256: universe.tools[0]!.handlerIdentitySha256,
      definitionHandlerSha256: universe.definitionHandlerSha256,
    });
    expect(productionBindings[0]!.handler).not.toHaveBeenCalled();
  });

  it('freezes request/thread facts and gates mutations at confirmation, idempotency, and replay boundaries', () => {
    const pending = facts({ confirmation: 'pending' });
    const complete = facts({
      confirmation: 'confirmed',
      confirmedMutationToolNames: ['create_synthetic_record'],
      confirmedMutationIdempotencyKeys: ['synthetic-call-1'],
      completedToolCallKeys: ['synthetic-call-1'],
    });
    const replay = facts({
      confirmation: 'confirmed',
      confirmedMutationToolNames: ['create_synthetic_record'],
      confirmedMutationIdempotencyKeys: ['synthetic-call-2'],
      replayClassification: 'replay',
    });

    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.completedToolCallKeys)).toBe(true);
    expect(admitDirectToolExecution(pending, {
      toolName: 'create_synthetic_record', isMutation: true, idempotencyKey: 'synthetic-call-1',
    }))
      .toEqual({ allowed: false, reason: 'mutation_confirmation_required' });
    expect(admitDirectToolExecution(complete, {
      toolName: 'other_mutation', isMutation: true, idempotencyKey: 'synthetic-call-2',
    }))
      .toEqual({ allowed: false, reason: 'mutation_not_confirmed_for_tool' });
    expect(admitDirectToolExecution(complete, {
      toolName: 'create_synthetic_record', isMutation: true, idempotencyKey: 'synthetic-call-1',
    }))
      .toEqual({ allowed: false, reason: 'duplicate_idempotency_key' });
    expect(admitDirectToolExecution(replay, {
      toolName: 'create_synthetic_record', isMutation: true, idempotencyKey: 'synthetic-call-2',
    }))
      .toEqual({ allowed: false, reason: 'replay_mutation_blocked' });
    expect(admitDirectToolExecution(pending, {
      toolName: 'search_docs', isMutation: false, idempotencyKey: 'synthetic-read-1',
    }))
      .toEqual({ allowed: true });
  });
});
