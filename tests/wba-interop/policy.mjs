/**
 * The AdCP Web Bot Auth profile's rules, written as the hooks that Cloudflare's
 * `web-bot-auth` and `http-message-sig` libraries expose.
 *
 * The library enforces the Web Bot Auth (WBA) rules itself. This file holds only
 * what the profile adds, one section per row of the "Profile rules" table in
 * docs/building/by-layer/L1/wba-profile.mdx, in the table's order. A reviewer
 * reads this file to see everything AdCP adds to WBA.
 *
 * Some rows are WBA MUSTs that the pinned library does not enforce (an `https`
 * origin, no path in the origin, a member keyed to the signature label, the
 * directory media type). They live here until the library enforces them; the
 * harness's tier check reports the day it does.
 *
 * Two AdCP checks run outside the WBA verifier and are not here: the revocation
 * list and the contents of `Accept-Signature` (security.mdx, "AdCP checks after
 * Web Bot Auth verification").
 */
import { createHash } from 'node:crypto';
import { component, isSignatureError } from 'http-message-sig';
import { parseDictionary } from 'structured-headers';
import { HTTP_MESSAGE_SIGNATURES_DIRECTORY, HTTP_MESSAGE_SIGNATURE_TAG } from 'web-bot-auth';

/** A refusal with the status the profile answers (row "Failure responses"). */
export class PolicyError extends Error {
  constructor(status, rule, message) {
    super(message);
    this.status = status;
    this.rule = rule;
  }
}
const refuse = (rule, message) => {
  throw new PolicyError(403, rule, message);
};

