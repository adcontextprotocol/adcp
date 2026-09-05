import { isProxy } from 'node:util/types';

/**
 * Detach corpus input without invoking caller-defined getters. Validation only
 * reads this plain-data snapshot, so a mutable accessor cannot change data
 * after one validation pass has begun.
 */
export interface FixedTraceSnapshotResult<T> {
  readonly snapshot?: T;
  readonly error?: 'accessor' | 'array_extra_property' | 'array_hole' | 'cyclic' | 'non_enumerable'
    | 'non_finite_number' | 'non_plain_object' | 'proxy' | 'symbol_key';
}

export function detachFixedTraceSnapshot<T>(value: T): FixedTraceSnapshotResult<T> {
  const active = new WeakSet<object>();
  const detach = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('non_finite_number');
      return input;
    }
    if (!input || typeof input !== 'object') throw new Error('non_plain_object');
    // This check must precede every reflective operation: proxy traps are
    // caller code and must never participate in corpus validation.
    if (isProxy(input)) throw new Error('proxy');
    if (active.has(input)) throw new Error('cyclic');
    active.add(input);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new Error('non_plain_object');
    if (Object.getOwnPropertySymbols(input).length > 0) throw new Error('symbol_key');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const output: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : {};
    const arrayLength = Array.isArray(input) ? descriptors.length?.value : undefined;
    if (Array.isArray(input) && (!Number.isSafeInteger(arrayLength) || arrayLength < 0)) throw new Error('array_extra_property');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length' && Array.isArray(input)) continue;
      if (!descriptor.enumerable) throw new Error('non_enumerable');
      if (!('value' in descriptor)) throw new Error('accessor');
      if (Array.isArray(input) && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= arrayLength!)) {
        throw new Error('array_extra_property');
      }
      Object.defineProperty(output, key, {
        value: detach(descriptor.value), enumerable: true, configurable: true, writable: true,
      });
    }
    if (Array.isArray(input)) {
      for (let index = 0; index < arrayLength!; index++) {
        if (!Object.hasOwn(descriptors, String(index))) throw new Error('array_hole');
      }
    }
    active.delete(input);
    return output;
  };
  try {
    return { snapshot: detach(value) as T };
  } catch (error) {
    const knownErrors = new Set<NonNullable<FixedTraceSnapshotResult<T>['error']>>([
      'accessor', 'array_extra_property', 'array_hole', 'cyclic', 'non_enumerable',
      'non_finite_number', 'non_plain_object', 'proxy', 'symbol_key',
    ]);
    return { error: error instanceof Error && knownErrors.has(error.message as NonNullable<FixedTraceSnapshotResult<T>['error']>)
      ? error.message as NonNullable<FixedTraceSnapshotResult<T>['error']> : 'non_plain_object' };
  }
}
