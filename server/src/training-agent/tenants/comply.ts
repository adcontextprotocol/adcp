/**
 * Per-tenant `comply_test_controller` adapter sets.
 *
 * Each tenant exposes only the comply scenarios applicable to its surface
 * (sales tenant: media-buy / delivery / product seeds; creative tenant:
 * creative-status / creative-format seeds; etc.). The framework auto-
 * derives `capabilities.compliance_testing.scenarios` from the supplied
 * adapters (per `c08b1052`).
 *
 * Implementation: shim through to the v5 `handleComplyTestController` —
 * same approach as the rest of the v6 spike. The v5 handler reads
 * `scenario` + `params` from its `ToolArgs` and dispatches to per-scenario
 * code (with session-keyed state via `account` + `brand` in args). For
 * each v6 adapter we synthesize the right `ToolArgs` and translate the
 * v5 response into the v6 typed result.
 */

import { z } from 'zod';
import {
  TestControllerError,
  type ComplyControllerConfig,
  type ComplyControllerContext,
} from '@adcp/sdk/testing';
import { TOOL_INPUT_SHAPE, type TaskRegistry } from '@adcp/sdk/server';
import { handleComplyTestController } from '../comply-test-controller.js';
import type { ToolArgs, TrainingContext } from '../types.js';

const TRAINING_PRINCIPAL_FIELD = '__training_principal';

/**
 * v5 handler return shape — wide union of seed/force/simulate response
 * envelopes. We narrow per-call site based on the scenario being shimmed.
 */
interface V5Response {
  success: boolean;
  error?: string;
  error_detail?: string;
  current_state?: string;
  // ...other fields are scenario-specific
  [key: string]: unknown;
}

const CONTROLLER_ERROR_CODES = [
  'NOT_FOUND',
  'INVALID_PARAMS',
  'INVALID_TRANSITION',
  'INVALID_STATE',
  'FORBIDDEN',
  'UNKNOWN_SCENARIO',
  'JCS_NON_FINITE_NUMBER',
  'INTERNAL_ERROR',
] as const;

type ControllerErrorCode = typeof CONTROLLER_ERROR_CODES[number];

function normalizeControllerErrorCode(code: unknown): ControllerErrorCode {
  if (typeof code === 'string' && (CONTROLLER_ERROR_CODES as readonly string[]).includes(code)) {
    return code as ControllerErrorCode;
  }
  return 'INTERNAL_ERROR';
}

/**
 * Generic v5 → v6 comply-adapter shim. Builds the `ToolArgs` for the v5
 * handler, dispatches, throws `TestControllerError` on `success: false`.
 */
async function dispatchV5(
  scenario: string,
  params: Record<string, unknown>,
  input: Record<string, unknown>,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): Promise<V5Response> {
  // v5 handler reads brand/account from the wire-shaped args to derive
  // the session key. `ctx.input` is the full raw input (including
  // brand/account/sandbox/etc.), so spread it and stamp scenario+params.
  const principal = typeof input[TRAINING_PRINCIPAL_FIELD] === 'string'
    ? input[TRAINING_PRINCIPAL_FIELD]
    : 'anonymous';
  const cleanInput = { ...input };
  delete cleanInput[TRAINING_PRINCIPAL_FIELD];
  // The frozen 3.0 facade is itself a sandbox-only surface, but its released
  // AccountRef allowed opaque `{ account_id }` values without the later
  // explicit `sandbox: true` assertion. Restore that trusted adapter context
  // before entering the current fail-closed controller handler. Current
  // callers still have to provide the assertion on the wire.
  if (storyboardCompat?.version === '3.0') {
    const compatAccount = cleanInput.account;
    cleanInput.account = compatAccount && typeof compatAccount === 'object' && !Array.isArray(compatAccount)
      ? { ...compatAccount, sandbox: true }
      : { sandbox: true };
  }
  const args = { ...cleanInput, scenario, params } as ToolArgs;
  return await handleComplyTestController(args, {
    mode: 'open',
    principal,
    ...(storyboardCompat && { storyboardCompat }),
  } satisfies TrainingContext) as V5Response;
}

