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

let capabilityDeclaration: VerifierCapability | null = null;

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
 * Operations for which the training agent requires RFC 9421 signatures.
 *
 * Advertised via `required_for` on `get_adcp_capabilities` and enforced
 * in the auth chain (index.ts). Keeping this narrow — `create_media_buy`
 * is the canonical money-moving operation the `signed-requests`
 * conformance vectors target (vector 001 tests precisely this) — lets
 * the same agent serve signed and unsigned callers for every other
 * operation. Widening would require every storyboard that issues the
 * newly-required op to carry a bearer AND a valid signature, which
 * doubles the ceremony without changing the grading coverage.
 */
export const REQUIRED_FOR_OPERATIONS: ReadonlyArray<string> = ['create_media_buy'];

/**
 * Get the capability block we advertise on `get_adcp_capabilities`.
 *
 * `required_for` is narrow (see {@link REQUIRED_FOR_OPERATIONS}): the
 * specialism's conformance vectors assert rejection on unsigned calls to
 * listed operations, and the training agent enforces this in the auth
 * chain so grading is honest about the advertised contract.
 */
export function getRequestSigningCapability(): VerifierCapability {
  if (!capabilityDeclaration) {
    capabilityDeclaration = {
      supported: true,
      covers_content_digest: 'either',
      required_for: [...REQUIRED_FOR_OPERATIONS],
      supported_for: [...MUTATING_TOOLS],
    };
  }
  return capabilityDeclaration;
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
  capabilityDeclaration = null;
}
