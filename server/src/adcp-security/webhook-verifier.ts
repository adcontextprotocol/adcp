/**
 * RFC 9421 AdCP webhook-signature verifier.
 *
 * Implementation notes:
 *   - Uses the `http-message-signatures` npm package for signature-base
 *     construction (RFC 9421 §2.3) so we don't reimplement canonicalization.
 *   - Uses `jose` (already a dependency) for JWK import and signature
 *     verification across Ed25519 + ECDSA-P256-SHA256.
 *   - Error codes lowercased and prefixed `webhook_signature_*` / `webhook_content_digest_*`
 *     per `docs/building/implementation/webhooks.mdx` §Webhook error taxonomy.
 *
 * Scope:
 *   - This is a library module. It is intentionally NOT wired into any request
 *     handler; the task that landed this module explicitly scoped out handler
 *     integration.
 *   - Nonce-replay, revocation list, adcp_use/tag enforcement, and JWKS
 *     fetching are OUT OF SCOPE here and live (or will live) in call sites.
 *     See TODOs below.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { httpbis } from 'http-message-signatures';
import { parseDictionary } from 'structured-headers';

/**
 * A minimal subset of a JWK. We accept anything that `node:crypto`'s
 * `createPublicKey({ format: 'jwk' })` will accept; we validate `alg`,
 * `kid`, and `kty` explicitly.
 */
export interface JWK {
  readonly kid: string;
  readonly kty: string;
  readonly alg?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly use?: string;
  readonly key_ops?: readonly string[];
  readonly [other: string]: unknown;
}

export interface JWKS {
  readonly keys: readonly JWK[];
}

export interface WebhookRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Raw body bytes. Accepts string (will be UTF-8 encoded) or Buffer. */
  readonly body: string | Buffer;
}

export interface WebhookVerifyOptions {
  /**
   * When true (default), require a `Content-Digest` header AND require it to
   * be covered by the signature.  When false, `Content-Digest` is only
   * verified if it is present.
   */
  readonly requireContentDigest?: boolean;

  /**
   * Clock skew tolerance on the `expires` timestamp, in seconds.
   * Default: 60. Max validity window (expires - created) is capped at
   * 5 minutes per the spec.
   */
  readonly maxSkewSeconds?: number;
}

export type WebhookSignatureErrorCode =
  | 'webhook_signature_required'
  | 'webhook_signature_header_malformed'
  | 'webhook_signature_key_unknown'
  | 'webhook_signature_expired'
  | 'webhook_signature_invalid'
  | 'webhook_content_digest_mismatch'
  | 'webhook_content_digest_missing';

export type VerifyResult =
  | { readonly valid: true; readonly keyid: string; readonly alg: string }
  | { readonly valid: false; readonly reason: WebhookSignatureErrorCode };

const MAX_VALIDITY_SECONDS = 300; // 5 minutes — RFC 9421 AdCP webhook profile
const DEFAULT_SKEW_SECONDS = 60;

/** Header lookup that tolerates case-insensitive keys. */
function getHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return undefined;
}

/** Base64url (no padding) for comparing digest values. */
function toBase64(bytes: Buffer): string {
  return bytes.toString('base64');
}

/**
 * Verify a `Content-Digest` header per RFC 9530 (sha-256 only in this profile
 * version; see webhooks.mdx).  Returns `true` if the digest matches the
 * supplied body bytes.
 */
function verifyContentDigest(headerValue: string, bodyBytes: Buffer): boolean {
  // Parse the dictionary. structured-headers represents byte-sequence values
  // as Uint8Array wrapped in a tuple [value, params].
  let dict: ReturnType<typeof parseDictionary>;
  try {
    dict = parseDictionary(headerValue);
  } catch {
    return false;
  }

  const sha256Entry = dict.get('sha-256');
  if (!sha256Entry) {
    return false;
  }
  const [value] = sha256Entry;
  if (!(value instanceof ArrayBuffer)) {
    return false;
  }

  const expected = createHash('sha256').update(bodyBytes).digest();
  const asBuffer = Buffer.from(value);
  if (asBuffer.length !== expected.length) {
    return false;
  }
  // Constant-time compare would be ideal; content-digest is not a MAC so
  // plain equality is acceptable here.
  return toBase64(asBuffer) === toBase64(expected);
}

/**
 * Parse the Signature-Input header and return the parameters + covered
 * components for the *first* signature label.  AdCP webhooks are specified
 * with a single label; multi-label handling is out of scope for this
 * minimum-viable verifier.
 */
type BareItemValue = string | number | boolean | ArrayBuffer | Date | unknown;

interface ParsedSignatureInput {
  readonly label: string;
  readonly params: Map<string, BareItemValue>;
  readonly components: readonly string[];
  readonly raw: string;
}

