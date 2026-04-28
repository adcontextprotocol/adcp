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
  RequestSignatureError,
} from '@adcp/client/signing';
import type { AdcpJsonWebKey, ReplayStore, VerifierCapability } from '@adcp/client/signing';
import {
  verifySignatureAsAuthenticator,
  AuthError,
  tagAuthenticatorNeedsRawBody,
  tagAuthenticatorPresenceGated,
  isAuthenticatorPresenceGated,
} from '@adcp/client/server';
import { PostgresReplayStore, sweepExpiredReplays } from '@adcp/client/signing/server';
import type { Authenticator } from '@adcp/client/server';
import { getComplianceCacheDir } from '@adcp/client/testing';
import { createLogger } from '../logger.js';
import { getPool, isDatabaseInitialized } from '../db/client.js';
import { MUTATING_TOOLS } from './idempotency.js';

const logger = createLogger('training-agent-request-signing');

const TEST_REVOKED_KID = 'test-revoked-2026';

/** Operations that the grader-targeted strict route declares as requiring
 *  a signed request. Kept narrow so the strict route can still run
 *  discovery / list_tools / get_products without signing. */
export const STRICT_REQUIRED_FOR: readonly string[] = ['create_media_buy'];

let defaultCapability: VerifierCapability | null = null;
let strictCapability: VerifierCapability | null = null;
let strictRequiredCapability: VerifierCapability | null = null;
let strictForbiddenCapability: VerifierCapability | null = null;

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
 * Capability for `/mcp-strict-required`: verifier rejects signatures that
 * omit `content-digest` coverage. Enables grader vectors neg/007
 * (`missing-content-digest`) and any other vector requiring `'required'` mode.
 */
export function getStrictRequiredRequestSigningCapability(): VerifierCapability {
  if (!strictRequiredCapability) {
    strictRequiredCapability = {
      supported: true,
      covers_content_digest: 'required',
      required_for: [...STRICT_REQUIRED_FOR],
      supported_for: [...MUTATING_TOOLS],
    };
  }
  return strictRequiredCapability;
}

/**
 * Capability for `/mcp-strict-forbidden`: verifier rejects signatures that
 * include `content-digest` coverage. Enables grader vector neg/018
 * (`digest-covered-when-forbidden`) and any other vector requiring `'forbidden'` mode.
 */
export function getStrictForbiddenRequestSigningCapability(): VerifierCapability {
  if (!strictForbiddenCapability) {
    strictForbiddenCapability = {
      supported: true,
      covers_content_digest: 'forbidden',
      required_for: [...STRICT_REQUIRED_FOR],
      supported_for: [...MUTATING_TOOLS],
    };
  }
  return strictForbiddenCapability;
}

/**
 * Select the right `VerifierCapability` for a training-agent context. The
 * default (`!ctx.strict`) is the sandbox capability. Strict routes use
 * `digestMode` to pick among `'either'` / `'required'` / `'forbidden'`.
 */
export function selectSigningCapability(ctx: { strict?: boolean; digestMode?: 'either' | 'required' | 'forbidden' }): VerifierCapability {
  if (!ctx.strict) return getRequestSigningCapability();
  if (ctx.digestMode === 'required') return getStrictRequiredRequestSigningCapability();
  if (ctx.digestMode === 'forbidden') return getStrictForbiddenRequestSigningCapability();
  return getStrictRequestSigningCapability();
}

/**
 * Shared Postgres replay store for production. Singleton across all per-route
 * authenticators — the `adcp_replay_cache` table's (keyid, scope, nonce) PK
 * partitions by route via the `@target-uri`-derived scope, so sharing one
 * pool connection is safe and avoids four separate pool entries.
 *
 * Not used when the database has not been initialized (CI/storyboard runner).
 * In that case `buildAuthenticatorWithCapability` creates a per-authenticator
 * `InMemoryReplayStore` instead — see below.
 */
let _replayStore: ReplayStore | null = null;
function getReplayStore(): ReplayStore {
  if (_replayStore) return _replayStore;
  const store = new PostgresReplayStore(getPool());
  _replayStore = store;
  return store;
}

