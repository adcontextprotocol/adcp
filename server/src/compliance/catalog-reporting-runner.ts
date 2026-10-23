/**
 * Buyer-side construction for the two catalog reporting storyboards.
 *
 * Arithmetic belongs to the caller: the closed storyboard language only
 * substitutes whole context keys. Prepare the exact graph once, derive a
 * budget from its selected price, and reuse that state without rediscovery.
 * This is request-local preparation, not a cross-request grant/state store.
 */
import {
  PreparedFixturesDeniedError,
  redactOAuthUrlForOutput,
  prepareStoryboardFixtures,
  isProtectedContextKey,
  testCapabilityDiscovery,
  runStoryboard as runSdkStoryboard,
  runStoryboardStep as runSdkStoryboardStep,
  withPreparedFixtures,
  withExternalSchemaRoot,
  withServedReleaseSchemaRoots,
  type PreparedStoryboardFixtures,
  type PreparedFixturesAuthorizer,
  type Storyboard,
  type StoryboardRunOptions,
  type StoryboardResult,
  type StoryboardStepResult,
} from "@adcp/sdk/testing";

export const REPORTING_PRICE_CAPTURE = "__adcp_fixture_reporting_price";
export const REPORTING_BUDGET_CONTEXT = "catalog_reporting_budget";
const REPORTING_IDS = new Set([
  "media_buy_seller/advanced_delivery_reporting",
  "media_buy_seller/time_based_delivery_reporting",
]);
const BASELINE_BUDGET = 1000; // Buyer test intent, never a seller minimum.

type AgentUrl = Parameters<typeof runSdkStoryboard>[0];
// Supplemental adapter evidence on standalone results; the SDK's native
// StepResult does not currently declare fixture_resolutions.
type PreparationEvidence = {
  fixture_resolutions?: PreparedStoryboardFixtures["resolutions"];
};

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

// Hosted policy only, not a protocol product-size limit or aggregate budget.
export const HOSTED_REPORTING_RESPONSE_BYTES = 1024 * 1024;
export function withHostedReportingBudget(
  storyboard: Storyboard,
  options: StoryboardRunOptions,
): StoryboardRunOptions {
  if (!isCatalogReporting(storyboard)) return options;
  const requested = options.transport?.maxResponseBytes;
  // SDK zero disables its cap; nonpositive/nonfinite values are not tighter.
  const cap =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, HOSTED_REPORTING_RESPONSE_BYTES)
      : HOSTED_REPORTING_RESPONSE_BYTES;
  return {
    ...options,
    transport: {
      ...options.transport,
      maxResponseBytes: cap,
    },
  };
}

/** Per-invocation grant lifetime; never shared or serialized. */
export async function withReportingInvocationGrant<T>(
  operation: (authorize: PreparedFixturesAuthorizer) => Promise<T>,
): Promise<T> {
  let active = true;
  try {
    return await operation(async () =>
      active
        ? { authorized: true }
        : { authorized: false, detail: "Reporting invocation ended" },
    );
  } finally {
    active = false;
  }
}

/** SDK 16.3 cannot authorize fresh preparation through its public API (#3389).
 * Refuse before contact rather than fabricate a binding or call the reuse hook
 * with invented scope. This private record describes only the actual refusal:
 * no preparation, seller exchange or resolved entity exists yet.
 */
async function refuseUncallablePreparationAuthorizer(
  agentUrl: AgentUrl,
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  stepId?: string,
): Promise<never> {
  const phase = storyboard.phases.find((p) =>
    p.steps.some((s) => s.id === stepId),
  );
  const authored = phase?.steps.find((s) => s.id === stepId);
  const detail =
    "Fresh reporting preparation cannot consult the supplied host authorizer before seller contact with SDK 16.3; see SDK #3389";
  const step: StoryboardStepResult = {
    storyboard_id: storyboard.id,
    step_id: authored?.id ?? "prepared_fixtures_authorization",
    phase_id: phase?.id ?? "fixture_preparation",
    title: "Authorize catalog reporting preparation",
    task: authored?.task ?? "",
    passed: false,
    skipped: false,
    duration_ms: 0,
    context: {},
    extraction: { path: "none" },
    error: detail,
    validations: [
      {
        check: "prepared_fixtures_authorization",
        passed: false,
        description:
          "Host authorization must precede fixture preparation seller contact",
        error: detail,
        expected:
          "an authorized prepared state bound to this exact " +
          (stepId ? "step" : "run") +
          " scope",
        actual: "authorizer_denied",
        json_pointer: null,
        schema_id: null,
        schema_url: null,
        request: null,
        response: null,
      },
    ],
  };
  const record: StoryboardResult | StoryboardStepResult = stepId
    ? ({
        ...step,
        fixture_resolutions: [],
      } as StoryboardStepResult & PreparationEvidence)
    : {
        storyboard_id: storyboard.id,
        storyboard_title: storyboard.title,
        agent_url: redactOAuthUrlForOutput(
          Array.isArray(agentUrl) ? agentUrl[0] : agentUrl,
        ),
        overall_passed: false,
        phases: [
          {
            phase_id: step.phase_id,
            phase_title: step.title,
            passed: false,
            steps: [step],
            duration_ms: 0,
          },
        ],
        context: {},
        fixture_resolutions: [],
        total_duration_ms: 0,
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        tested_at: new Date().toISOString(),
        notices: [],
        strict_validation_summary: {
          observable: false,
          checked: 0,
          passed: 0,
          failed: 0,
          strict_only_failures: 0,
          lenient_also_failed: 0,
          lenient_unobserved: 0,
        },
      };
  try {
    await options.prepared_fixtures_audit_sink?.(record);
  } catch {
    /* Audit sink errors must not disclose host state or undo denial. */
  }
  throw new PreparedFixturesDeniedError("authorizer_denied");
}

