/**
 * Tool definition for `comply_test_controller`.
 *
 * This module imports nothing, so `task-handlers.ts` can read the definition
 * into its tool list while the comply-test-controller import cycle is still
 * evaluating.
 */

// JSON Schema equivalent of the SDK's `TOOL_INPUT_SHAPE`, extended with
// top-level `account` (sandbox gate) and `brand` (session keying) — both
// exempt extensions per the SDK's documented wrapper pattern.
export const COMPLY_TEST_CONTROLLER_TOOL = {
  name: 'comply_test_controller',
  description: 'Forces seller-side state transitions that a buyer agent cannot trigger directly — creative review outcomes, account status changes, delivery data, budget consumption. Sandbox only (requires account.sandbox: true). NOT for normal buyer operations. Call with scenario: "list_scenarios" first to see available scenarios and required params.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  execution: { taskSupport: 'forbidden' as const },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scenario: {
        type: 'string',
        description: 'The seller-side transition to trigger. Call list_scenarios to discover supported values.',
      },
      params: {
        type: 'object',
        description: 'Scenario-specific parameters. Call list_scenarios to see required and optional params per scenario. Omit for list_scenarios.',
      },
      account: {
        type: 'object',
        properties: {
          sandbox: { type: 'boolean', const: true },
        },
        required: ['sandbox'],
        additionalProperties: true,
      },
      brand: { type: 'object' },
    },
    required: ['scenario', 'account'],
  },
};
