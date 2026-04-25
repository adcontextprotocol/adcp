/**
 * Brand-claim file-placement challenge.
 *
 * Server issues a token. Caller must publish the token at
 *   https://{domain}/.well-known/adcp-claim/{token}
 * with the token as the response body. Server fetches that URL and matches
 * the body — if it matches, the caller has proven control of the domain's
 * web server, which we treat as proof of brand ownership for the verified-
 * domain takeover flow (#3176).
 *
 * Mirrors the existing brand.json pointer-verification flow but with a
 * server-issued nonce, so the proof is bound to *this specific* claim
 * attempt rather than any old file the domain happens to publish.
 */

import { safeFetch } from '../utils/url-security.js';
import { canonicalizeBrandDomain } from './identifier-normalization.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-claim-challenge');

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1024; // tokens are ~50 chars; cap reads tightly

export function placementUrlFor(domain: string, token: string): string {
  const canonical = canonicalizeBrandDomain(domain);
  return `https://${canonical}/.well-known/adcp-claim/${encodeURIComponent(token)}`;
}

export interface ChallengeFetchOk { ok: true }
export interface ChallengeFetchError { ok: false; reason: string }

/**
 * Fetch the placement URL and confirm the response body matches the
 * expected token. Treats trailing whitespace / newline as harmless
 * (some webservers add a newline) but rejects extra non-whitespace.
 */
export async function fetchAndMatchClaimToken(
  domain: string,
  token: string,
): Promise<ChallengeFetchOk | ChallengeFetchError> {
  const url = placementUrlFor(domain, token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Brand claim fetch timed out')), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await safeFetch(url, { method: 'GET', maxRedirects: 3, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: `Could not reach ${url}: ${err instanceof Error ? err.message : 'unknown error'}` };
  }

  try {
    if (!response.ok) {
      return { ok: false, reason: `Placement URL returned HTTP ${response.status}. Make sure the file is publicly served at the expected path.` };
    }

    // Read at most MAX_BODY_BYTES — tokens are short and we don't want a
    // server with a massive body to tie up the validator.
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, reason: 'Placement URL returned no body.' };
    }
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
          if (total > MAX_BODY_BYTES) break;
        }
      }
    } finally {
      reader.cancel().catch(() => {/* already closed */});
    }

    const body = Buffer.concat(chunks.map(c => Buffer.from(c)), Math.min(total, MAX_BODY_BYTES))
      .toString('utf8')
      .trim();

    if (body !== token) {
      logger.info({ url, expectedLength: token.length, actualLength: body.length }, 'Brand claim challenge: token body mismatch');
      return { ok: false, reason: 'Placement URL response did not match the expected token. Make sure the file body is exactly the token text.' };
    }

    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}
