interface FailedValidationForSummary {
  id?: unknown;
  passed?: boolean;
  description?: unknown;
  error?: unknown;
  actual?: unknown;
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