async function withReportingPreparation<T extends object>(
  agentUrl: AgentUrl,
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  execute: (preparedOptions: StoryboardRunOptions) => Promise<T>,
  stepId?: string,
): Promise<T & PreparationEvidence> {
  if (!isCatalogReporting(storyboard)) return execute(options);
  options.signal?.throwIfAborted();
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
  if (options.prepared_fixtures_authorizer !== undefined) {
    return refuseUncallablePreparationAuthorizer(
      agentUrl,
      storyboard,
      options,
      stepId,
    );
  }
  if (
    stepId !== undefined &&
    !storyboard.phases.some((phase) =>
      phase.steps.some((step) => step.id === stepId),
    )
  ) {
    throw new Error(
      `Step "${stepId}" not found in storyboard "${storyboard.id}". Available steps: ${storyboard.phases.flatMap((phase) => phase.steps.map((step) => step.id)).join(", ")}`,
    );
  }
  // Ignore the legacy first-product cache ONLY in these two scopes. All
  // identities/commercial terms come from the pinned graph. Otherwise the
  // SDK's generic create enricher invents an auction bid from an unrelated
  // cached CPM row, even for a selected fixed-price option.
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
  // Preserve the trusted invocation before adding a discovery profile. Falling
  // back must not restore caller-controlled sandbox/account/cache overrides.
  const originalOptions = options;
  // Keep root applicability gates ahead of controller setup/preparation.
  const discover = () =>
    withServedReleaseSchemaRoots(options.servedReleaseSchemaRoots, () =>
      testCapabilityDiscovery(
        Array.isArray(agentUrl) ? agentUrl[0] : agentUrl,
        options,
      ),
    );
  // The low-level discovery helper does not establish the schemaRoot scope
  // that full/standalone runners establish themselves. Preserve the caller's
  // exact candidate schema artifact for this additional preflight as well.
  const discovery = options.profile
    ? undefined
    : await (options.schemaRoot && options.adcpVersion
        ? withExternalSchemaRoot(
            options.adcpVersion,
            options.schemaRoot,
            discover,
          )
        : discover());
  options.signal?.throwIfAborted();
  const profile = options.profile ?? discovery?.profile;
  // Discovery returns partial profiles even on failure. Delegate the original
  // invocation to the SDK so its native discovery_failed grade, auth diagnostic
  // and ordinary history/OAuth handling remain available. Never use a partial
  // preflight profile as evidence of applicability or throw remote diagnostics.
  const failedDiscovery =
    discovery?.steps.filter(
      (step, index) =>
        !step.passed && (index === 0 || step.task === "get_adcp_capabilities"),
    ) ?? [];
  if (
    !profile ||
    failedDiscovery.length > 0 ||
    profile.capabilities_probe_error ||
    (profile.capabilities_schema_issues?.length ?? 0) > 0
  ) {
    return execute(originalOptions);
  }
  options = { ...options, profile };
  const capabilities = profile.raw_capabilities as
    Record<string, unknown> | undefined;
  const mediaBuy = capabilities?.media_buy as
    { buying_modes?: unknown } | undefined;
  if (
    mediaBuy?.buying_modes !== undefined &&
    !Array.isArray(mediaBuy.buying_modes)
  ) {
    return execute(originalOptions);
  }
  const tools = new Set(profile.tools);
  if (
    !Array.isArray(mediaBuy?.buying_modes) ||
    !mediaBuy.buying_modes.includes("wholesale") ||
    !storyboard.required_tools?.some((tool) => tools.has(tool))
  ) {
    return execute(options); // Let the unchanged SDK produce its canonical gate.
  }
  const prepared = await prepareStoryboardFixtures(
    agentUrl,
    storyboard,
    options,
  );
  options.signal?.throwIfAborted();
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
  // or serialized; close its local grant when the invocation ends. Supplied
  // host hooks were refused before contact above until SDK #3389 is repaired.
  const auditSink = options.prepared_fixtures_audit_sink;
  return withReportingInvocationGrant(async (authorize) => {
    const result = await execute({
      ...options,
      context: {
        ...options.context,
        ...(budget === undefined ? {} : { [REPORTING_BUDGET_CONTEXT]: budget }),
      },
      ...withPreparedFixtures(prepared, authorize),
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
    // Only an authorized consumer reaches this point: access denials throw
    // and remain confined to the private audit sink above. Some native SDK
    // failure results omit the producer records, so retain the SAME detached
    // preparation evidence without changing any grade, phase or wire field.
    // An original producer phase is self-contained; its step ids alone would
    // dangle because it need not appear among the consumer's phases.
    if ((result as PreparationEvidence).fixture_resolutions === undefined) {
      return {
        ...result,
        fixture_resolutions: prepared.resolutions.map((record) => ({
          ...record,
          ...(record.status === "failed" &&
            !("failure" in record) && {
              failure: {
                ...(prepared.disposition.status !== "resolved" && {
                  detail: prepared.disposition.detail,
                }),
                phase: prepared.phase,
              },
            }),
        })),
      };
    }
    return result;
  });
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
