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

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
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
  | {
      readonly valid: true;
      readonly keyid: string;
      readonly alg: string;
      /**
       * The `tag` parameter from the Signature-Input header, if present.
       * Call sites SHOULD enforce `tag === 'adcp/webhook-signing/v1'` to
       * defend against cross-profile signature reuse. Enforcement is out of
       * scope for this verifier.
       */
      readonly tag?: string;
    }
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

/**
 * Verify a `Content-Digest` header per RFC 9530 (sha-256 only in this profile
 * version; see webhooks.mdx).  Returns `true` if the digest matches the
 * supplied body bytes.
 */
function verifyContentDigest(headerValue: string, bodyBytes: Buffer): boolean {
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
  // content-digest IS in the signature base for AdCP webhooks, so binding
  // body → sig does cross this compare. Use timing-safe compare unconditionally.
  return timingSafeEqual(asBuffer, expected);
}

/**
 * Parse the Signature-Input header and return the parameters + covered
 * components for the *first* signature label.  AdCP webhooks are specified
 * with a single label; multi-label handling is out of scope for this
 * minimum-viable verifier.
 */
type BareItemValue = string | number | boolean | ArrayBuffer | Date;

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
 * Map an `alg` string to (node:crypto digest, key type).
 * RFC 9421 Signature-Input `alg` uses IANA-registered names (RFC 9421 §6.2).
 * JWK `alg` uses JOSE names (RFC 7518 / RFC 8037). We accept each string
 * only in its proper context and never let JOSE names leak into the
 * Signature-Input `alg` parameter.
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
  /**
   * Fixed signature length (in bytes) for P1363-formatted algorithms. Used
   * to distinguish malformed signatures from valid-but-wrong signatures.
   */
  readonly p1363SigLen?: number;
}

function algSpecRfc9421(alg: string): AlgSpec | null {
  switch (alg) {
    case 'ed25519':
      return { digest: null, jwkKty: 'OKP', jwkCrv: 'Ed25519', p1363: false };
    case 'ecdsa-p256-sha256':
      return { digest: 'sha256', jwkKty: 'EC', jwkCrv: 'P-256', p1363: true, p1363SigLen: 64 };
    default:
      return null;
  }
}

function algSpecJwk(alg: string): AlgSpec | null {
  switch (alg) {
    case 'EdDSA':
      return { digest: null, jwkKty: 'OKP', jwkCrv: 'Ed25519', p1363: false };
    case 'ES256':
      return { digest: 'sha256', jwkKty: 'EC', jwkCrv: 'P-256', p1363: true, p1363SigLen: 64 };
    default:
      return null;
  }
}

/**
 * Convert a fixed-width P1363 (r||s) signature to DER, which node:crypto's
 * ECDSA verifier expects by default.  Throws if the signature length does
 * not match the expected width or if r/s are zero after stripping.
 */
