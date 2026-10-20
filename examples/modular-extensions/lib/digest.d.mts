// Types for lib/digest.mjs: RFC 8785 (JCS) serialization and the digests built on it.
export function jcs(value: unknown): string;
export const DIGEST_RE: RegExp;
export function sha256Digest(bytes: Uint8Array | string): string;
/** SHA-256 of the JCS serialization of a parsed JSON value. */
export function digestOfValue(value: unknown): string;
export function refKey(uri: string, digest: string): string;
/** AdCP terms_digest: SHA-256 of JCS(commercial_terms), base64url, prefixed. */
export function termsDigest(commercialTerms: object): string;
