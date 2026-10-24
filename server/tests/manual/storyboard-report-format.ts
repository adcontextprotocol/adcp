interface FailedValidationForSummary {
  id?: unknown;
  passed?: boolean;
  severity?: string;
  description?: unknown;
  error?: unknown;
  actual?: unknown;
}

export interface StoryboardStepForSummary {
  passed?: boolean;
  skipped?: boolean;
  not_applicable?: boolean;
  error?: string;
  validations?: Array<{ passed: boolean; severity?: string }>;
  response?: { accepted?: unknown; errors?: Array<{ code?: unknown }> };
}

/** SDK step.passed already applies advisory expiry/promotion and blocking
 * validation rules. Do not turn an SDK-passing advisory into a failed step. */
export function storyboardStepStatus(step: StoryboardStepForSummary): 'passed' | 'failed' | 'skipped' | 'not_applicable' {
  if (step.not_applicable) return 'not_applicable';
  if (step.skipped) return 'skipped';
  const validations = step.validations ?? [];
  if (
    (step.passed === false || step.error)
    && step.response?.accepted === 0
    && step.response.errors?.some(error => error.code === 'BILLING_OUT_OF_BAND')
    && validations.length > 0
    && validations.every(validation => validation.passed || validation.severity === 'advisory')
  ) return 'passed';
  if (step.error || step.passed === false) return 'failed';
  if (step.passed === true) return 'passed';
  return validations.some(validation => !validation.passed && validation.severity !== 'advisory') ? 'failed' : 'passed';
}

interface FormatFailedValidationSummaryOptions {
  includeActual?: boolean;
  missingDescription?: string;
}

function stringifyActual(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable actual]';
  }
}

export function formatFailedValidationSummary(
  validations: FailedValidationForSummary[] | undefined,
  options: FormatFailedValidationSummaryOptions = {},
): string {
  const missingDescription = options.missingDescription ?? '(validation failed)';
  return (validations ?? [])
    .filter(v => !v.passed)
    .map(v => {
      const id = typeof v.id === 'string' && v.id ? `${v.id}: ` : '';
      const desc = typeof v.description === 'string' && v.description ? v.description : missingDescription;
      const detail = typeof v.error === 'string' && v.error
        ? v.error
        : options.includeActual
          ? stringifyActual(v.actual)
          : undefined;
      return detail ? `${id}${desc} — ${detail}` : `${id}${desc}`;
    })
    .join('; ');
}

export function formatStepFailureDetail(
  stepError: unknown,
  validations: FailedValidationForSummary[] | undefined,
  options: FormatFailedValidationSummaryOptions = {},
): string {
  const error = typeof stepError === 'string' && stepError ? stepError : undefined;
  const validationErrors = formatFailedValidationSummary(validations, options);
  if (validationErrors) return error ? `${error} — ${validationErrors}` : validationErrors;
  return error ?? '(failed without message)';
}

export function formatFailureDetailSnippet(
  detail: string,
  options: { maxLength?: number; validationId?: string } = {},
): string {
  const snippet = detail.slice(0, options.maxLength ?? 160);
  if (options.validationId && !snippet.includes(options.validationId)) {
    return `${options.validationId}: ${snippet}`;
  }
  return snippet;
}
