import { createHash, type Hash } from 'node:crypto';
import { isDeepFrozenJsonData } from './capabilities.js';

/**
 * SHA-256 of JSON.stringify(value) as UTF-8, hex encoded: always exactly
 * createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').
 *
 * When `value` is proven deep-frozen JSON data (isDeepFrozenJsonData), the
 * same bytes are fed to the hash in pieces, and the UTF-8 bytes of subtrees
 * and long strings that recur across calls (a tool catalog, a system prompt)
 * are encoded once and reused. For such data JSON.stringify is a fixed
 * function of the value: keys in Object.keys order, each key and primitive
 * through JSON.stringify, no undefined, function, accessor or toJSON value
 * anywhere, so emitting it piecewise produces the identical byte sequence.
 * (A global change such as a later Object.prototype.toJSON is outside this
 * equivalence.) Any other value takes the plain path.
 */
export function jsonSha256(value: unknown): string {
  const hash = createHash('sha256');
  if (!isDeepFrozenJsonData(value)) {
    return hash.update(JSON.stringify(value), 'utf8').digest('hex');
  }
  new FrozenJsonHashWriter(hash).write(value);
  return hash.digest('hex');
}

// Reuse is limited to values that recur across calls (seen in an earlier
// call), so a one-off request envelope is walked, never encoded whole, even
// when it occurs twice in one value (a wire request that is the canonical
// request itself). Frozen objects are keys of weak maps; long strings (keyed
// by value) are bounded and never evicted.
const seenObjects = new WeakSet<object>();
const objectBytes = new WeakMap<object, Buffer>();
const LONG_STRING_CHARS = 4096;
const MAX_REUSED_STRINGS = 512;
const seenStrings = new Set<string>();
const stringBytes = new Map<string, Buffer>();

class FrozenJsonHashWriter {
  private pending = '';
  private readonly firstSeenObjects: object[] = [];
  private readonly firstSeenStrings: string[] = [];

  constructor(private readonly hash: Hash) {}

  write(value: unknown): void {
    this.emit(value);
    this.flush();
    for (const object of this.firstSeenObjects) seenObjects.add(object);
    for (const text of this.firstSeenStrings) {
      if (seenStrings.size >= MAX_REUSED_STRINGS) break;
      seenStrings.add(text);
    }
  }

  private flush(): void {
    if (this.pending) {
      this.hash.update(this.pending, 'utf8');
      this.pending = '';
    }
  }

  private bytes(chunk: Buffer): void {
    this.flush();
    this.hash.update(chunk);
  }

  private emit(value: unknown): void {
    if (typeof value === 'string' && value.length >= LONG_STRING_CHARS) {
      const known = stringBytes.get(value);
      if (known) return this.bytes(known);
      if (seenStrings.has(value) && stringBytes.size < MAX_REUSED_STRINGS) {
        const encoded = Buffer.from(JSON.stringify(value), 'utf8');
        stringBytes.set(value, encoded);
        return this.bytes(encoded);
      }
      this.firstSeenStrings.push(value);
      this.pending += JSON.stringify(value);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      this.pending += JSON.stringify(value);
      return;
    }
    const known = objectBytes.get(value);
    if (known) return this.bytes(known);
    if (seenObjects.has(value)) {
      const encoded = Buffer.from(JSON.stringify(value), 'utf8');
      objectBytes.set(value, encoded);
      return this.bytes(encoded);
    }
    this.firstSeenObjects.push(value);
    if (Array.isArray(value)) {
      this.pending += '[';
      for (let index = 0; index < value.length; index++) {
        if (index > 0) this.pending += ',';
        this.emit(value[index]);
      }
      this.pending += ']';
      return;
    }
    this.pending += '{';
    let first = true;
    for (const key of Object.keys(value)) {
      if (!first) this.pending += ',';
      first = false;
      this.pending += `${JSON.stringify(key)}:`;
      this.emit((value as Record<string, unknown>)[key]);
    }
    this.pending += '}';
  }
}
