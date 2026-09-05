export interface FixedTraceDiagnosticCliArguments {
  providers?: string;
  architectureArm?: string;
  suite?: string;
  softMaxUsd?: string;
  output?: string;
  validateOnly: boolean;
}

const NAMES = new Set(['providers', 'architecture-arm', 'suite', 'soft-max-usd', 'output', 'validate-only']);

/** Strict, side-effect-free parser for the diagnostic-only manual evaluator. */
export function parseFixedTraceDiagnosticCliArguments(values: readonly string[]): FixedTraceDiagnosticCliArguments {
  const seen = new Map<string, string | true>();
  for (const value of values) {
    if (value === '--judge-providers' || value.startsWith('--judge-providers=')) {
      throw new Error('--judge-providers is unavailable_pending_trusted_coordinator');
    }
    const bare = value.match(/^--([a-z][a-z-]*)$/);
    const assigned = value.match(/^--([a-z][a-z-]*)=(.+)$/);
    const name = bare?.[1] ?? assigned?.[1];
    if (!name || !NAMES.has(name)) throw new Error(`Unknown or malformed fixed-trace option: ${value}`);
    if (seen.has(name)) throw new Error(`Duplicate fixed-trace option: --${name}`);
    if (bare && name !== 'validate-only') throw new Error(`--${name} requires =value`);
    if (assigned && name === 'validate-only' && assigned[2] !== 'true') {
      throw new Error('--validate-only accepts only the bare flag or =true');
    }
    seen.set(name, bare ? true : assigned![2]);
  }
  return {
    providers: typeof seen.get('providers') === 'string' ? seen.get('providers') as string : undefined,
    architectureArm: typeof seen.get('architecture-arm') === 'string' ? seen.get('architecture-arm') as string : undefined,
    suite: typeof seen.get('suite') === 'string' ? seen.get('suite') as string : undefined,
    softMaxUsd: typeof seen.get('soft-max-usd') === 'string' ? seen.get('soft-max-usd') as string : undefined,
    output: typeof seen.get('output') === 'string' ? seen.get('output') as string : undefined,
    validateOnly: seen.get('validate-only') === true || seen.get('validate-only') === 'true',
  };
}