function throwOnFailure(result: V5Response): void {
  if (result.success) return;
  const code = normalizeControllerErrorCode(result.error);
  const message = result.error_detail ?? `Comply controller returned ${code}`;
  throw new TestControllerError(
    code as ConstructorParameters<typeof TestControllerError>[0],
    message,
    typeof result.current_state === 'string' ? result.current_state : undefined,
  );
}

// Generic adapter shim — the SDK's typed `SeedAdapter<P>`/`ForceAdapter<P>`/
// `SimulateAdapter<P>` constrain `P` to per-scenario param interfaces, but
// our shim handles all scenarios uniformly. The casts at the assignment
// site narrow back to the typed adapter shape.
type AdapterShim = (params: unknown, ctx: ComplyControllerContext) => Promise<unknown>;

function seedAdapter(scenario: string, storyboardCompat?: TrainingContext['storyboardCompat']): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input, storyboardCompat);
    throwOnFailure(result);
    // Seed adapters return void — framework builds SeedSuccess envelope
    // from its own idempotency cache.
  };
}

function forceAdapter(
  scenario: string,
  storyboardCompat?: TrainingContext['storyboardCompat'],
  afterSuccess?: (params: Record<string, unknown>) => Promise<void>,
): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input, storyboardCompat);
    throwOnFailure(result);
    await afterSuccess?.(params as Record<string, unknown>);
    return result;
  };
}

function simulateAdapter(scenario: string, storyboardCompat?: TrainingContext['storyboardCompat']): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input, storyboardCompat);
    throwOnFailure(result);
    return result;
  };
}

/**
 * Sales tenant comply config. Exposes the scenarios storyboards in the
 * sales track exercise: force_media_buy_status, simulate.delivery /
 * .budget_spend, seed.product / .pricing_option / .media_buy / .creative.
 */
/**
 * Extend the SDK's currently narrower `TOOL_INPUT_SHAPE` with the published
 * request schema's required top-level sandbox account assertion. Storyboards
 * send `account: { brand: { domain }, sandbox: true }`; the v5 handler also
 * reads `account.brand.domain` for session keying. F10's `inputSchema`
 * extension point preserves those canonical fields through v6 dispatch.
 */
const SALES_COMPLY_INPUT_SCHEMA = {
  ...TOOL_INPUT_SHAPE,
  account: z.object({
    account_id: z.string().optional(),
    brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
    sandbox: z.literal(true),
  }).passthrough(),
  brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
  [TRAINING_PRINCIPAL_FIELD]: z.string().optional(),
};

/**
 * Governance tenant comply config. Storyboards in the governance track
 * test how governance interacts with sales-side state (e.g., a registered
 * plan denying a media buy with a seeded product/pricing). They seed
 * sales entities AT the governance tenant rather than dispatching across
 * tenants. We accept the sales seeds here so a single-URL storyboard run
 * can set up state and then exercise governance flows.
 *
 * In a production multi-agent deployment these seeds would target the
 * sales agent directly; the storyboard runner doesn't yet route per-tool
 * across tenants (separate finding).
 */
export function buildGovernanceComplyConfig(): ComplyControllerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = (a: AdapterShim) => a as any;
  return {
    inputSchema: SALES_COMPLY_INPUT_SCHEMA,
    seed: {
      plan: cast(seedAdapter('seed_plan')),
      product: cast(seedAdapter('seed_product')),
      pricing_option: cast(seedAdapter('seed_pricing_option')),
      media_buy: cast(seedAdapter('seed_media_buy')),
    },
    force: {
      account_status: cast(forceAdapter('force_account_status')),
      session_status: cast(forceAdapter('force_session_status')),
      media_buy_status: cast(forceAdapter('force_media_buy_status')),
    },
    simulate: {
      budget_spend: cast(simulateAdapter('simulate_budget_spend')),
      delivery: cast(simulateAdapter('simulate_delivery')),
    },
  };
}

