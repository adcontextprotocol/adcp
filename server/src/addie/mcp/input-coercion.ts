/**
 * Runtime coercion helpers for LLM-provided tool inputs.
 *
 * Tool input_schemas declare types, but the model occasionally drifts —
 * passing a string where the schema says `array of strings`, or omitting
 * a field. TypeScript casts (`input.x as string[]`) silently survive
 * these runtime shape mismatches and crash later (e.g. `.join is not a
 * function`). Coerce at the handler boundary instead.
 */

const DEFAULT_MAX_ITEMS = 20;

/**
 * Normalize an unknown value into a clean string array.
 *
 * - Arrays: keep non-empty string entries.
 * - Strings: split on commas, trim, drop empties.
 * - Anything else: empty array.
 *
 * Trims, drops empties, dedupes, and caps length to prevent pathological
 * inputs (e.g. `"bug,bug,bug,..."` 1000×) from ballooning downstream URLs
 * or queries.
 */
export function coerceStringArray(value: unknown, maxItems: number = DEFAULT_MAX_ITEMS): string[] {
  let items: string[];
  if (Array.isArray(value)) {
    items = value
      .filter((v): v is string => typeof v === 'string')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  } else if (typeof value === 'string') {
    items = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
  } else {
    return [];
  }
  return Array.from(new Set(items)).slice(0, maxItems);
}
