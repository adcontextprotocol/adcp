/**
 * Keyed random draws. Each draw is a pure function of its key, so a cell's
 * noise does not depend on the order cells are generated in. Integer
 * arithmetic only, so every platform draws the same numbers.
 */

/** FNV-1a, 32-bit. */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(state: number): () => number {
  let a = state;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform draw in [0, 1). */
export function uniform(key: string): number {
  return mulberry32(hash32(key))();
}

/** An approximately standard normal draw (Irwin–Hall, twelve uniforms),
 * bounded to [-6, 6]. */
export function standardNormal(key: string): number {
  const next = mulberry32(hash32(key));
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += next();
  return sum - 6;
}