export const header = (headers, name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
const componentName = c => (typeof c === 'string' ? c : c.name);

// ── Row "Signature" ───────────────────────────────────────────────────────
// The library checks the tag, the thumbprint keyid, and that exactly one
// `signature-agent` member is covered. The profile adds that the covered
// member is the one keyed to the signature label (WBA 5.2.1), and recognizes
// only `type=directory`, which the library reads as a Token or a String.

/**
 * The covered member the library resolved the key from is the one keyed to the
 * signature's label (WBA 5.2.1). Covering the whole field as well is allowed.
 */
function checkMemberKeyedToLabel(result) {
  const key = result.signatureAgent.label;
  if (key !== result.label) refuse('signature-agent-label', `covered Signature-Agent member ${key} is not keyed to label ${result.label}`);
}

// ── Row "Signature-Agent value" ───────────────────────────────────────────
// The value is exactly the ASCII serialization of an `https` origin (RFC 6454
// section 6.2), compared as a string without normalizing, and anything else is
// refused with 403. WBA requires `https` (5.2.1; cloudflare/web-bot-auth#162)
// and an origin with no path (5.5), and the library checks neither. WBA permits
// an empty path `/` and compares identifiers after normalizing (5.5), so
// refusing a trailing `/`, an uppercase host, or `:443` is the profile's choice.

/** Checks the covered Signature-Agent member before its directory is read. */
export function checkSignatureAgent(entry) {
  if (entry.type !== 'directory') refuse('signature-agent-type', `Signature-Agent type ${entry.type} is not directory`);
  let url;
  try {
    url = new URL(entry.uri);
  } catch {
    refuse('signature-agent-origin', `Signature-Agent ${entry.uri} is not a URL`);
  }
  if (url.protocol !== 'https:') refuse('signature-agent-origin', `Signature-Agent ${entry.uri} is not https`);
  // The value is the ASCII serialization of the origin (RFC 6454 section 6.2): no path, query, fragment, or userinfo.
  if (entry.uri !== url.origin) refuse('signature-agent-origin', `Signature-Agent ${entry.uri} is not a serialized origin`);
}

// ── Rows "Components, every request" and "Components, requests with a body" ─

export function requiredComponents(request) {
  const names = ['@method', '@target-uri', '@authority'];
  if (request.body) names.push('content-type', 'content-digest');
  return names;
}

/** True when the Content-Digest field's sha-256 member is the digest of `body` (RFC 9530). */
export function digestMatches(field, body) {
  if (field === undefined) return false;
  let member;
  try {
    member = parseDictionary(field).get('sha-256');
  } catch {
    return false;
  }
  if (!member || !(member[0] instanceof ArrayBuffer)) return false;
  return Buffer.from(member[0]).equals(createHash('sha256').update(body).digest());
}

// ── Row "Parameters" ──────────────────────────────────────────────────────
// The library requires created, expires, keyid, alg, and tag, and checks that a
// nonce is 64 bytes as unpadded base64url or canonical padded base64
// (`validateNonce`). The profile adds that the nonce is present.

// ── Row "Algorithm" ───────────────────────────────────────────────────────

export const ALGORITHMS = ['ed25519'];

// ── Row "Lifetime and clock skew" ─────────────────────────────────────────

export const MAX_LIFETIME = 300;
export const CLOCK_SKEW = 60;

/** The `validate` hook for `verify()`: the request-level rules of the rows above. */
export function validate(result, request) {
  checkMemberKeyedToLabel(result);
  const covered = result.components.map(componentName);
  for (const name of requiredComponents(request)) {
    if (!covered.includes(name)) refuse('components', `${name} is not covered`);
  }
  if (request.body && !digestMatches(header(request.headers, 'content-digest'), request.body)) {
    refuse('content-digest', 'Content-Digest does not match the body');
  }
  if (typeof result.nonce !== 'string') refuse('nonce', 'nonce is required on every signed request');
  if (result.parameters.expires - result.parameters.created > MAX_LIFETIME) {
    refuse('lifetime', `expires is more than ${MAX_LIFETIME} s after created`);
  }
  return true;
}

// ── Row "Key publication" ─────────────────────────────────────────────────
// Key lookup is by (origin, keyid), never by keyid alone (WBA 5.4): the
// resolver reads only the directory of the origin the covered member names.
// Each signing key is an Ed25519 key.

/** True for a key the profile uses: the library imports it and its algorithm is allowed. */
export const usable = verifier => verifier !== undefined && ALGORITHMS.includes(verifier.algorithm);

/**
 * WBA section 6.8: verifiers SHOULD reject published test keys. The harness
 * signs with the keys in keys.json, so the judge accepts them; a production
 * verifier passes those kids here.
 */
export function checkNotTestKey(keyid, rejectKids = []) {
  if (rejectKids.includes(keyid)) refuse('test-key', `${keyid} is a published test key`);
}

// ── Row "Directory responses" ─────────────────────────────────────────────
// Served with the directory media type. One signature per Ed25519 key, covering
// "@authority";req and content-digest, with created, expires, keyid, and the
// directory tag. Keys the profile does not use, and their signatures, are
// ignored (RFC 7517 section 5). Content-Digest matches the body (Appendix B.1).

export const DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
export const DIRECTORY_TAG = 'http-message-signatures-directory';

export function checkDirectoryMediaType(response) {
  const type = header(response.headers, 'content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== DIRECTORY_MEDIA_TYPE) refuse('directory-media-type', `directory media type ${type}`);
}

/** The `verifySignature` policy for one directory signature (WBA Appendix B.1). */
export const directorySignaturePolicy = now => ({
  algorithms: ALGORITHMS,
  now,
  clockSkew: 0,
  requiredComponents: [component('@authority', { req: true }), 'content-digest'],
  requiredParameters: ['created', 'expires', 'keyid', 'tag'],
  validate: v => v.parameters.tag === DIRECTORY_TAG || refuse('directory-tag', `directory signature tag ${v.parameters.tag}`),
});

/** The label of the one signature by `keyid`, or a refusal. Labels by other keys are never read. */
export function directoryLabelFor(signatureInput, keyid) {
  const labels = [...signatureInput].filter(([, [, params]]) => params.get('keyid') === keyid).map(([label]) => label);
  if (labels.length !== 1) refuse('directory-one-signature-per-key', `${labels.length} directory signatures by ${keyid}`);
  return labels[0];
}

export function checkDirectoryBody(response, verifiedKeyids) {
  if (!digestMatches(header(response.headers, 'content-digest'), response.body)) {
    refuse('directory-content-digest', 'directory Content-Digest does not match the body');
  }
  if (verifiedKeyids.length === 0) refuse('directory-no-usable-key', 'the directory holds no Ed25519 key');
}

// ── Row "Fetches" ─────────────────────────────────────────────────────────
// The harness serves directories from data, so the network rules (HTTPS,
// resolved-address checks, no redirects, size and time limits) and caching are
// not exercised here. The rule that the status is 200 is.

export const directoryUrl = origin => `${new URL(origin).origin}${HTTP_MESSAGE_SIGNATURES_DIRECTORY}`;

export function checkDirectoryStatus(response) {
  if (response.status !== 200) refuse('directory-status', `directory status ${response.status}`);
}

// ── Row "One signature" ───────────────────────────────────────────────────
// Exactly one web-bot-auth signature and one Signature-Agent member. Members
// with other tags are not read. The library selects no label by tag and
// requires one when a request carries several, so the profile selects it.

/**
 * Parses the three signature fields (verification step 1, `400` on failure),
 * then returns the label of the one web-bot-auth signature. The library then
 * checks every member's shape, whatever its tag (RFC 9421 sections 4.1 and 4.2).
 */
export function selectLabel(request) {
  let input;
  let agents;
  try {
    for (const name of ['signature', 'signature-input', 'signature-agent']) {
      const value = header(request.headers, name);
      if (value === undefined) refuse('missing-field', `no ${name} field`);
      const parsed = parseDictionary(value);
      if (name === 'signature-input') input = parsed;
      if (name === 'signature-agent') agents = parsed;
    }
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    throw new PolicyError(400, 'parse', e.message);
  }
  const tagged = [...input].filter(([, [, params]]) => params.get('tag') === HTTP_MESSAGE_SIGNATURE_TAG).map(([label]) => label);
  if (tagged.length !== 1) refuse('one-signature', `${tagged.length} web-bot-auth signatures`);
  if (agents.size !== 1) refuse('one-signature-agent', `${agents.size} Signature-Agent members`);
  return tagged[0];
}

// ── Row "Failure responses" ───────────────────────────────────────────────
// 400 when a signature field does not parse, 429 for a reused nonce, 403
// otherwise (WBA 5.3 and 5.4).

export function statusOf(error) {
  const cause = error?.cause;
  if (error instanceof PolicyError) return error.status;
  if (cause instanceof PolicyError) return cause.status;
  if (isSignatureError(error) && (error.code === 'MalformedField' || error.code === 'DuplicateLabel')) return 400;
  return 403;
}

// ── Replay protection ─────────────────────────────────────────────────────
// A nonce seen before for the same identity is refused with 429.

export class ReplayStore {
  #seen = new Set();

  check(identity, nonce) {
    const entry = `${identity} ${nonce}`;
    if (this.#seen.has(entry)) throw new PolicyError(429, 'replay', `nonce seen before for ${identity}`);
    this.#seen.add(entry);
  }
}
