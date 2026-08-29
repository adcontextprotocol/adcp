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
import { TOOL_INPUT_SHAPE, type TaskRegistry, type TaskRegistryScope } from '@adcp/sdk/server';
import { handleComplyTestController } from '../comply-test-controller.js';
import {
  canonicalizeAccountRef,
  normalizeControllerAccountRef,
  syntheticAccountIdFromRef,
} from '../account-scope.js';
import type { ToolArgs, TrainingContext } from '../types.js';
import {
  taskRegistryNamespaceForTenant,
  type TaskRegistryTenant,
  type TrainingTaskRegistryScope,
} from '../task-registry-scope.js';
import { registerSharedPublicBrandPartition } from '../state.js';

const TRAINING_PRINCIPAL_FIELD = '__training_principal';
const TRAINING_TASK_OWNER_SCOPE_FIELD = '__training_task_owner_scope';

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
  taskRegistryScope?: TrainingTaskRegistryScope,
): Promise<V5Response> {
  // v5 handler reads brand/account from the wire-shaped args to derive
  // the session key. `ctx.input` is the full raw input (including
  // brand/account/sandbox/etc.), so spread it and stamp scenario+params.
  const principal = typeof input[TRAINING_PRINCIPAL_FIELD] === 'string'
    ? input[TRAINING_PRINCIPAL_FIELD]
    : 'anonymous';
  const cleanInput = { ...input };
  delete cleanInput[TRAINING_PRINCIPAL_FIELD];
  delete cleanInput[TRAINING_TASK_OWNER_SCOPE_FIELD];
  const assertedAccount = cleanInput.account;
  if (
    principal.startsWith('static:')
    && assertedAccount !== null
    && typeof assertedAccount === 'object'
    && !Array.isArray(assertedAccount)
    && (assertedAccount as Record<string, unknown>).sandbox === true
  ) {
    try {
      const canonical = canonicalizeAccountRef(assertedAccount);
      if (canonical.kind === 'natural') {
        // Current platform methods attach this unforgeable hint after the SDK
        // resolves the account. Controller adapters run beside that facade,
        // so restore the same trusted public-sandbox partition from the
        // authenticated static principal and validated AccountRef. This keeps
        // lifecycle mutations account-local without a process-global lookup.
        registerSharedPublicBrandPartition(cleanInput, canonical.brand.domain);
      }
    } catch {
      // The controller handler owns the canonical invalid-account response.
    }
  }
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
  // The source controller contract can grow additive scenario parameters
  // before the pinned SDK's typed adapter catches up. Preserve the raw
  // deterministic stale-age fixture rather than letting the older adapter
  // parser strip it before the v5 implementation sees it.
  const rawParams = cleanInput.params && typeof cleanInput.params === 'object' && !Array.isArray(cleanInput.params)
    ? cleanInput.params as Record<string, unknown>
    : {};
  const parsedFixture = params.fixture && typeof params.fixture === 'object' && !Array.isArray(params.fixture)
    ? params.fixture as Record<string, unknown>
    : {};
  const rawFixture = rawParams.fixture && typeof rawParams.fixture === 'object' && !Array.isArray(rawParams.fixture)
    ? rawParams.fixture as Record<string, unknown>
    : undefined;
  const forwardedParams = scenario === 'force_upstream_unavailable'
    ? {
        ...params,
        ...(rawParams.cache_age_seconds !== undefined && {
          cache_age_seconds: rawParams.cache_age_seconds,
        }),
      }
    : scenario === 'seed_media_buy' && rawFixture
      ? {
          ...params,
          // The pinned SDK seed type predates accepted_proposal/change_terms.
          // Preserve additive fixture state from the raw compliance request so
          // current storyboards can seed the binding commercial authority.
          fixture: { ...parsedFixture, ...rawFixture },
        }
      : params;
  const args = { ...cleanInput, scenario, params: forwardedParams } as ToolArgs;
  return await handleComplyTestController(args, {
    mode: 'open',
    principal,
    ...(taskRegistryScope && { taskRegistryScope }),
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

async function requireControllerTaskScope(
  taskRegistry: TaskRegistry,
  taskId: string,
  scope: TaskRegistryScope | null,
): Promise<TaskRegistryScope> {
  // Never recover scope from the target record. Task IDs are public and may
  // intentionally repeat across accounts and authenticated runners.
  if (!scope) {
    throw new TestControllerError('NOT_FOUND', `Task ${taskId} not found`);
  }
  const task = await taskRegistry.getTask(taskId, scope);
  if (!task) throw new TestControllerError('NOT_FOUND', `Task ${taskId} not found`);
  return scope;
}

function controllerTaskScope(
  input: Record<string, unknown>,
): TaskRegistryScope | null {
  // The router overwrites this field after bearer authentication. It is not
  // accepted as caller authority on routes that bypass that trusted bridge.
  const ownerScope = input[TRAINING_TASK_OWNER_SCOPE_FIELD];
  if (typeof ownerScope !== 'string' || ownerScope.length === 0) return null;

  try {
    const accountRef = normalizeControllerAccountRef(input.account);
    const account = canonicalizeAccountRef(accountRef);
    if (account.kind === 'account_id') {
      return { accountId: account.account_id, ownerScope };
    }
    // Both decisioning platforms derive durable task scope from the complete
    // canonical account identity, including operator and sandbox disposition.
    const accountId = syntheticAccountIdFromRef(accountRef);
    return { accountId, ownerScope };
  } catch {
    return null;
  }
}

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
): AdapterShim {
  return async (params, ctx) => {
    const result = await dispatchV5(scenario, params as Record<string, unknown>, ctx.input, storyboardCompat);
    throwOnFailure(result);
    return result;
  };
}

function taskCompletionAdapter(
  tenantId: TaskRegistryTenant,
  storyboardCompat?: TrainingContext['storyboardCompat'],
  taskRegistry?: TaskRegistry,
): AdapterShim {
  return async (rawParams, ctx) => {
    const params = rawParams as Record<string, unknown>;
    const taskId = params.task_id;
    const result = params.result;
    let scope: TaskRegistryScope | undefined;
    if (
      taskRegistry
      && typeof taskId === 'string'
      && result
      && typeof result === 'object'
      && !Array.isArray(result)
    ) {
      // Authorize before dispatchV5 signals the pending worker. Checking only
      // after dispatch would still let a cross-scope caller resolve it.
      scope = await requireControllerTaskScope(
        taskRegistry,
        taskId,
        controllerTaskScope(ctx.input),
      );
    }
    const completionScope = scope
      ? {
          ...scope,
          registryNamespace: taskRegistryNamespaceForTenant(tenantId),
        }
      : undefined;
    const controllerResult = await dispatchV5(
      'force_task_completion',
      params,
      ctx.input,
      storyboardCompat,
      completionScope,
    );
    throwOnFailure(controllerResult);
    if (taskRegistry && scope && typeof taskId === 'string' && result && typeof result === 'object' && !Array.isArray(result)) {
      // Persist synchronously so the next polling step cannot race the
      // background handoff worker's identical idempotent completion.
      await taskRegistry.complete(taskId, scope, result as Record<string, unknown>);
    }
    return controllerResult;
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
    operator: z.string().optional(),
    sandbox: z.literal(true),
  }).passthrough(),
  brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
  [TRAINING_PRINCIPAL_FIELD]: z.string().optional(),
  [TRAINING_TASK_OWNER_SCOPE_FIELD]: z.string().optional(),
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

export function buildSignalsComplyConfig(
  storyboardCompat?: TrainingContext['storyboardCompat'],
  taskRegistry?: TaskRegistry,
): ComplyControllerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = (a: AdapterShim) => a as any;
  return {
    inputSchema: SALES_COMPLY_INPUT_SCHEMA,
    force: {
      // The frozen 3.0 capability schema permits only the original six
      // controller scenario IDs. Keep one of those universally applicable
      // lifecycle controls wired so the signals tenant can truthfully expose
      // a non-empty compliance_testing.scenarios block in 3.0 mode.
      session_status: cast(forceAdapter('force_session_status', storyboardCompat)),
      ...(storyboardCompat?.version === '3.0' ? {} : {
        get_signals_arm: cast(forceAdapter('force_get_signals_arm', storyboardCompat)),
        task_completion: cast(taskCompletionAdapter('signals', storyboardCompat, taskRegistry)),
      }),
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
      task_completion: cast(taskCompletionAdapter('sales', storyboardCompat, taskRegistry)),
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
