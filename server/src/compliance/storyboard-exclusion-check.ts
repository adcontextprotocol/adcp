/** Bridge the additive exclusion check until the SDK grades it natively. */
import {
  getAssertion,
  injectContext,
  isProtectedContextKey,
  registerAssertion,
  resolvePath,
  runValidations,
  type AssertionSpec,
  type Storyboard,
  type StoryboardRunOptions,
  type StoryboardContext,
  type StoryboardStep,
  type StoryboardStepResult,
  type StoryboardValidation,
  type ValidationResult,
} from "@adcp/sdk/testing";

export const FIELD_EXCLUDES_RUNNER_CONTRACT = "field_excludes_runner";
export const FIELD_EXCLUDES_ASSERTION_ID = "adcp.field_excludes_compat";
// Keep the bridge usable with runners that predate this additive check.
const EXCLUDES_CHECK = "field_excludes" as StoryboardValidation["check"];

function nativeExclusionSupport(): boolean {
  const [result] = runValidations(
    [{ check: EXCLUDES_CHECK, path: "value", value: "prohibited", description: "Detect exclusion support" }],
    {
      taskName: "get_products",
      agentUrl: "https://runner.example",
      contributions: new Set(),
      taskResult: { success: true, data: { value: "prohibited" } },
    },
  );
  return result?.passed === false && result.not_applicable !== true;
}

function authoredStep(storyboard: Storyboard, result: StoryboardStepResult): StoryboardStep | undefined {
  return storyboard.phases.find((phase) => phase.id === result.phase_id)?.steps.find((step) => step.id === result.step_id);
}

/** Walk lazily: the SDK's wildcard helper truncates after 10,000 terminals. */
function* valuesAtPath(value: unknown, path: string): Generator<unknown> {
  const parts = path.split(/\[(?:\*)?\]/);
  function* walk(entry: unknown, index: number): Generator<unknown> {
    const segment = parts[index].replace(/^\./, "");
    const resolved = segment ? resolvePath(entry, segment) : entry;
    if (index === parts.length - 1) {
      if (resolved !== undefined) yield resolved;
    } else if (Array.isArray(resolved)) {
      for (const child of resolved) yield* walk(child, index + 1);
    }
  }
  yield* walk(value, 0);
}

function pathMetadata(path: string): { comparisonKey: string; pointer: string } {
  const tokens = path.match(/[^.\[\]]+|\[(?:\d+|\*)?\]/g) ?? [];
  const normalized = tokens.map((token) => token.startsWith("[") ? token.slice(1, -1) || "*" : token);
  return {
    comparisonKey: [...tokens].reverse().find((token) => !token.startsWith("[")) ?? "value",
    pointer: `/${normalized.map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`,
  };
}

function hasUnresolvedContext(value: unknown): boolean {
  if (typeof value === "string") return value.includes("$context.");
  if (Array.isArray(value)) return value.some(hasUnresolvedContext);
  return value !== null && typeof value === "object" && Object.values(value).some(hasUnresolvedContext);
}

function contextReferences(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/\$context\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  if (Array.isArray(value)) return value.flatMap(contextReferences);
  return value !== null && typeof value === "object" ? Object.values(value).flatMap(contextReferences) : [];
}

function gradeExclusion(
  validation: StoryboardValidation,
  step: StoryboardStepResult,
  agentUrl: string,
  comparisonContext?: StoryboardContext,
): ValidationResult {
  const effective = injectContext({ ...validation }, comparisonContext ?? step.context) as unknown as StoryboardValidation;
  const context = {
    taskName: step.task,
    agentUrl,
    contributions: new Set<string>(),
    taskResult: { success: true, data: step.product_page_collection?.logical_response ?? step.response ?? step.response_record?.payload },
    request: step.request,
    response: step.response_record,
    storyboardContext: step.context,
  };
  let configurationError: string | undefined;
  const overwrittenReference = comparisonContext === undefined && contextReferences({ path: validation.path, value: validation.value, allowed_values: validation.allowed_values }).some((key) => {
    const provenance = step.context_provenance?.[key];
    return provenance?.source_step_id === step.step_id && (provenance.source_kind === "context_outputs" || provenance.source_kind === "convention");
  });
  if (overwrittenReference) {
    configurationError = "field_excludes cannot use a context value overwritten by the same response; capture it under a separate key";
  } else if (typeof effective.path !== "string" || effective.path.length === 0) {
    configurationError = "field_excludes requires a nonempty path";
  } else if (effective.allowed_values !== undefined && !Array.isArray(effective.allowed_values)) {
    configurationError = "field_excludes allowed_values must be an array";
  } else if (effective.value === undefined && !effective.allowed_values?.length) {
    configurationError = "field_excludes requires value or nonempty allowed_values";
  } else if (hasUnresolvedContext({ path: effective.path, value: effective.value, allowed_values: effective.allowed_values })) {
    configurationError = "field_excludes contains an unresolved context reference";
  }
  if (configurationError) {
    // Reuse SDK severity/expiry decoration even for malformed authored checks.
    const [invalid] = runValidations([{ ...effective, check: "field_contains", path: "" }], context);
    return {
      ...invalid,
      check: EXCLUDES_CHECK,
      passed: false,
      path: effective.path,
      error: configurationError,
      expected: "a path and a resolved value or allowed_values matcher",
      actual: null,
    };
  }
  const { comparisonKey, pointer } = pathMetadata(effective.path!);
  // Match one actual terminal at a time with the public SDK matcher. A local
  // projection for this pure comparison keeps SDK subset/agent-URL semantics
  // without changing the recorded seller response or inheriting its path cap.
  const [membership] = runValidations([{ ...effective, check: "field_contains", path: comparisonKey }], {
    ...context,
    taskResult: { success: true, data: {} },
  });
  let matched = false;
  for (const value of valuesAtPath(context.taskResult.data, effective.path!)) {
    const [terminal] = runValidations([{ ...effective, check: "field_contains", path: comparisonKey }], {
      ...context,
      taskResult: { success: true, data: { [comparisonKey]: value } },
    });
    if (terminal.passed) {
      matched = true;
      break;
    }
  }
  const { error: _error, expected: _expected, actual: _actual, ...metadata } = membership;
  const passed = !matched;
  return {
    ...metadata,
    check: EXCLUDES_CHECK,
    passed,
    path: effective.path,
    json_pointer: pointer,
    ...(!passed && {
      error: `Prohibited value matched field_excludes at ${effective.path}`,
      expected: { excludes: effective.allowed_values?.length ? effective.allowed_values : effective.value },
      actual: [...valuesAtPath(context.taskResult.data, effective.path!)],
      request: step.request,
      response: step.response_record,
    }),
  };
}

