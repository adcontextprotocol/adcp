import { types } from 'node:util';

/**
 * Detach hostile JSON-shaped input without ever reading a value through the
 * object.  `structuredClone` is intentionally not used here: it invokes
 * getters before it rejects them.  Node exposes proxy identity without
 * invoking user traps, which lets this boundary fail before reflection.
 */
export function snapshotFixedTraceJson(value: unknown, label: string): unknown {
  // Track only the active ancestry: aliases may be copied as separate JSON
  // subtrees, while an actual cycle has no JSON representation and must fail
  // before recursion can exhaust the stack.
  const activeAncestors = new WeakSet<object>();
  const copy = (candidate: unknown, path: string): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error(`${path} contains a non-finite number`);
      return candidate;
    }
    if (typeof candidate !== 'object') throw new Error(`${path} is not JSON data`);
    if (types.isProxy(candidate)) throw new Error(`${path} must not contain a Proxy`);
    if (activeAncestors.has(candidate)) throw new Error(`${path} must not contain a cycle`);
    activeAncestors.add(candidate);

    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype || Object.getOwnPropertySymbols(candidate).length !== 0) {
          throw new Error(`${path} must be a plain array without symbols`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<string, PropertyDescriptor>;
        const lengthDescriptor = descriptors['length'];
        if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
          throw new Error(`${path} has an invalid array length descriptor`);
        }
        const length = lengthDescriptor.value as number;
        const output: unknown[] = [];
        for (const key of Object.keys(descriptors)) {
          if (key === 'length') continue;
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
            throw new Error(`${path} contains an extra array property`);
          }
        }
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            throw new Error(`${path}[${index}] must be an own enumerable data property`);
          }
          output.push(copy(descriptor.value, `${path}[${index}]`));
        }
        return output;
      }

      // Null-prototype records are this membrane's own detached output and
      // are also safe to snapshot again at composed plan/ledger boundaries.
      const prototype = Object.getPrototypeOf(candidate);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(candidate).length !== 0) {
        throw new Error(`${path} must be a plain object without symbols`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      // A null prototype makes __proto__ ordinary JSON data. Defining each
      // key also avoids every inherited setter, so it cannot disappear or
      // change the detached record's prototype before exact-key validation.
      const output = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!('value' in descriptor) || !descriptor.enumerable) {
          throw new Error(`${path}.${key} must be an own enumerable data property`);
        }
        Object.defineProperty(output, key, {
          value: copy(descriptor.value, `${path}.${key}`),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      activeAncestors.delete(candidate);
    }
  };
  return deepFreezeFixedTrace(copy(value, label));
}

/** Freeze only detached JSON data, never an object supplied by a caller. */
export function deepFreezeFixedTrace<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeFixedTrace(descriptor.value);
  }
  return Object.freeze(value);
}