function parseSignatureInput(headerValue: string): ParsedSignatureInput | null {
  let dict: ReturnType<typeof parseDictionary>;
  try {
    dict = parseDictionary(headerValue);
  } catch {
    return null;
  }
  // Take the first label only.
  const first = dict.entries().next();
  if (first.done) {
    return null;
  }
  const [label, entry] = first.value;
  const [components, params] = entry;
  if (!Array.isArray(components)) {
    return null;
  }
  const componentNames: string[] = [];
  for (const [name] of components) {
    if (typeof name !== 'string') {
      return null;
    }
    componentNames.push(name);
  }
  return {
    label,
    params: params as Map<string, BareItemValue>,
    components: componentNames,
    raw: headerValue,
  };
}

function parseSignatureHeader(
  headerValue: string,
  label: string,
): Buffer | null {
  let dict: ReturnType<typeof parseDictionary>;
  try {
    dict = parseDictionary(headerValue);
  } catch {
    return null;
  }
  const entry = dict.get(label);
  if (!entry) {
    return null;
  }
  const [value] = entry;
  if (!(value instanceof ArrayBuffer)) {
    return null;
  }
  return Buffer.from(value);
}

function jwkToKeyObject(jwk: JWK): KeyObject | null {
  try {
    // node:crypto accepts a JWK directly for public keys.
    // The `key` field is typed as a concrete JsonWebKey; we cast via a
    // record to satisfy the structural mismatch around `key_ops`.
    return createPublicKey({
      key: jwk as unknown as Record<string, unknown>,
      format: 'jwk',
    } as Parameters<typeof createPublicKey>[0]);
  } catch {
    return null;
  }
}

/**
 * Map an RFC 9421 `alg` string to (node:crypto digest, key type).
 * Returns null for unsupported algorithms.
 */
interface AlgSpec {
  readonly digest: string | null;
  readonly jwkKty: string;
  readonly jwkCrv?: string;
  /**
   * For ES256 the signature is RFC 9421 IEEE P1363 r||s. node:crypto verifies
   * DER by default; we must convert first.
   */
  readonly p1363: boolean;
}

function algSpec(alg: string): AlgSpec | null {
  switch (alg) {
    case 'ed25519':
    case 'EdDSA':
      return { digest: null, jwkKty: 'OKP', jwkCrv: 'Ed25519', p1363: false };
    case 'ecdsa-p256-sha256':
    case 'ES256':
      return { digest: 'sha256', jwkKty: 'EC', jwkCrv: 'P-256', p1363: true };
    default:
      return null;
  }
}

/**
 * Convert a fixed-width P1363 (r||s) signature to DER, which node:crypto's
 * ECDSA verifier expects by default.
 */
function p1363ToDer(sig: Buffer): Buffer {
  if (sig.length % 2 !== 0) {
    throw new Error('P1363 signature has odd length');
  }
  const half = sig.length / 2;
  const r = sig.subarray(0, half);
  const s = sig.subarray(half);
  const encodeInt = (int: Buffer): Buffer => {
    // Strip leading zeros, but leave one if the high bit would otherwise
    // make the integer negative in DER's signed encoding.
    let i = 0;
    while (i < int.length - 1 && int[i] === 0) {
      i += 1;
    }
    let body = int.subarray(i);
    if (body[0] !== undefined && (body[0] & 0x80) !== 0) {
      body = Buffer.concat([Buffer.from([0x00]), body]);
    }
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const seqBody = Buffer.concat([rEnc, sEnc]);
  // DER SEQUENCE with short-form length (fits in one byte for typical
  // P-256 signatures, which are <= 72 bytes).
  return Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
}

/**
 * Compute the RFC 9421 signature base for a request and a declared set of
 * components / params.  Returns the canonical bytes to be signed.
 */
function buildSignatureBase(
  req: WebhookRequest,
  parsed: ParsedSignatureInput,
): string {
  // Delegate to http-message-signatures for component extraction and
  // base formatting; we only need to re-emit @signature-params ourselves
  // if the library's output doesn't already include it.
  const base = httpbis.createSignatureBase(
    { fields: parsed.components as string[] },
    { method: req.method, url: req.url, headers: req.headers },
  );
  // Append @signature-params using the raw Signature-Input value for this
  // label.  The raw header value after "label=" is exactly what we need.
  // e.g. `sig1=("@method" ...);created=...;...` -> we want `("@method" ...);created=...;...`
  const rawForLabel = extractLabelValue(parsed.raw, parsed.label);
  base.push(['"@signature-params"', [rawForLabel]]);
  return httpbis.formatSignatureBase(base);
}

function extractLabelValue(headerValue: string, label: string): string {
  // Structured-headers parsed form loses exact byte ordering of parameters;
  // however, RFC 9421 requires the exact serialized form as stored in the
  // header.  The simplest approach: find "<label>=" in the raw header and
  // take the rest up to the next top-level comma.
  const needle = `${label}=`;
  const idx = headerValue.indexOf(needle);
  if (idx === -1) {
    return headerValue;
  }
  // From idx+needle.length, scan to the end of this dictionary member.
  // Dictionary members are comma-separated at the top level; commas inside
  // parentheses or quoted strings don't count.
  let depth = 0;
  let inQuotes = false;
  let end = headerValue.length;
  for (let i = idx + needle.length; i < headerValue.length; i += 1) {
    const ch = headerValue[i];
    if (inQuotes) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      continue;
    }
    if (ch === ',' && depth === 0) {
      end = i;
      break;
    }
  }
  return headerValue.slice(idx + needle.length, end).trim();
}