/** Replace unsupported rows in place; never alter the request or seller response. */
function applyExclusions(storyboard: Storyboard, step: StoryboardStepResult, agentUrl: string, comparisonContext?: StoryboardContext): boolean {
  if (step.skipped) return false;
  const authored = authoredStep(storyboard, step);
  const validations = authored?.validations?.filter((validation) => validation.check === EXCLUDES_CHECK) ?? [];
  const observed = step.validations.filter((validation) => validation.check === EXCLUDES_CHECK);
  let failed = false;
  for (const [index, validation] of validations.entries()) {
    // A native grade, or an earlier physical-page fallback, already owns it.
    if (observed[index] && observed[index].not_applicable !== true) continue;
    const grade = gradeExclusion(validation, step, agentUrl, comparisonContext);
    const existing = observed[index];
    if (existing) step.validations.splice(step.validations.indexOf(existing), 1, grade);
    else step.validations.push(grade);
    if (!grade.passed && grade.severity !== "advisory") failed = true;
  }
  return failed;
}

const exclusionAssertion: AssertionSpec = {
  id: FIELD_EXCLUDES_ASSERTION_ID,
  default: true,
  description: "Grade required field_excludes checks before the SDK advances a storyboard.",
  onStep(context, step) {
    if (!applyExclusions(context.storyboard, step, context.agentUrl)) return [];
    return [{ passed: false, description: "A required field_excludes validation failed", error: "The response contains a prohibited value or the exclusion check is malformed." }];
  },
};

export function withExclusionSupport(storyboard: Storyboard, options: StoryboardRunOptions): {
  storyboard: Storyboard;
  options: StoryboardRunOptions;
} {
  if (!nativeExclusionSupport()) {
    const registered = getAssertion(FIELD_EXCLUDES_ASSERTION_ID);
    if (!registered) registerAssertion(exclusionAssertion);
    else if (registered !== exclusionAssertion) throw new Error("The field_excludes compatibility assertion is already registered by another implementation");
    const disabled = !Array.isArray(storyboard.invariants) && storyboard.invariants?.disable?.includes(FIELD_EXCLUDES_ASSERTION_ID);
    const disabledStep = storyboard.phases.some((phase) => phase.steps.some((step) => step.invariants?.disable?.includes(FIELD_EXCLUDES_ASSERTION_ID)));
    if (disabled || disabledStep) throw new Error("Required field_excludes compatibility grading cannot be disabled");
  }
  // Older SDKs reject unknown top-level requirements before consulting options.
  // Remove only the token whose executable implementation was established above.
  const satisfiesRequirement = storyboard.requires?.includes(FIELD_EXCLUDES_RUNNER_CONTRACT);
  const requires = satisfiesRequirement
    ? storyboard.requires!.filter((requirement) => requirement !== FIELD_EXCLUDES_RUNNER_CONTRACT)
    : undefined;
  return {
    storyboard: satisfiesRequirement ? { ...storyboard, requires: requires?.length ? requires : undefined } : storyboard,
    options: { ...options, contracts: [...new Set([...(options.contracts ?? []), FIELD_EXCLUDES_RUNNER_CONTRACT])] },
  };
}

/** Failed standalone exclusions cannot publish response-derived continuation state. */
export function gradeStandaloneExclusions(
  storyboard: Storyboard,
  step: StoryboardStepResult,
  agentUrl: string,
  options: StoryboardRunOptions,
): StoryboardStepResult {
  const failedFallback = applyExclusions(storyboard, step, agentUrl, { ...storyboard.context, ...options.context });
  const failedNative = !step.skipped && step.validations.some((validation) =>
    validation.check === EXCLUDES_CHECK && !validation.passed && validation.not_applicable !== true && validation.severity !== "advisory",
  );
  if (!failedFallback && !failedNative) return step;
  step.passed = false;
  step.error ??= "A required field_excludes validation failed";
  step.context = Object.fromEntries(Object.entries({ ...storyboard.context, ...options.context }).filter(([key]) => !isProtectedContextKey(key)));
  step.context_provenance = { ...options.context_provenance };
  step.response_derived_not_applicable_context_keys = { ...options.response_derived_not_applicable_context_keys };
  step.contributions = [...(options.contributions ?? [])];
  delete step.next;
  return step;
}