/**
 * Schedule periodic deletion of expired rows from `adcp_replay_cache`.
 * Postgres has no native TTL — without this, the table grows unboundedly.
 * Called from the server boot path (index.ts).
 */
let _sweepInterval: NodeJS.Timeout | null = null;
export function startReplayCacheSweeper(): void {
  if (_sweepInterval) return;
  _sweepInterval = setInterval(() => {
    if (!isDatabaseInitialized()) return;
    sweepExpiredReplays(getPool())
      .then((result: { deleted: number }) => {
        if (result.deleted > 0) logger.info({ deleted: result.deleted }, 'Swept expired replay-cache rows');
      })
      .catch((err: unknown) => logger.warn({ err }, 'Replay-cache sweep failed'));
  }, 60_000);
  // Don't keep the event loop alive for the sweeper alone.
  _sweepInterval.unref?.();
}

export function stopReplayCacheSweeper(): void {
  if (_sweepInterval) {
    clearInterval(_sweepInterval);
    _sweepInterval = null;
  }
}

function buildAuthenticatorWithCapability(capability: VerifierCapability): Authenticator {
  const keys = loadTestJwks();
  const jwks = new StaticJwksResolver(keys);
  // In production (DB initialized): shared Postgres store catches cross-instance replays.
  // In CI/storyboard runner (no DB): per-authenticator InMemoryReplayStore restores the
  // pre-#3351 behavior; each route owns its own store so cross-route false positives
  // can't occur (#3338).
  const replayStore = isDatabaseInitialized() ? getReplayStore() : new InMemoryReplayStore();

  // Pre-revoke the test-kit's revocation vector key so vector 017 fires
  // the expected `request_signature_revoked` error instead of passing.
  const revocationStore = new InMemoryRevocationStore({
    issuer: 'training-agent',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    revoked_kids: [TEST_REVOKED_KID],
    revoked_jtis: [],
  });

  return verifySignatureAsAuthenticator({
    capability,
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
  logger.info(
    { required_for_count: getRequestSigningCapability().required_for.length },
    'Request-signing authenticator initialised from compliance test JWKS',
  );
  return buildAuthenticatorWithCapability(getRequestSigningCapability());
}

/** Authenticator for `/mcp-strict`: presence-gated signing with
 *  `required_for: ['create_media_buy']` and `'either'` content-digest mode.
 *  Distinct from the default authenticator so each route owns an isolated
 *  `InMemoryReplayStore` — sharing one store lets a nonce consumed on `/mcp`
 *  falsely fire `request_signature_replayed` on `/mcp-strict` (#3338). */
export function buildStrictRequestSigningAuthenticator(): Authenticator {
  return buildAuthenticatorWithCapability(getStrictRequestSigningCapability());
}

/** Authenticator for `/mcp-strict-required`: enforces `covers_content_digest='required'`. */
export function buildStrictRequiredRequestSigningAuthenticator(): Authenticator {
  return buildAuthenticatorWithCapability(getStrictRequiredRequestSigningCapability());
}

/** Authenticator for `/mcp-strict-forbidden`: enforces `covers_content_digest='forbidden'`. */
export function buildStrictForbiddenRequestSigningAuthenticator(): Authenticator {
  return buildAuthenticatorWithCapability(getStrictForbiddenRequestSigningCapability());
}

function headerFirst(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function headerNonEmpty(value: string | string[] | undefined): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.some(v => typeof v === 'string' && v.length > 0);
  return false;
}

function requestCarriesSignatureHeader(headers: IncomingMessage['headers']): boolean {
  return headerNonEmpty(headers['signature-input']) || headerNonEmpty(headers['signature']);
}

/**
 * Detect `push_notification_config.authentication` (non-empty object) anywhere
 * under the JSON-RPC `params.arguments` tree. The downgrade-resistance rule in
 * docs/building/implementation/security.mdx (`#webhook-callbacks`) scopes the
 * trigger to the webhook-registration field, so we only walk the argument
 * subtree — not the whole body — and treat arrays as transparent containers
 * so per-package webhook configs (e.g. an update carrying multiple packages)
 * are matched.
 */
function bodyCarriesWebhookAuthentication(rawBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const args = (parsed as { params?: { arguments?: unknown } } | null)?.params?.arguments;
  return subtreeHasWebhookAuthentication(args);
}

// Depth budget counts object hops only; array containers are transparent so a
// per-package webhook config doesn't consume the budget for its position in
// the packages[] array. Realistic AdCP payloads nest 4–6 object levels deep
// (plan → packages[] → package → push_notification_config → authentication).
const MAX_OBJECT_DEPTH = 10;

function subtreeHasWebhookAuthentication(node: unknown, depth = 0): boolean {
  if (Array.isArray(node)) {
    return node.some(item => subtreeHasWebhookAuthentication(item, depth));
  }
  if (!node || typeof node !== 'object') return false;
  if (depth > MAX_OBJECT_DEPTH) return false;
  const obj = node as Record<string, unknown>;
  const pnc = obj.push_notification_config;
  if (pnc && typeof pnc === 'object' && !Array.isArray(pnc)) {
    const auth = (pnc as Record<string, unknown>).authentication;
    if (auth && typeof auth === 'object' && Object.keys(auth as object).length > 0) return true;
  }
  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object' && subtreeHasWebhookAuthentication(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Enforce the webhook-registration downgrade-resistance rule from
 * `docs/building/implementation/security.mdx#webhook-callbacks`:
 *
 *   Sellers that support request signing MUST require the inbound request to
 *   be 9421-signed when `push_notification_config.authentication` is present,
 *   rejecting with `request_signature_required`.
 *
 * The wrapper runs BEFORE the inner authenticator so it fires even when a
 * valid bearer would otherwise authenticate — bearer bypass is the exact
 * downgrade this rule prevents (an on-path mutator cannot inject or strip
 * the `authentication` block once the request body is cryptographically
 * committed to by the signature).
 *
 * When a signature header IS present, the wrapper delegates to the inner
 * authenticator unchanged so the signing-path verifier does its normal work.
 */
export function enforceSigningWhenWebhookAuthPresent(inner: Authenticator): Authenticator {
  const wrapped: Authenticator = async (req) => {
    if (!requestCarriesSignatureHeader(req.headers)) {
      // rawBody from the production http.ts verify callback; fall back to
      // re-serialising req.body for test harnesses that omit the callback.
      const rawBody = (req as { rawBody?: string }).rawBody;
      const bodyForWebhookCheck = (req as { body?: unknown }).body;
      // Guard: JSON.stringify is safe only for plain objects (express.json always
      // produces one, but a misconfigured parser could yield a Buffer or string).
      const rawFallback = bodyForWebhookCheck !== null && typeof bodyForWebhookCheck === 'object' && !Array.isArray(bodyForWebhookCheck) && !Buffer.isBuffer(bodyForWebhookCheck)
        ? JSON.stringify(bodyForWebhookCheck)
        : undefined;
      const raw = rawBody ?? rawFallback;
      if (raw && bodyCarriesWebhookAuthentication(raw)) {
        throw new AuthError(
          'Signature required when push_notification_config.authentication is present.',
          {
            cause: new RequestSignatureError(
              'request_signature_required',
              0,
              'Requests carrying push_notification_config.authentication MUST be signed per RFC 9421 (security.mdx webhook-callbacks downgrade resistance).',
            ),
          },
        );
      }
    }
    return inner(req);
  };
  tagAuthenticatorNeedsRawBody(wrapped);
  if (isAuthenticatorPresenceGated(inner)) tagAuthenticatorPresenceGated(wrapped);
  return wrapped;
}

/** Reset state — tests only. */
export function resetRequestSigning(): void {
  defaultCapability = null;
  strictCapability = null;
  strictRequiredCapability = null;
  strictForbiddenCapability = null;
}
