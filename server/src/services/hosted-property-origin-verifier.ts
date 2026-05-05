/**
 * Hosted-property origin verifier.
 *
 * Confirms that an AAO-hosted publisher has placed an
 * `authoritative_location` stub at their own `/.well-known/adagents.json`
 * pointing at AAO's hosted URL. Once verified, the corresponding
 * `agent_publisher_authorizations` rows are promoted from
 * `source='aao_hosted'` to `source='adagents_json'` — buyers reading
 * the registry can then treat them as origin-attested.
 *
 * Trust model
 * -----------
 * AAO never sits behind the publisher's TLS. The publisher hosts the
 * adagents.json file at their own origin (so their TLS attests it);
 * the file may be a full document or a small stub with
 * `authoritative_location` pointing at an AAO URL. The buyer:
 *
 *   1. Fetches `https://{publisher}/.well-known/adagents.json`
 *      (publisher's TLS attests the response).
 *   2. If the body has `authoritative_location`, follows the pointer
 *      to fetch the canonical body (AAO's TLS attests THAT response).
 *   3. Trust chain: publisher origin attests the pointer, AAO attests
 *      the body, both via plain TLS.
 *
 * This verifier executes the same fetch from the server side as a
 * buy-side verifier would, and only promotes the source label when the
 * publisher's origin actually points at us.
 *
 * What counts as verified
 * -----------------------
 *   - Stub: `{ authoritative_location: "<our hosted URL>" }`. The URL
 *     must exactly match the canonical AAO-hosted URL we'd serve for
 *     this publisher. Trailing slashes and case in the path are
 *     normalized before compare.
 *   - Full document echo: the publisher serves a body equivalent to
 *     the AAO-hosted body. Rare in practice (why host with us if you
 *     also host yourself?) but valid — accept it.
 *
 * What does NOT count as verified
 * -------------------------------
 *   - 404 on the publisher origin (no document at all).
 *   - Document that fails JSON parsing.
 *   - `authoritative_location` pointing somewhere other than our URL.
 *   - Network errors / timeouts. We log and treat as failure but do
 *     NOT clear `origin_verified_at` — only an explicit publisher-
 *     origin response demotes. (Otherwise transient network issues
 *     would flip a verified publisher unverified.)
 */

import { safeFetch } from '../utils/url-security.js';
import { aaoHostedAdagentsJsonUrl, expectedAdagentsJsonUrl } from '../config/aao.js';
import { PropertyDatabase } from '../db/property-db.js';
import { promoteVerifiedAuthorizations, demotePreviouslyVerifiedAuthorizations } from './hosted-property-sync.js';
import { createLogger } from '../logger.js';
import type { HostedProperty } from '../types.js';

const logger = createLogger('hosted-property-origin-verifier');

/** Cap on response size we'll read from the publisher's origin. */
const MAX_RESPONSE_BYTES = 1_000_000;
/** Hard timeout on the publisher fetch. */
const FETCH_TIMEOUT_MS = 10_000;

export type VerificationOutcome =
  | { verified: true; reason: 'authoritative_location_pointer' | 'document_echo'; checked_at: Date }
  | { verified: false; reason: VerificationFailureReason; checked_at: Date; detail?: string };

export type VerificationFailureReason =
  | 'fetch_failed'
  | 'non_200_response'
  | 'invalid_json'
  | 'no_authoritative_location'
  | 'authoritative_location_mismatch'
  | 'transient'; // network / timeout — not actually a failure, leaves verified state alone

interface VerifyHostedOriginInput {
  hosted: HostedProperty;
  /** Override fetcher for tests. Production uses safeFetch. */
  fetchImpl?: (url: string) => Promise<{ status: number; body: string }>;
  /** Override DB writer for tests. */
  propertyDb?: { recordOriginVerification: PropertyDatabase['recordOriginVerification'] };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    let pathname = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return url.trim();
  }
}

