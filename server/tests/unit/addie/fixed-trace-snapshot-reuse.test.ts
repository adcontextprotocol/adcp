import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIXED_TRACE_CORPUS,
  detachFixedTraceSnapshot,
  validateFixedTraceCorpus,
} from '../../../src/addie/eval/fixed-trace-corpus-evaluator.js';
import { canonicalFixedTraceText } from '../../../src/addie/eval/fixed-trace-corpus-contracts.js';

// tp-jyw.42: validation results stay exactly the same while work that is a
// pure function of unchanged data (a snapshot detach already did, a
// canonicalized string) is done once and reused. The counts below are work
// counts, not wall-clock limits.

function objectNodes(value: unknown, into: object[] = []): object[] {
  if (value && typeof value === 'object') {
    into.push(value);
    for (const nested of Object.values(value)) objectNodes(nested, into);
  }
  return into;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detachFixedTraceSnapshot reuse', () => {
  it('returns a deep-frozen snapshot equal to the input and leaves the input mutable', () => {
    const input = structuredClone(FIXED_TRACE_CORPUS);
    const { snapshot, error } = detachFixedTraceSnapshot(input);

    expect(error).toBeUndefined();
    expect(snapshot).toEqual(input);
    expect(snapshot).not.toBe(input);
    expect(objectNodes(input).every((node) => !Object.isFrozen(node))).toBe(true);

    const nodes = objectNodes(snapshot);
    expect(nodes.length).toBe(objectNodes(input).length);
    const unfrozen = nodes.filter((node) => !Object.isFrozen(node));
    expect(unfrozen).toHaveLength(0);
  });

  it('returns a snapshot it produced unchanged, including nested inside a fresh wrapper', () => {
    const first = detachFixedTraceSnapshot(structuredClone(FIXED_TRACE_CORPUS)).snapshot!;

    const again = detachFixedTraceSnapshot(first);
    expect(again.error).toBeUndefined();
    expect(again.snapshot).toBe(first);

    const wrapped = detachFixedTraceSnapshot([first[0], first[1]]);
    expect(wrapped.error).toBeUndefined();
    expect(Object.isFrozen(wrapped.snapshot)).toBe(true);
    expect(wrapped.snapshot![0]).toBe(first[0]);
    expect(wrapped.snapshot![1]).toBe(first[1]);
  });

  it('still rejects a proxy around a snapshot it produced and still normalizes null-prototype input', () => {
    const first = detachFixedTraceSnapshot(structuredClone(FIXED_TRACE_CORPUS)).snapshot!;
    expect(detachFixedTraceSnapshot(new Proxy(first, {})).error).toBe('proxy');
    expect(detachFixedTraceSnapshot([new Proxy(first[0], {})]).error).toBe('proxy');

    const nullPrototype = Object.freeze(Object.assign(Object.create(null), structuredClone(FIXED_TRACE_CORPUS[0])));
    const detached = detachFixedTraceSnapshot(nullPrototype);
    expect(detached.error).toBeUndefined();
    expect(detached.snapshot).not.toBe(nullPrototype);
    expect(Object.getPrototypeOf(detached.snapshot)).toBe(Object.prototype);
  });
});

describe('validateFixedTraceCorpus detaches each input node about once', () => {
  it('gives the same verdict on a mutable clone and reads each input node descriptors about once', () => {
    const expected = validateFixedTraceCorpus();
    const clone = structuredClone(FIXED_TRACE_CORPUS);
    const inputNodes = objectNodes(clone).length;

    const descriptorReads = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    const failures = validateFixedTraceCorpus(clone);
    const reads = descriptorReads.mock.calls.length;
    descriptorReads.mockRestore();

    expect(failures).toEqual(expected);
    // One full detach of the mutable input reads every node once; the
    // sub-validators then receive a snapshot detach produced and reuse it.
    expect(reads, `descriptor reads ${reads} for ${inputNodes} input nodes`)
      .toBeLessThanOrEqual(Math.ceil(inputNodes * 1.5));
  });
});

describe('canonicalFixedTraceText reuse', () => {
  it('returns a frozen result and the same object for the same string', () => {
    const tool = ['read', 'google', 'doc'].join('_');
    const first = canonicalFixedTraceText(tool);
    expect(first).toEqual({ text: 'read_google_doc', compact: 'readgoogledoc', malformedPercentEncoding: false });
    expect(Object.isFrozen(first)).toBe(true);
    expect(canonicalFixedTraceText(['read', 'google', 'doc'].join('_'))).toBe(first);

    const percent = canonicalFixedTraceText('50% discount');
    expect(percent).toEqual({ text: '50% discount', compact: '50discount', malformedPercentEncoding: false });
    expect(Object.isFrozen(percent)).toBe(true);
    expect(canonicalFixedTraceText('50% discount')).toBe(percent);
    const encoded = canonicalFixedTraceText('read%5fgoogle%5fdoc');
    expect(encoded.compact).toBe('readgoogledoc');
    expect(canonicalFixedTraceText('read%5fgoogle%5fdoc')).toBe(encoded);
    expect(canonicalFixedTraceText('read google doc')).not.toBe(first);
  });
});
