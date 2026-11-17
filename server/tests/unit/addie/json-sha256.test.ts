import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonSha256 } from '../../../src/addie/model-providers/json-sha256.js';
import {
  addieMatchedV4RouterWireSurface,
  addieMatchedV4WireSurface,
} from '../../../src/addie/eval/matched-v4-runtime-surface.js';

/** The definition jsonSha256 must always equal. */
function plainSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('jsonSha256', () => {
  it('equals the plain digest for frozen request envelopes, on first and repeated use', () => {
    const tools = addieMatchedV4WireSurface('broad', 'openai').tools;
    const system = addieMatchedV4WireSurface('broad', 'openai').system;
    for (let attempt = 0; attempt < 4; attempt++) {
      const envelope = Object.freeze({
        provider: 'openai',
        canonicalRequest: Object.freeze({
          model: 'gpt-test',
          maxOutputTokens: 900,
          system,
          messages: deepFreeze([{ role: 'user', content: [{ type: 'text', text: `prompt ${attempt}` }] }]),
          tools,
        }),
        wireRequest: Object.freeze({
          instructions: system.map((block) => block.text).join('\n\n'),
          tools,
        }),
      });
      expect(jsonSha256(envelope)).toBe(plainSha256(envelope));
    }
  });

  it('equals the plain digest for JSON edge values', () => {
    const longText = `${'x'.repeat(5000)}"\\ \u{1F600}\u0000`;
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: [true, null] });
    const values = [
      null, true, 0, -0, 1.5e300, -12, 'text', '', longText,
      deepFreeze({ '2': 'index-like keys first', b: -0, a: [0, '', longText], nested: nullPrototype }),
      deepFreeze([[], {}, [{}], longText, longText]),
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const value of values) expect(jsonSha256(value)).toBe(plainSha256(value));
    }
  });

  it('follows every mutation of a value that is not deep-frozen', () => {
    const child = { query: 'first' };
    const shell = Object.freeze({ tools: addieMatchedV4RouterWireSurface('openai').tools, child });
    const mutable = { list: [1, 2], text: 'a'.repeat(5000) };
    for (let round = 0; round < 3; round++) {
      expect(jsonSha256(shell)).toBe(plainSha256(shell));
      expect(jsonSha256(mutable)).toBe(plainSha256(mutable));
      const before = jsonSha256(shell);
      child.query = `changed ${round}`;
      mutable.list.push(round);
      mutable.text += 'b';
      expect(jsonSha256(shell)).not.toBe(before);
    }
    expect(jsonSha256(shell)).toBe(plainSha256(shell));
    expect(jsonSha256(mutable)).toBe(plainSha256(mutable));
  });

  it('keeps the plain behavior for values JSON.stringify drops or rejects', () => {
    const withUndefined = Object.freeze({ a: undefined, b: Object.freeze([undefined]) });
    expect(jsonSha256(withUndefined)).toBe(plainSha256(withUndefined));
    const withToJson = Object.freeze({ toJSON: () => ({ replaced: true }) });
    expect(jsonSha256(withToJson)).toBe(plainSha256(withToJson));
    const date = Object.freeze(new Date(0));
    expect(jsonSha256(date)).toBe(plainSha256(date));
    expect(() => jsonSha256(undefined)).toThrow(TypeError);
    expect(() => jsonSha256(Object.freeze({ big: 1n }))).toThrow(TypeError);
  });

  it('reuses the encoded bytes of a recurring frozen catalog instead of serializing it again', () => {
    const tools = addieMatchedV4WireSurface('clean', 'anthropic').tools;
    const envelope = () => Object.freeze({ provider: 'anthropic', tools });
    const expected = plainSha256(envelope());
    expect(jsonSha256(envelope())).toBe(expected);
    expect(jsonSha256(envelope())).toBe(expected);

    const stringify = vi.spyOn(JSON, 'stringify');
    expect(jsonSha256(envelope())).toBe(expected);
    // Only the fresh envelope is serialized: its two keys and one string value.
    expect(stringify).toHaveBeenCalledTimes(3);
  });
});
