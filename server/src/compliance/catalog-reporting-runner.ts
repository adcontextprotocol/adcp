/**
 * Buyer-side construction for the two catalog reporting storyboards.
 *
 * Arithmetic belongs to the caller: the closed storyboard language only
 * substitutes whole context keys. Prepare the exact graph once, derive a
 * budget from its selected price, and reuse that state without rediscovery.
 * This is request-local preparation, not a cross-request grant/state store.
 */
import {
  prepareStoryboardFixtures,
  isProtectedContextKey,
  testCapabilityDiscovery,
  runStoryboard as runSdkStoryboard,
  runStoryboardStep as runSdkStoryboardStep,
  withPreparedFixtures,
  withExternalSchemaRoot,
  type Storyboard,
  type StoryboardRunOptions,
} from "@adcp/sdk/testing";

export const REPORTING_PRICE_CAPTURE = "__adcp_fixture_reporting_price";
export const REPORTING_BUDGET_CONTEXT = "catalog_reporting_budget";
const REPORTING_IDS = new Set([
  "media_buy_seller/advanced_delivery_reporting",
  "media_buy_seller/time_based_delivery_reporting",
]);
const BASELINE_BUDGET = 1000; // Buyer test intent, never a seller minimum.

type AgentUrl = Parameters<typeof runSdkStoryboard>[0];

function isCatalogReporting(storyboard: Storyboard): boolean {
  return (
    REPORTING_IDS.has(storyboard.id) &&
    storyboard.fixture_resolution?.pricing_options?.some((declaration) =>
      declaration.context_outputs?.some(
        (output) => output.key === REPORTING_PRICE_CAPTURE,
      ),
    ) === true
  );
}