async function defaultFetch(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { signal: controller.signal });
    // Stream-read up to MAX_RESPONSE_BYTES; treat oversize as failure.
    const reader = res.body?.getReader();
    if (!reader) {
      const body = await res.text();
      return { status: res.status, body: body.slice(0, MAX_RESPONSE_BYTES) };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function readManifestAgentUrls(adagents: Record<string, unknown>): string[] {
  const arr = Array.isArray(adagents.authorized_agents) ? adagents.authorized_agents : [];
  return arr
    .map((a: unknown) =>
      a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string'
        ? (a as { url: string }).url
        : null,
    )
    .filter((u): u is string => !!u);
}

/**
 * Run the verification round-trip for a hosted property and reflect the
 * outcome back into the DB (origin_verified_at + source promotion or
 * demotion). Idempotent — safe to call repeatedly.
 */
export async function verifyHostedPropertyOrigin(
  input: VerifyHostedOriginInput,
): Promise<VerificationOutcome> {
  const { hosted } = input;
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const propertyDb = input.propertyDb ?? new PropertyDatabase();
  const domain = hosted.publisher_domain.toLowerCase();
  const expectedAaoUrl = normalizeUrl(aaoHostedAdagentsJsonUrl(domain));
  const publisherOriginUrl = expectedAdagentsJsonUrl(domain);

  let response: { status: number; body: string };
  try {
    response = await fetchImpl(publisherOriginUrl);
  } catch (err) {
    logger.warn({ err, domain, publisherOriginUrl }, 'Origin verification fetch failed');
    // Transient — don't change the persisted verification state.
    return { verified: false, reason: 'transient', checked_at: new Date(), detail: (err as Error).message };
  }

  if (response.status !== 200) {
    await propertyDb.recordOriginVerification(domain, false);
    await demoteIfPreviouslyVerified(domain, hosted, propertyDb);
    return {
      verified: false,
      reason: response.status === 404 ? 'fetch_failed' : 'non_200_response',
      checked_at: new Date(),
      detail: `HTTP ${response.status}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    await propertyDb.recordOriginVerification(domain, false);
    await demoteIfPreviouslyVerified(domain, hosted, propertyDb);
    return { verified: false, reason: 'invalid_json', checked_at: new Date() };
  }

  // Path 1: stub with authoritative_location
  const authLoc = typeof parsed.authoritative_location === 'string' ? parsed.authoritative_location : undefined;
  if (authLoc) {
    if (normalizeUrl(authLoc) === expectedAaoUrl) {
      await propertyDb.recordOriginVerification(domain, true);
      const manifestAgents = readManifestAgentUrls(hosted.adagents_json || {});
      const promotion = await promoteVerifiedAuthorizations(domain, manifestAgents);
      logger.info({ domain, promoted: promotion.promoted }, 'Origin verified via authoritative_location pointer');
      return { verified: true, reason: 'authoritative_location_pointer', checked_at: new Date() };
    }
    await propertyDb.recordOriginVerification(domain, false);
    await demoteIfPreviouslyVerified(domain, hosted, propertyDb);
    return {
      verified: false,
      reason: 'authoritative_location_mismatch',
      checked_at: new Date(),
      detail: `expected ${expectedAaoUrl}, got ${normalizeUrl(authLoc)}`,
    };
  }

  // Path 2: full document echo. Lighter check — same authorized_agents
  // url set is sufficient. (A full byte-equal compare would be brittle
  // against whitespace/key-order differences.)
  const publisherAgentUrls = new Set(readManifestAgentUrls(parsed));
  const hostedAgentUrls = new Set(readManifestAgentUrls(hosted.adagents_json || {}));
  const sameSet =
    publisherAgentUrls.size === hostedAgentUrls.size &&
    [...publisherAgentUrls].every(u => hostedAgentUrls.has(u));
  if (sameSet && publisherAgentUrls.size > 0) {
    await propertyDb.recordOriginVerification(domain, true);
    await promoteVerifiedAuthorizations(domain, [...publisherAgentUrls]);
    logger.info({ domain }, 'Origin verified via full-document echo');
    return { verified: true, reason: 'document_echo', checked_at: new Date() };
  }

  await propertyDb.recordOriginVerification(domain, false);
  await demoteIfPreviouslyVerified(domain, hosted, propertyDb);
  return { verified: false, reason: 'no_authoritative_location', checked_at: new Date() };
}

/**
 * If the hosted property was previously verified (origin_verified_at
 * set on the in-memory snapshot we received), demote any rows we'd
 * promoted on that earlier verification. Caller passes the pre-update
 * `hosted` snapshot so the previous state is visible.
 */
async function demoteIfPreviouslyVerified(
  domain: string,
  hosted: HostedProperty,
  _propertyDb: { recordOriginVerification: PropertyDatabase['recordOriginVerification'] },
): Promise<void> {
  if (!hosted.origin_verified_at) return;
  const manifestAgents = readManifestAgentUrls(hosted.adagents_json || {});
  if (manifestAgents.length === 0) return;
  try {
    const { demoted } = await demotePreviouslyVerifiedAuthorizations(domain, manifestAgents);
    if (demoted > 0) {
      logger.info({ domain, demoted }, 'Origin verification failed after previous success — demoted promoted rows');
    }
  } catch (err) {
    logger.warn({ err, domain }, 'Failed to demote previously-verified authorizations');
  }
}