function p1363ToDer(sig: Buffer, expectedLen: number): Buffer {
  if (sig.length !== expectedLen) {
    throw new Error(`P1363 signature length mismatch: expected ${expectedLen}, got ${sig.length}`);
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
    if (body.length === 0) {
      // r or s is zero — invalid ECDSA signature; refuse to encode a
      // DER integer with empty contents (decoders reject it too).
      throw new Error('P1363 signature component is zero');
    }
    if ((body[0] & 0x80) !== 0) {
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
  if (rawForLabel === null) {
    throw new Error('failed to locate signature label in Signature-Input');
  }
  base.push(['"@signature-params"', [rawForLabel]]);
  return httpbis.formatSignatureBase(base);
}

/**
 * Locate the raw value bytes for the member named `label` in a structured-
 * fields dictionary header.  We intentionally byte-slice rather than use the
 * parsed form, because RFC 9421 §2.5 requires `@signature-params` to be
 * re-emitted byte-for-byte as it appeared in the Signature-Input header.
 *
 * This anchors on top-level dictionary members (comma-separated) and matches
 * the label case-insensitively (RFC 8941 token rules).  Quoted strings,
 * parenthesized inner lists, and backslash escapes inside quoted strings
 * are respected so that e.g. a `nonce="...,sig1=..."` cannot fool the scan.
 */
function extractLabelValue(headerValue: string, label: string): string | null {
  const labelLower = label.toLowerCase();
  const s = headerValue;
  let memberStart = 0;
  let depth = 0;
  let inQuotes = false;

  const tryMember = (start: number, end: number): string | null => {
    // Strip leading/trailing OWS, split at the first `=` at depth 0 (there
    // should be no inner `=` at depth 0 before the value in a well-formed
    // dictionary member).
    let a = start;
    let b = end;
    while (a < b && (s[a] === ' ' || s[a] === '\t')) a += 1;
    while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
    const eq = s.indexOf('=', a);
    if (eq === -1 || eq >= b) return null;
    const name = s.slice(a, eq).trim();
    if (name.toLowerCase() !== labelLower) return null;
    return s.slice(eq + 1, b).trim();
  };

  for (let i = 0; i <= s.length; i += 1) {
    if (i === s.length) {
      const hit = tryMember(memberStart, i);
      if (hit !== null) return hit;
      break;
    }
    const ch = s[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < s.length) {
        // Skip the escaped char so that e.g. \" doesn't close the string.
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
      if (depth > 0) depth -= 1;
      continue;
    }
    if (ch === ',' && depth === 0) {
      const hit = tryMember(memberStart, i);
      if (hit !== null) return hit;
      memberStart = i + 1;
    }
  }
  return null;
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
export function verifyWebhookSignature(
  req: WebhookRequest,
  jwks: JWKS,
  opts: WebhookVerifyOptions = {},
): VerifyResult {
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
  const tagParam = parsed.params.get('tag');

  if (typeof keyidParam !== 'string' || typeof algParam !== 'string') {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }
  if (typeof createdParam !== 'number' || typeof expiresParam !== 'number') {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }
  if (tagParam !== undefined && typeof tagParam !== 'string') {
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

  // Step 4: alg must be a valid RFC 9421 name, and must describe the same
  // key shape as the JWK.  When the JWK declares its own `alg` (JOSE name),
  // that must also agree — this is the algorithm-confusion defense.
  const spec = algSpecRfc9421(algParam);
  if (!spec) {
    return { valid: false, reason: 'webhook_signature_invalid' };
  }
  if (jwk.alg !== undefined) {
    const jwkSpec = algSpecJwk(jwk.alg);
    if (!jwkSpec || jwkSpec.jwkKty !== spec.jwkKty || jwkSpec.jwkCrv !== spec.jwkCrv) {
      return { valid: false, reason: 'webhook_signature_invalid' };
    }
  }
  if (jwk.kty !== spec.jwkKty || (spec.jwkCrv !== undefined && jwk.crv !== spec.jwkCrv)) {
    return { valid: false, reason: 'webhook_signature_invalid' };
  }

  // Step 5: validity window. `expires - created > MAX_VALIDITY_SECONDS` is a
  // spec violation (the signer emitted a longer-than-permitted window), not
  // a clock-skew expiry — route to `header_malformed` so call sites can tell
  // the two apart.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expiresParam < createdParam) {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }
  if (expiresParam - createdParam > MAX_VALIDITY_SECONDS) {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
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

  // For P1363 algorithms, a wrong-length signature is a malformed header
  // (couldn't have been produced by a conforming signer) rather than an
  // invalid-signature outcome. Catch that before we try DER conversion.
  if (spec.p1363 && spec.p1363SigLen !== undefined && sigBytes.length !== spec.p1363SigLen) {
    return { valid: false, reason: 'webhook_signature_header_malformed' };
  }

  let ok = false;
  try {
    if (spec.jwkKty === 'OKP') {
      ok = cryptoVerify(null, Buffer.from(base, 'utf-8'), key, sigBytes);
    } else {
      const derSig = spec.p1363 ? p1363ToDer(sigBytes, spec.p1363SigLen ?? sigBytes.length) : sigBytes;
      ok = cryptoVerify(spec.digest, Buffer.from(base, 'utf-8'), key, derSig);
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    return { valid: false, reason: 'webhook_signature_invalid' };
  }

  // Step 9: success.
  return {
    valid: true,
    keyid: keyidParam,
    alg: algParam,
    ...(tagParam !== undefined ? { tag: tagParam } : {}),
  };
}

export type { KeyObject };
