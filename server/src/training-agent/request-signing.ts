/**
 * RFC 9421 request-signing verifier wired as an `Authenticator`.
 *
 * In 5.5, `verifySignatureAsAuthenticator` turns the signing verifier into
 * something composable with `verifyApiKey` via `anyOf()` — so the Express
 * auth chain accepts either bearer credentials OR a valid signature.
 * Before 5.5, this file hosted an Express middleware mounted AFTER
 * `requireToken`, which meant signed-but-unbeared requests were rejected
 * at the bearer gate. That's gone now.
 *
 * Keys come from the compliance cache's published test JWKS
 * (`test-vectors/request-signing/keys.json`). The revoked keyid from
 * that fixture is pre-loaded into the revocation list so vector 017
 * fires its expected `request_signature_revoked` code.
 *
 * NOT wired: the training agent DOES NOT SIGN outbound requests, so
 * there is no corresponding private-key management here. We are a
 * verifier, not a signer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} from '@adcp/client/signing';
import type { AdcpJsonWebKey, VerifierCapability } from '@adcp/client/signing';
import { verifySignatureAsAuthenticator } from '@adcp/client/server';
import type { Authenticator } from '@adcp/client/server';
import { getComplianceCacheDir } from '@adcp/client/testing';
import { createLogger } from '../logger.js';
import { MUTATING_TOOLS } from './idempotency.js';

const logger = createLogger('training-agent-request-signing');

const TEST_REVOKED_KID = 'test-revoked-2026';

/** Operations that the grader-targeted strict route declares as requiring
 *  a signed request. Kept narrow so the strict route can still run
 *  discovery / list_tools / get_products without signing. */
export const STRICT_REQUIRED_FOR: readonly string[] = ['create_media_buy'];

let defaultCapability: VerifierCapability | null = null;
let strictCapability: VerifierCapability | null = null;

function loadTestJwks(): AdcpJsonWebKey[] {
  const path = join(getComplianceCacheDir(), 'test-vectors', 'request-signing', 'keys.json');
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as { keys: AdcpJsonWebKey[] };
  if (!Array.isArray(parsed.keys)) {
    throw new Error(`request-signing keys.json at ${path} has no keys[] array`);
  }
  // Strip the private-scalar field so the resolver never accidentally
  // exposes signing material to verification callers.
  return parsed.keys.map(k => {
    const cleaned = { ...k };
    delete (cleaned as Record<string, unknown>)._private_d_for_test_only;
    return cleaned;
  });
}

/**
 * Capability block for the public sandbox `/mcp` route.
 *
 * `required_for: []` so unsigned bearer callers keep working — this endpoint
 * is a learning sandbox, not a conformance target. Signed callers are still
 * verified end-to-end (signature composes via `anyOf(verifyApiKey, ...)`).
 */
export function getRequestSigningCapability(): VerifierCapability {
  if (!defaultCapability) {
    defaultCapability = {
      supported: true,
      covers_content_digest: 'either',
      required_for: [],
      supported_for: [...MUTATING_TOOLS],
    };
  }
  return defaultCapability;
}

/**
 * Capability block for the grader-targeted `/mcp-strict` route.
 *
 * `required_for: STRICT_REQUIRED_FOR` so the conformance grader's vector 001
 * (`request_signature_required`) fires. The strict route enforces presence-
 * gated signing: invalid signatures 401 without falling through to bearer,
 * unsigned calls to required ops 401 with the `request_signature_required`
 * error code. Non-required ops still accept bearer so grader setup (list
 * tools, discovery, get_products) works without signing infrastructure.
 */
export function getStrictRequestSigningCapability(): VerifierCapability {
  if (!strictCapability) {
    strictCapability = {
      supported: true,
      covers_content_digest: 'either',
      required_for: [...STRICT_REQUIRED_FOR],
      supported_for: [...MUTATING_TOOLS],
    };
  }
  return strictCapability;
}

/**
 * Build the Authenticator that verifies RFC 9421 signatures. Composed
 * into the main auth chain via `anyOf(verifyApiKey(...), this)` so the
 * endpoint accepts either bearer OR a valid signature.
 *
 * Returns `null` (fall-through) on unsigned requests. Throws `AuthError`
 * on signature-present-but-invalid. Returns a principal
 * `signing:<keyid>` on success.
 */
export function buildRequestSigningAuthenticator(): Authenticator {
  const keys = loadTestJwks();
  const jwks = new StaticJwksResolver(keys);
  const replayStore = new InMemoryReplayStore();

  // Pre-revoke the test-kit's revocation vector key so vector 017 fires
  // the expected `request_signature_revoked` error instead of passing.
  const revocationStore = new InMemoryRevocationStore({
    issuer: 'training-agent',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    revoked_kids: [TEST_REVOKED_KID],
    revoked_jtis: [],
  });

  logger.info(
    { kids: keys.map(k => k.kid), required_for_count: getRequestSigningCapability().required_for.length },
    'Request-signing authenticator initialised from compliance test JWKS',
  );

  return verifySignatureAsAuthenticator({
    capability: getRequestSigningCapability(),
    jwks,
    replayStore,
    revocationStore,
    // Express mounts the router at `/api/training-agent`, so `req.url` is
    // `/mcp` when the authenticator runs — but the signer signed the full
    // path. Reconstruct from `originalUrl` when present.
    getUrl: (req) => {
      const expressReq = req as IncomingMessage & { originalUrl?: string; headers: IncomingMessage['headers'] };
      const forwardedProto = headerFirst(expressReq.headers['x-forwarded-proto']);
      const encrypted = (expressReq as IncomingMessage & { socket?: { encrypted?: boolean } }).socket?.encrypted === true;
      const proto = forwardedProto ?? (encrypted ? 'https' : 'http');
      const host = headerFirst(expressReq.headers['host']);
      if (!host) throw new Error('request-signing: missing Host header');
      const path = expressReq.originalUrl ?? expressReq.url ?? '/';
      return `${proto}://${host}${path}`;
    },
    resolveOperation: (req) => {
      const raw = req.rawBody;
      if (!raw) return undefined;
      try {
        const body = JSON.parse(raw) as { method?: string; params?: { name?: string } };
        if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
          return body.params.name;
        }
      } catch {
        // Non-JSON or malformed — MCP transport will reject downstream.
      }
      return undefined;
    },
  });
}

function headerFirst(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/** Reset state — tests only. */
export function resetRequestSigning(): void {
  defaultCapability = null;
  strictCapability = null;
}
