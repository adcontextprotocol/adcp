import { describe, expect, it, vi } from 'vitest';
import {
  admitDirectToolExecution,
  captureAuthenticatedDirectToolBindingContract,
  captureAddieRequestThreadFacts,
  captureAuthorizedDirectToolUniverse,
  createSyntheticDirectToolReceiptHandlers,
  FIXED_TRACE_DIRECT_TOOL_UNIVERSE,
  type AuthorizedToolBinding,
} from '../../../src/addie/direct-tool-universe.js';
import { getSafeReadOnlyFallbackTools } from '../../../src/addie/tool-sets.js';

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

function bindings(requestFacts = facts()): AuthorizedToolBinding[] {
  return FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.map((tool) => {
    const binding = {
      definition: structuredClone(tool.definition),
      handler: vi.fn(async () => '{"must_not":"run"}'),
      handlerIdentity: `production-contract/${tool.definition.name}/v1`,
    };
    return {
      ...binding,
      contract: captureAuthenticatedDirectToolBindingContract(requestFacts, binding),
    };
  });
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

  it('derives the complete bounded read-only universe from authenticated request facts, not a route or fixture', () => {
    const requestFacts = facts();
    const universe = captureAuthorizedDirectToolUniverse(
      requestFacts,
      bindings(requestFacts),
    );

    expect(universe).toMatchObject({
      source: 'authenticated_request_definition_handler_intersection',
      policy: 'shared_deterministic_surface_policy',
      selectedToolSets: ['knowledge', 'community_research', 'schema_reference'],
      toolNames: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames,
    });
    expect(universe.toolNamesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(universe.definitionHandlerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(universe.requestThreadFactsSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed if any policy-required production binding is removed or an extra is supplied', () => {
    const requestFacts = facts();
    const complete = bindings(requestFacts);
    expect(() => captureAuthorizedDirectToolUniverse(
      requestFacts,
      complete.filter((binding) => binding.definition.name !== 'search_docs'),
    )).toThrow('incomplete, stale, or contain extras');
    expect(() => captureAuthorizedDirectToolUniverse(requestFacts, [
      ...complete,
      complete[0]!,
    ])).toThrow('Duplicate tool binding');
    const extraDefinition = { ...complete[0]!.definition, name: 'unexpected_extra' };
    const extra = {
      definition: extraDefinition,
      handler: vi.fn(async () => '{"must_not":"run"}'),
      handlerIdentity: 'production-contract/unexpected-extra/v1',
    };
    expect(() => captureAuthorizedDirectToolUniverse(requestFacts, [
      ...complete,
      ...[{
        ...extra,
        contract: captureAuthenticatedDirectToolBindingContract(requestFacts, extra),
      }],
    ])).toThrow();
    expect(() => captureAuthorizedDirectToolUniverse(requestFacts, [{
      ...complete[0]!, handler: undefined,
    } as unknown as AuthorizedToolBinding, ...complete.slice(1)])).toThrow('Tool handler is required');
  });

  it('honors authenticated private-member facts without filtering the required binding contract', () => {
    const privateFacts = facts({ isAAOAdmin: false });
    const privateMember = captureAuthorizedDirectToolUniverse(
      privateFacts,
      bindings(privateFacts),
    );

    expect(privateMember.toolNames).toEqual(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames);
  });

  it('rejects swapped, forged, stale, or mutated authenticated binding contracts', () => {
    const requestFacts = facts();
    const complete = bindings(requestFacts);
    const first = captureAuthorizedDirectToolUniverse(requestFacts, complete);
    const reorderedBindings = captureAuthorizedDirectToolUniverse(requestFacts, [...complete].reverse());

    expect(first.toolNames).toEqual(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames);
    expect(reorderedBindings.toolNames).toEqual(first.toolNames);
    expect(reorderedBindings.toolNamesSha256).toBe(first.toolNamesSha256);
    expect(reorderedBindings.definitionHandlerSha256).toBe(first.definitionHandlerSha256);
    const swapped = { ...complete[0]!, contract: { ...complete[1]!.contract } };
    expect(() => captureAuthorizedDirectToolUniverse(requestFacts, [swapped, ...complete.slice(1)]))
      .toThrow('stale, swapped, or mismatched');
    const forged = { ...complete[0]!, contract: { ...complete[0]!.contract, requestThreadFactsSha256: '0'.repeat(64) } };
    expect(() => captureAuthorizedDirectToolUniverse(requestFacts, [forged, ...complete.slice(1)]))
      .toThrow('stale, swapped, or mismatched');
    const mutated = { ...complete[0]!, definition: { ...complete[0]!.definition, description: 'mutated' } };
    expect(() => captureAuthorizedDirectToolUniverse(requestFacts, [mutated, ...complete.slice(1)]))
      .toThrow('stale, swapped, or mismatched');
  });

  it('uses synthetic receipt handlers and never invokes a production handler', async () => {
    const requestFacts = facts();
    const productionBindings = bindings(requestFacts);
    const universe = captureAuthorizedDirectToolUniverse(requestFacts, productionBindings);
    const handlers = createSyntheticDirectToolReceiptHandlers(universe);

    expect([...handlers.keys()]).toEqual(universe.toolNames);
    expect(universe.tools.map((tool) => tool.definition.name)).toEqual([...handlers.keys()]);
    const firstTool = universe.tools[0]!;
    const receipt = JSON.parse(await handlers.get(firstTool.definition.name)!({ query: 'untrusted model input' }));
    expect(receipt).toEqual({
      kind: 'synthetic_direct_tool_receipt',
      toolName: firstTool.definition.name,
      definitionSha256: firstTool.definitionSha256,
      handlerProvenance: 'evaluator_simulated_receipt',
      receiptHandlerIdentitySha256: expect.any(String),
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
