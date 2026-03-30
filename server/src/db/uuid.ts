import { randomBytes } from 'node:crypto';

/**
 * Generate a UUID v7 (RFC 9562) — time-ordered UUID.
 *
 * Layout:
 *   48 bits: unix timestamp in milliseconds
 *    4 bits: version (0b0111 = 7)
 *   12 bits: random
 *    2 bits: variant (0b10)
 *   62 bits: random
 *
 * This gives sequential ordering by creation time (better B-tree locality
 * than random v4 UUIDs) while remaining globally unique.
 */
export function uuidv7(): string {
  const now = Date.now();
  const bytes = randomBytes(16);

  // Timestamp: 48 bits of unix ms in bytes 0-5
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7: set bits 48-51 to 0b0111
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Variant: set bits 64-65 to 0b10
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
