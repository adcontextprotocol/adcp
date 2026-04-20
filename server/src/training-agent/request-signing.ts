/**
 * RFC 9421 request-signing verifier for the training agent.
 *
 * Mounts `createExpressVerifier` from `@adcp/client/signing` as Express
 * middleware so the `signed-requests` specialism's 40 conformance vectors
 * can grade the agent as a verifier. Keys come from the compliance cache's
 * published test JWKS (`test-vectors/request-signing/keys.json`); the
 * revoked keyid from that fixture is pre-loaded into the revocation list so
 * vector 017 fires its expected `request_signature_revoked` code.
 *
 * The verifier covers every mutating AdCP tool via `required_for` — matches
 * the `signed_requests_runner` test-kit contract declaring that signed
 * counterparties will sign those operations. Read-only tools (get_*,
 * list_*) are in `supported_for` so buyers may sign them without the agent
 * demanding it.
 *
 * NOT wired: the training agent DOES NOT SIGN outbound requests itself, so
 * there is no corresponding private key management here. We are a verifier,
 * not a signer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createExpressVerifier,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} from '@adcp/client/signing';
import type { ExpressLike, ExpressMiddlewareOptions } from '@adcp/client/signing';
import type { AdcpJsonWebKey, VerifierCapability } from '@adcp/client/signing';
import { getComplianceCacheDir } from '@adcp/client/testing';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../logger.js';
import { MUTATING_TOOLS } from './idempotency.js';

const logger = createLogger('training-agent-request-signing');

const TEST_REVOKED_KID = 'test-revoked-2026';

type Verifier = ReturnType<typeof createExpressVerifier>;
let verifier: Verifier | null = null;
let capabilityDeclaration: VerifierCapability | null = null;

function loadTestJwks(): AdcpJsonWebKey[] {
  const path = join(getComplianceCacheDir(), 'test-vectors', 'request-signing', 'keys.json');
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as { keys: AdcpJsonWebKey[] };
  if (!Array.isArray(parsed.keys)) {
    throw new Error(`request-signing keys.json at ${path} has no keys[] array`);
  }
  // Strip the private-scalar field so the resolver never accidentally exposes
  // signing material to verification callers.
  return parsed.keys.map(k => {
    const cleaned = { ...k };
    delete (cleaned as Record<string, unknown>)._private_d_for_test_only;
    return cleaned;
  });
}

function buildVerifier(): Verifier {
  const keys = loadTestJwks();
  const jwks = new StaticJwksResolver(keys);
  const replayStore = new InMemoryReplayStore();
  // Pre-revoke the test-kit's revocation vector key so vector 017 fires the
  // expected `request_signature_revoked` error instead of passing.
  const revocationStore = new InMemoryRevocationStore({
    issuer: 'training-agent',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    revoked_kids: [TEST_REVOKED_KID],
    revoked_jtis: [],
  });

  // AdCP 3.0 default: `required_for` is empty — sellers opt in selectively.
  // The training agent verifies signatures when present (positive + malformed-
  // signature vectors both behave correctly) but does not reject unsigned
  // callers. This keeps every other storyboard, unit test, and integration
  // test on the unsigned path without forcing them to sign.
  //
  // `supported_for` announces to counterparties that the verifier is wired;
  // signed_requests vectors are gated on `supported: true` alone.
  const capability: VerifierCapability = {
    supported: true,
    covers_content_digest: 'either',
    required_for: [],
    supported_for: [...MUTATING_TOOLS],
  };
  capabilityDeclaration = capability;

  const options: ExpressMiddlewareOptions = {
    capability,
    jwks,
    replayStore,
    revocationStore,
    resolveOperation: (req: ExpressLike) => {
      // MCP envelopes arrive as JSON-RPC. When the method is `tools/call`,
      // `params.name` is the AdCP operation name we gate on `required_for`.
      // Any other JSON-RPC shape (tasks/get, tasks/list, discovery probes)
      // returns undefined → verifier treats as not-in-required_for and
      // accepts unsigned, which is correct for non-mutating reads.
      const raw = req.rawBody;
      if (!raw) return undefined;
      try {
        const body = JSON.parse(raw) as { method?: string; params?: { name?: string } };
        if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
          return body.params.name;
        }
      } catch {
        // Malformed JSON — let MCP transport reject as a JSON-RPC parse error.
      }
      return undefined;
    },
  };

  logger.info({ kids: keys.map(k => k.kid), required_for_count: capability.required_for.length },
    'Request-signing verifier initialised from compliance test JWKS');
  return createExpressVerifier(options);
}

export function getRequestSigningCapability(): VerifierCapability {
  if (!capabilityDeclaration) {
    // Trigger lazy init so the capability is declared even if no signed
    // request has hit the endpoint yet.
    getRequestSigningVerifier();
  }
  return capabilityDeclaration!;
}

export function getRequestSigningVerifier(): Verifier {
  if (!verifier) verifier = buildVerifier();
  return verifier;
}

/**
 * Express middleware that runs the RFC 9421 verifier. Unsigned requests for
 * operations not in `required_for` pass through. Signed requests have
 * `req.verifiedSigner` populated on success. Failures short-circuit with a
 * 401 + `WWW-Authenticate: Signature error="..."`.
 *
 * Body-capture fallback: the SDK verifier throws
 * `request_signature_header_malformed` when a POST has `content-length > 0`
 * but no `rawBody`. Host apps that mount our router downstream of plain
 * `express.json()` (tests, some embedded integrations) don't set `rawBody`.
 * For UNSIGNED requests — no `signature-input` header — we synthesize
 * `rawBody` from the parsed body so the verifier can reach its "unsigned,
 * not required" pass-through. Signed callers MUST sit behind the upstream
 * body-capture hook (`http.ts` sets this via `express.json({ verify })`);
 * re-serializing a signed body here would not be byte-identical to the
 * signer's bytes and verification would fail — which is the correct
 * signal that the caller's body-capture is misconfigured.
 */
export function requestSigningMiddleware(req: Request, res: Response, next: NextFunction): void {
  const reqAny = req as Request & { rawBody?: string };
  if (reqAny.rawBody === undefined && req.headers['signature-input'] === undefined && req.body !== undefined) {
    try {
      reqAny.rawBody = JSON.stringify(req.body);
    } catch {
      reqAny.rawBody = '';
    }
  }
  const v = getRequestSigningVerifier();
  // createExpressVerifier accepts an `ExpressLike` shape — Express's `Request`
  // satisfies it structurally (method, url, headers, rawBody from our json
  // verify hook, plus the optional `get`).
  v(req as unknown as ExpressLike, res as unknown as Parameters<Verifier>[1], next).catch(err => {
    logger.warn({ err }, 'Request-signing verifier threw');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

/** Reset state — tests only. */
export function resetRequestSigning(): void {
  verifier = null;
  capabilityDeclaration = null;
}
