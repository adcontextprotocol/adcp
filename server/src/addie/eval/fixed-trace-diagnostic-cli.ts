export interface FixedTraceDiagnosticCliArguments {
  validateOnly: boolean;
}

/** The pinned planning artifact has no runtime controls or output surface. */
export function parseFixedTraceDiagnosticCliArguments(values: readonly string[]): FixedTraceDiagnosticCliArguments {
  if (values.length === 0) return { validateOnly: false };
  if (values.length === 1 && values[0] === '--validate-only') return { validateOnly: true };
  throw new Error('This planning-only evaluator accepts only the bare --validate-only flag');
}
