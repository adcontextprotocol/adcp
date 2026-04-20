---
---

Training agent: swap local `comply_test_controller` dispatcher for the SDK's.

`server/src/training-agent/comply-test-controller.ts` now imports
`handleTestControllerRequest`, `CONTROLLER_SCENARIOS`, and `enforceMapCap`
from `@adcp/client` (all shipped in 5.x). The ~80-line scenario-routing
`SCENARIO_MAP` / `dispatch` / `listScenarios` block is gone, as is the
bespoke `enforceComplyCap` / `MAX_COMPLY_ENTRIES_PER_MAP` quota guard and
the hardcoded scenario enum in `COMPLY_TEST_CONTROLLER_TOOL.inputSchema`.

Behavior change: status strings are now validated via the SDK's
`AccountStatusSchema` / `CreativeStatusSchema` / `MediaBuyStatusSchema`
before reaching the store — invalid values now surface `INVALID_PARAMS`
uniformly instead of slipping into the transition table as unknown keys.

The training-agent-specific wrapper stays: sandbox gate on
`account.sandbox`, session binding via `sessionKeyFromArgs`, domain
state-machine transitions live in the store factory. This is the custom
MCP-wrapper pattern documented on `TOOL_INPUT_SHAPE` — store is our
concern, dispatch is the SDK's.

Closes #2347 (in-repo asks). All 7 SDK asks from the issue shipped in
`@adcp/client` 5.x (handleTestControllerRequest, toMcpResponse,
TOOL_INPUT_SHAPE, CONTROLLER_SCENARIOS, enforceMapCap, SESSION_ENTRY_CAP,
factory-form stores).
