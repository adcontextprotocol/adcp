// Digest scheme for extension bundles.
//
// AdCP today defines the platform-extension-ref digest as "SHA-256 of the
// response body" (product-format-declaration.json#format_schema), and both
// SDKs hash raw bytes (sdk-js format-schema/fetch.ts:264,
// sdk-python canonical_formats/references.py:289). That breaks for a
// definition embedded as a JSON value (the get_products `extensions` map),
// because an embedded value has no canonical bytes.
//
// This example reconciles the two: an extension bundle is PUBLISHED as its
// RFC 8785 (JCS) serialization. Then
//     sha256(served body) == sha256(JCS(parse(body))) == sha256(JCS(embedded value))
// so the existing raw-body check in the SDKs keeps working unchanged, and an
// embedded copy is verifiable too. terms_digest already uses JCS.
import { createHash } from 'node:crypto';

/** RFC 8785 JSON Canonicalization Scheme. Plain JSON values only. */
export function jcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
    return JSON.stringify(value); // ECMAScript Number serialization == RFC 8785 §3.2.2.3
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (typeof value === 'object') {
    // Sort by UTF-16 code units, which is what Array.prototype.sort does by default.
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
  }
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export function sha256Digest(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** Digest of a parsed JSON value (an embedded or bundled definition). */
export function digestOfValue(value) {
  return sha256Digest(Buffer.from(jcs(value), 'utf8'));
}

export const refKey = (uri, digest) => `${uri}@${digest}`;

/** AdCP terms_digest: sha256 of JCS(commercial_terms), base64url, prefixed (canonical-proposal.json). */
export function termsDigest(commercialTerms) {
  return 'sha256:' + createHash('sha256').update(jcs(commercialTerms), 'utf8').digest('base64url');
}
