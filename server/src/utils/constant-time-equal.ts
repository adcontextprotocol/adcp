import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare for ASCII secrets. Intended for comparing
 * attacker-supplied input against a fixed server-side secret.
 *
 * On length mismatch, runs a same-length dummy compare so total work is
 * O(len(input)), not O(len(secret)). This leaks the attacker's chosen input
 * length, which is already public, but never the server-side secret's length.
 *
 * Do not use this to compare two attacker-controlled values. The timing model
 * assumes one side is a fixed server-side ASCII secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'latin1');
  const bBuf = Buffer.from(b, 'latin1');
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
