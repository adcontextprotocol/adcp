import { describe, expect, it, vi } from 'vitest';
import {
  createSyntheticDirectToolReceiptHandlers,
  FIXED_TRACE_DIRECT_TOOL_UNIVERSE,
  type CapturedDirectToolUniverse,
} from '../../../src/addie/direct-tool-universe.js';
import { getSafeReadOnlyFallbackTools } from '../../../src/addie/tool-sets.js';

describe('direct tool-universe evaluator descriptors', () => {
  it('exposes the complete 13-definition fallback only as evaluator-simulated receipts', () => {
    const expectedCustomNames = getSafeReadOnlyFallbackTools().filter((name) => name !== 'web_search');

    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE).toMatchObject({
      source: 'evaluator_owned_production_definitions_simulated_receipts',
      requestThreadFactsProvenance: 'unavailable_in_evaluator',
      authenticatedBindingContract: 'unavailable_in_evaluator',
      toolNames: expectedCustomNames,
    });
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools).toHaveLength(13);
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.every((tool) => (
      tool.handlerProvenance === 'evaluator_simulated_receipt'
    ))).toBe(true);
  });

  it('cannot relabel an arbitrary matching 13-entry mock contract as authenticated', async () => {
    class ProductionBindingContract {}
    const mockHandler = vi.fn(async () => '{"must_not":"run"}');
    const copiedAndBrandedLooking = Object.assign(
      Object.create(ProductionBindingContract.prototype),
      {
        ...FIXED_TRACE_DIRECT_TOOL_UNIVERSE,
        // These are deliberately matching-looking, caller-controlled claims.
        source: 'authenticated_request_definition_handler_intersection',
        requestThreadFactsSha256: 'a'.repeat(64),
        authenticatedBindingContractSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
        tools: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.map((tool) => ({
          ...tool,
          handler: mockHandler,
          handlerProvenance: 'authenticated_production_binding',
        })),
      },
    ) as unknown as CapturedDirectToolUniverse;

    // The only public handler constructor always makes evaluator receipts;
    // prototype/constructor spoofing and matching digests are non-authority.
    const handlers = createSyntheticDirectToolReceiptHandlers(copiedAndBrandedLooking);
    expect(handlers.map((handler) => handler.definition.name)).toEqual(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames);
    const first = FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools[0]!;
    const firstHandler = handlers.find((handler) => handler.definition.name === first.definition.name);
    expect(firstHandler).toBeDefined();
    expect(JSON.parse(await firstHandler!.handler({ query: 'mock' }))).toMatchObject({
      kind: 'synthetic_direct_tool_receipt',
      handlerProvenance: 'evaluator_simulated_receipt',
      toolName: first.definition.name,
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });
});