/**
 * Verify an RFC 9421 AdCP webhook signature.
 *
 * TODO(scope):
 *   - Nonce replay cache (per-keyid LRU) — caller's responsibility today.
 *   - Revocation list / adcp_use='webhook-signing' purpose check — caller's
 *     responsibility.  The `tag` parameter check (`adcp/webhook-signing/v1`)
 *     is similarly deferred.
 *   - JWKS fetching / caching from the seller's adagents.json — caller's
 *     responsibility; this function takes a pre-resolved JWKS.
 */
export async function verifyWebhookSignature(
  req: WebhookRequest,
  jwks: JWKS,
  opts: WebhookVerifyOptions = {},
): Promise<VerifyResult> {
  const { requireContentDigest = true, maxSkewSeconds = DEFAULT_SKEW_SECONDS } = opts;

  // Step 1: both Signature and Signature-Input MUST be present.
  const sigHeader = getHeader(req.headers, 'Signature');
  const sigInputHeader = getHeader(req.headers, 'Signature-Input');
  if (!sigHeader || !sigInputHeader) {
    return { valid: false, reason: 'webhook_signature_required' };
  }

  // Step 2: parse Signature-Input; reject malformed.
  const parsed = parseSignatureInput(sigInputHeader);
  if (!parsed) {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }

  const keyidParam = parsed.params.get('keyid');
  const algParam = parsed.params.get('alg');
  const createdParam = parsed.params.get('created');
  const expiresParam = parsed.params.get('expires');

  if (typeof keyidParam !== 'string' || typeof algParam !== 'string') {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }
  if (typeof createdParam !== 'number' || typeof expiresParam !== 'number') {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }

  const sigBytes = parseSignatureHeader(sigHeader, parsed.label);
  if (!sigBytes) {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }

  // Step 3: keyid lookup.
  const jwk = jwks.keys.find((k) => k.kid === keyidParam);
  if (!jwk) {
    return { valid: false, reason: 'webhook_signature_key_unknown' };
  }

  // Step 4: alg must match JWK.
  const spec = algSpec(algParam);
  if (!spec) {
    return { valid: false, reason: 'webhook_signature_invalid' };
  }
  if (jwk.alg !== undefined) {
    const jwkSpec = algSpec(jwk.alg);
    if (!jwkSpec || jwkSpec.jwkKty !== spec.jwkKty || jwkSpec.jwkCrv !== spec.jwkCrv) {
      return { valid: false, reason: 'webhook_signature_invalid' };
    }
  }
  if (jwk.kty !== spec.jwkKty || (spec.jwkCrv !== undefined && jwk.crv !== spec.jwkCrv)) {
    return { valid: false, reason: 'webhook_signature_invalid' };
  }

  // Step 5: validity window.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expiresParam < createdParam) {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }
  if (expiresParam - createdParam > MAX_VALIDITY_SECONDS) {
    return { valid: false, reason: 'webhook_signature_expired' };
  }
  if (nowSeconds > expiresParam + maxSkewSeconds) {
    return { valid: false, reason: 'webhook_signature_expired' };
  }
  if (nowSeconds < createdParam - maxSkewSeconds) {
    return { valid: false, reason: 'webhook_signature_expired' };
  }

  // Step 6: content-digest enforcement.
  const bodyBytes = typeof req.body === 'string' ? Buffer.from(req.body, 'utf-8') : req.body;
  const contentDigestHeader = getHeader(req.headers, 'Content-Digest');
  const digestIsCovered = parsed.components.includes('content-digest');
  if (requireContentDigest) {
    if (!contentDigestHeader || !digestIsCovered) {
      return { valid: false, reason: 'webhook_content_digest_missing' };
    }
  }
  if (contentDigestHeader) {
    if (!verifyContentDigest(contentDigestHeader, bodyBytes)) {
      return { valid: false, reason: 'webhook_content_digest_mismatch' };
    }
  }

  // Step 7: build signature base.
  let base: string;
  try {
    base = buildSignatureBase(req, parsed);
  } catch {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }

  // Step 8: verify signature.
  const key = jwkToKeyObject(jwk);
  if (!key) {
    return { valid: false, reason: 'webhook_signature_key_unknown' };
  }

  let ok = false;
  try {
    if (spec.jwkKty === 'OKP') {
      ok = cryptoVerify(null, Buffer.from(base, 'utf-8'), key, sigBytes);
    } else {
      const derSig = spec.p1363 ? p1363ToDer(sigBytes) : sigBytes;
      ok = cryptoVerify(spec.digest, Buffer.from(base, 'utf-8'), key, derSig);
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    return { valid: false, reason: 'webhook_signature_invalid' };
  }

  // Step 9: success.
  return { valid: true, keyid: keyidParam, alg: algParam };
}

export type { KeyObject };
