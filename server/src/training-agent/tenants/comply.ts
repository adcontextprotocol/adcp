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
import { TOOL_INPUT_SHAPE } from '@adcp/sdk/server';
import { handleComplyTestController } from '../comply-test-controller.js';
import type { ToolArgs, TrainingContext } from '../types.js';

// Hardcoded principal — `ComplyControllerContext` doesn't carry authInfo,
// so the comply adapter has no per-call principal to forward. Effect: comply
// state set by one caller is visible to another caller using the same
// brand.domain. This is acceptable for the training agent (the entire surface
// is shared sandbox fixtures by design — different orgs intentionally see the
// same mock data while running storyboards) but is NOT a pattern production
// agents should copy. SDK feedback filed: surface authInfo on
// ComplyControllerContext so adopters that want partition-by-caller have the
// hook to do it.
const trainingCtx: TrainingContext = { mode: 'open', principal: 'static:public' };

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

/**
 * Generic v5 → v6 comply-adapter shim. Builds the `ToolArgs` for the v5
 * handler, dispatches, throws `TestControllerError` on `success: false`.
 */
async function dispatchV5(scenario: string, params: Record<string, unknown>, input: Record<string, unknown>): Promise<V5Response> {
  // v5 handler reads brand/account from the wire-shaped args to derive
  // the session key. `ctx.input` is the full raw input (including
  // brand/account/sandbox/etc.), so spread it and stamp scenario+params.
  const args = { ...input, scenario, params } as ToolArgs;
  return await handleComplyTestController(args, trainingCtx) as V5Response;
}

function throwOnFailure(result: V5Response): void {
  if (result.success) return;
  const code = result.error ?? 'INVALID_REQUEST';
  const message = result.error_detail ?? `Comply controller returned ${code}`;
  throw new TestControllerError(
    code as 'NOT_FOUND' | 'INVALID_PARAMS' | 'INVALID_TRANSITION' | 'FORBIDDEN' | 'UNKNOWN_SCENARIO' | 'INTERNAL_ERROR',
    message,
    typeof result.current_state === 'string' ? result.current_state : undefined,
  );
}

// Generic adapter shim — the SDK's typed `SeedAdapter<P>`/`ForceAdapter<P>`/
// `SimulateAdapter<P>` constrain `P` to per-scenario param interfaces, but
// our shim handles all scenarios uniformly. The casts at the assignment
// site narrow back to the typed adapter shape.
type AdapterShim = (params: unknown, ctx: ComplyControllerContext) => Promise<unknown>;

function seedAdapter(scenario: string): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input);
    throwOnFailure(result);
    // Seed adapters return void — framework builds SeedSuccess envelope
    // from its own idempotency cache.
  };
}

function forceAdapter(scenario: string): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input);
    throwOnFailure(result);
    return result;
  };
}

function simulateAdapter(scenario: string): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input);
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
 * Extend the spec-canonical `TOOL_INPUT_SHAPE` with a top-level `account`
 * field. v5 storyboards send `account: { brand: { domain }, sandbox }` at
 * the top level — the v5 handler reads `account.brand.domain` for session
 * keying. The v6 first-class registration uses the spec-canonical shape
 * (no top-level `account` — spec routes account context through `context`)
 * which would strip the field. F10's `inputSchema` extension point lets us
 * accept the v5-vintage shape until storyboard fixtures migrate to spec.
 */
const SALES_COMPLY_INPUT_SCHEMA = {
  ...TOOL_INPUT_SHAPE,
  account: z.object({
    account_id: z.string().optional(),
    brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
    sandbox: z.boolean().optional(),
  }).passthrough().optional(),
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
export function buildCreativeComplyConfig(): ComplyControllerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = (a: AdapterShim) => a as any;
  return {
    inputSchema: SALES_COMPLY_INPUT_SCHEMA,
    seed: {
      creative: cast(seedAdapter('seed_creative')),
      // F14 (`bd0d4028`) added the `creative_format` slot — needed for
      // `pagination_integrity_creative_formats` storyboard which seeds
      // multiple format fixtures and walks list_creative_formats pagination.
      creative_format: cast(seedAdapter('seed_creative_format')),
      product: cast(seedAdapter('seed_product')),
      pricing_option: cast(seedAdapter('seed_pricing_option')),
      media_buy: cast(seedAdapter('seed_media_buy')),
    },
    force: {
      creative_status: cast(forceAdapter('force_creative_status')),
      media_buy_status: cast(forceAdapter('force_media_buy_status')),
    },
  };
}

export function buildSalesComplyConfig(): ComplyControllerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = (a: AdapterShim) => a as any;
  return {
    inputSchema: SALES_COMPLY_INPUT_SCHEMA,
    seed: {
      product: cast(seedAdapter('seed_product')),
      pricing_option: cast(seedAdapter('seed_pricing_option')),
      media_buy: cast(seedAdapter('seed_media_buy')),
      creative: cast(seedAdapter('seed_creative')),
      // /sales advertises list_creative_formats (the SDK auto-registers it for
      // any tenant claiming a creative archetype) so the universal
      // pagination_integrity_creative_formats storyboard fires here too. The
      // seed adapter routes through the v5 handler's LOCAL_SCENARIOS path,
      // populating the process-global seeded format pool that
      // list_creative_formats reads.
      creative_format: cast(seedAdapter('seed_creative_format')),
    },
    force: {
      media_buy_status: cast(forceAdapter('force_media_buy_status')),
      create_media_buy_arm: cast(forceAdapter('force_create_media_buy_arm')),
      task_completion: cast(forceAdapter('force_task_completion')),
    },
    simulate: {
      delivery: cast(simulateAdapter('simulate_delivery')),
      budget_spend: cast(simulateAdapter('simulate_budget_spend')),
    },
  };
}