/**
 * Creative tenant comply config. Scenarios applicable to a creative
 * ad-server, plus sales seeds for storyboards that set up a sales
 * context before exercising creative flows (creative_generative/seller).
 */
export function buildCreativeComplyConfig(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): ComplyControllerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = (a: AdapterShim) => a as any;
  return {
    inputSchema: SALES_COMPLY_INPUT_SCHEMA,
    seed: {
      creative: cast(seedAdapter('seed_creative', storyboardCompat)),
      // F14 (`bd0d4028`) added the `creative_format` slot — needed for
      // `pagination_integrity_creative_formats` storyboard which seeds
      // multiple format fixtures and walks list_creative_formats pagination.
      creative_format: cast(seedAdapter('seed_creative_format', storyboardCompat)),
      product: cast(seedAdapter('seed_product', storyboardCompat)),
      pricing_option: cast(seedAdapter('seed_pricing_option', storyboardCompat)),
      media_buy: cast(seedAdapter('seed_media_buy', storyboardCompat)),
    },
    force: {
      creative_status: cast(forceAdapter('force_creative_status', storyboardCompat)),
      media_buy_status: cast(forceAdapter('force_media_buy_status', storyboardCompat)),
    },
  };
}

export function buildSalesComplyConfig(
  storyboardCompat?: TrainingContext['storyboardCompat'],
  taskRegistry?: TaskRegistry,
): ComplyControllerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = (a: AdapterShim) => a as any;
  return {
    inputSchema: SALES_COMPLY_INPUT_SCHEMA,
    seed: {
      product: cast(seedAdapter('seed_product', storyboardCompat)),
      pricing_option: cast(seedAdapter('seed_pricing_option', storyboardCompat)),
      media_buy: cast(seedAdapter('seed_media_buy', storyboardCompat)),
      creative: cast(seedAdapter('seed_creative', storyboardCompat)),
      // /sales advertises list_creative_formats (the SDK auto-registers it for
      // any tenant claiming a creative archetype) so the universal
      // pagination_integrity_creative_formats storyboard fires here too. The
      // seed adapter routes through the v5 handler's LOCAL_SCENARIOS path,
      // populating the process-global seeded format pool that
      // list_creative_formats reads.
      creative_format: cast(seedAdapter('seed_creative_format', storyboardCompat)),
    },
    force: {
      media_buy_status: cast(forceAdapter('force_media_buy_status', storyboardCompat)),
      create_media_buy_arm: cast(forceAdapter('force_create_media_buy_arm', storyboardCompat)),
      get_products_arm: cast(forceAdapter('force_get_products_arm', storyboardCompat)),
      task_completion: cast(forceAdapter(
        'force_task_completion',
        storyboardCompat,
        async params => {
          if (!taskRegistry) return;
          const taskId = params.task_id;
          const result = params.result;
          if (typeof taskId === 'string' && result && typeof result === 'object' && !Array.isArray(result)) {
            // The controller response is not returned until the buyer-visible
            // registry reflects completion, avoiding a race with the next
            // get_task_status storyboard step. The handoff worker performs
            // the same idempotent completion after its waiter resolves.
            await taskRegistry.complete(taskId, result);
          }
        },
      )),
      // force_creative_status drives dependency_impairment storyboards —
      // toggles creative.status and propagates to dependent media buys'
      // impairments[] via the v5 store's propagateCreativeImpairment.
      creative_status: cast(forceAdapter('force_creative_status', storyboardCompat)),
      // Audience sibling: suspends a synced audience and propagates the
      // resulting impairment to packages that target it.
      audience_status: cast(forceAdapter('force_audience_status', storyboardCompat)),
      upstream_unavailable: cast(forceAdapter('force_upstream_unavailable', storyboardCompat)),
    },
    simulate: {
      delivery: cast(simulateAdapter('simulate_delivery', storyboardCompat)),
      budget_spend: cast(simulateAdapter('simulate_budget_spend', storyboardCompat)),
    },
  };
}