async function withReportingPreparation<T>(
  agentUrl: AgentUrl,
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  execute: (preparedOptions: StoryboardRunOptions) => Promise<T>,
  stepId?: string,
): Promise<T> {
  if (!isCatalogReporting(storyboard)) return execute(options);
  if (
    stepId !== undefined &&
    !storyboard.phases.some((phase) =>
      phase.steps.some((step) => step.id === stepId),
    )
  )
    return execute(options);
  // Delegate invalid caller maps to the SDK's canonical denial BEFORE our
  // capability discovery. Do not sanitize them or produce a substitute grade.
  const callerMaps = [
    options.context,
    options.context_provenance,
    options.response_derived_not_applicable_context_keys,
  ];
  if (
    callerMaps.some(
      (map) =>
        map &&
        Object.keys(map).some(
          (key) =>
            isProtectedContextKey(key) ||
            ["__proto__", "constructor", "prototype"].includes(key),
        ),
    )
  ) {
    return execute(options);
  }
  // These entry points own one preparation for one authenticated invocation.
  // Never silently discard a supplied reuse grant, or re-resolve it instead.
  if (options.prepared_fixtures !== undefined) {
    throw new Error(
      "Catalog reporting preparation must be owned by this invocation; use the SDK directly to reuse an existing authorized state.",
    );
  }
  // The authored sandbox identity is trusted source, never a seller echo or
  // a caller's ordinary context override. An explicit caller brand is retained.
  if (
    options.sandbox === false ||
    options.disable_sandbox === true ||
    options.context?.sandbox === false
  ) {
    throw new Error("Catalog reporting requires the authored sandbox scope");
  }
  if (options.agents || (Array.isArray(agentUrl) && agentUrl.length !== 1)) {
    throw new Error("Catalog reporting targets one seller per invocation");
  }
  const callerContext = { ...options.context };
  delete callerContext.products;
  const declared = storyboard.context ?? {};
  options = {
    ...options,
    brand:
      options.brand ??
      (structuredClone(
        declared.sandbox_brand,
      ) as StoryboardRunOptions["brand"]),
    sandbox: true,
    context: {
      ...callerContext,
      brand: structuredClone(declared.sandbox_brand),
      account: structuredClone(declared.sandbox_account),
      sandbox_brand: structuredClone(declared.sandbox_brand),
      sandbox_account: structuredClone(declared.sandbox_account),
      sandbox: true,
    },
  };
  // Ignore the legacy first-product cache ONLY in these two scopes. All
  // identities/commercial terms come from the pinned graph. Otherwise the
  // SDK's generic create enricher invents an auction bid from an unrelated
  // cached CPM row, even for a selected fixed-price option.
  // Keep root applicability gates ahead of controller setup/preparation.
  const discover = () =>
    testCapabilityDiscovery(
      Array.isArray(agentUrl) ? agentUrl[0] : agentUrl,
      options,
    );
  // The low-level discovery helper does not establish the schemaRoot scope
  // that full/standalone runners establish themselves. Preserve the caller's
  // exact candidate schema artifact for this additional preflight as well.
  const profile =
    options.profile ??
    (
      await (options.schemaRoot && options.adcpVersion
        ? withExternalSchemaRoot(
            options.adcpVersion,
            options.schemaRoot,
            discover,
          )
        : discover())
    ).profile;
  if (!profile)
    throw new Error(
      "Capability discovery failed before catalog reporting preparation",
    );
  options = { ...options, profile };
  const capabilities = profile.raw_capabilities as
    Record<string, unknown> | undefined;
  const mediaBuy = capabilities?.media_buy as
    { buying_modes?: string[] } | undefined;
  const tools = new Set(profile.tools);
  if (
    !mediaBuy?.buying_modes?.includes("wholesale") ||
    !tools.has("comply_test_controller") ||
    !storyboard.required_tools?.some((tool) => tools.has(tool))
  ) {
    return execute(options); // Let the unchanged SDK produce its canonical gate.
  }
  const prepared = await prepareStoryboardFixtures(
    agentUrl,
    storyboard,
    options,
  );
  let budget: number | undefined;
  if (prepared.disposition.status === "resolved") {
    const price = prepared.captures[REPORTING_PRICE_CAPTURE] as Record<
      string,
      unknown
    >;
    if (!price || typeof price !== "object")
      throw new Error(
        "Resolved reporting graph has no selected price snapshot",
      );
    const minimum = price.min_spend_per_package;
    if (
      minimum !== undefined &&
      (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum < 0)
    ) {
      throw new Error("Selected reporting price has an invalid minimum spend");
    }
    budget = Math.max(BASELINE_BUDGET, minimum ?? 0);
  }
  // The trusted caller authorized this invocation. The state is never shared
  // or serialized; close its local grant when the invocation ends. An actual
  // host authorizer, when supplied, remains authoritative on EVERY lookup.
  let active = true;
  const hostAuthorizer = options.prepared_fixtures_authorizer;
  const auditSink = options.prepared_fixtures_audit_sink;
  try {
    return await execute({
      ...options,
      context: {
        ...options.context,
        ...(budget === undefined ? {} : { [REPORTING_BUDGET_CONTEXT]: budget }),
      },
      ...withPreparedFixtures(prepared, async (lookup) => {
        if (!active)
          return { authorized: false, detail: "Reporting invocation ended" };
        return hostAuthorizer ? hostAuthorizer(lookup) : { authorized: true };
      }),
      // The producer ran before consumer authorization. Link its real records
      // into the caller's PRIVATE audit scope, without changing any grade,
      // phase, count or request/response field emitted by the consumer.
      ...(auditSink && {
        prepared_fixtures_audit_sink: async (record) => {
          const auditRecord = {
            ...record,
            fixture_resolutions:
              ("fixture_resolutions" in record
                ? record.fixture_resolutions
                : undefined) ?? prepared.resolutions,
            fixture_preparation: {
              disposition: prepared.disposition,
              phase: prepared.phase,
            },
          };
          await auditSink(auditRecord);
        },
      }),
    });
  } finally {
    active = false;
  }
}

export function runCatalogReportingStoryboard(
  agentUrl: AgentUrl,
  storyboard: Storyboard,
  options: StoryboardRunOptions = {},
) {
  return withReportingPreparation(
    agentUrl,
    storyboard,
    options,
    (preparedOptions) =>
      runSdkStoryboard(agentUrl, storyboard, preparedOptions),
  );
}

export function runCatalogReportingStoryboardStep(
  agentUrl: Parameters<typeof runSdkStoryboardStep>[0],
  storyboard: Storyboard,
  stepId: string,
  options: StoryboardRunOptions = {},
) {
  return withReportingPreparation(
    agentUrl,
    storyboard,
    options,
    (preparedOptions) =>
      runSdkStoryboardStep(agentUrl, storyboard, stepId, preparedOptions),
    stepId,
  );
}
