/**
 * Result of a pure function of one string, memoized by the string itself (the
 * key is the whole input), so corpus validation does not recompute it for the
 * same leaf in every suite variant it checks. At the bound the memo stops
 * inserting; nothing is evicted. A shared result object must be frozen.
 */
export const FIXED_TRACE_STRING_MEMO_LIMIT = 50_000;

export function memoizedByString<T>(
  memo: Map<string, T>,
  value: string,
  compute: (value: string) => T,
): T {
  const known = memo.get(value);
  if (known !== undefined) return known;
  const result = compute(value);
  if (memo.size < FIXED_TRACE_STRING_MEMO_LIMIT) memo.set(value, result);
  return result;
}
