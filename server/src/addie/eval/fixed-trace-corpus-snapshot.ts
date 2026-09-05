/**
 * Detach corpus input without invoking caller-defined getters. Validation only
 * reads this plain-data snapshot, so a mutable accessor cannot change data
 * after one validation pass has begun.
 */
export interface FixedTraceSnapshotResult<T> {
  readonly snapshot?: T;
  readonly error?: 'accessor' | 'non_plain_object' | 'symbol_key' | 'cyclic';
}

export function detachFixedTraceSnapshot<T>(value: T): FixedTraceSnapshotResult<T> {
  const active = new WeakSet<object>();
  const detach = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') return input;
    if (!input || typeof input !== 'object') throw new Error('non_plain_object');
    if (active.has(input)) throw new Error('cyclic');
    active.add(input);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new Error('non_plain_object');
    if (Object.getOwnPropertySymbols(input).length > 0) throw new Error('symbol_key');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const output: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length' && Array.isArray(input)) continue;
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) throw new Error('accessor');
      Object.defineProperty(output, key, {
        value: detach(descriptor.value), enumerable: true, configurable: true, writable: true,
      });
    }
    active.delete(input);
    return output;
  };
  try {
    return { snapshot: detach(value) as T };
  } catch (error) {
    return { error: error instanceof Error && (error.message === 'accessor' || error.message === 'non_plain_object'
      || error.message === 'symbol_key' || error.message === 'cyclic') ? error.message : 'non_plain_object' };
  }
}
