import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import {
  nativeAuthStartRateLimiter,
  nativeAuthTokenRateLimiter,
} from '../middleware/rate-limit.js';
import * as nativeAuthDb from '../db/native-auth-state-db.js';
import type {
  NativeGrant,
  NativeGrantUser,
  NativePendingAuth,
} from '../db/native-auth-state-db.js';

const logger = createLogger('native-auth');

export const NATIVE_PROTOCOL_VERSION = 2;
export const NATIVE_CLIENT_ID = 'org.agenticadvertising.addie';
export const NATIVE_REDIRECT_URI = 'org.agenticadvertising.addie:/auth/callback';

const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface NativeAuthStore {
  setPendingAuth(id: string, data: NativePendingAuth): Promise<void>;
  consumePendingAuth(id: string): Promise<NativePendingAuth | undefined>;
  setGrant(code: string, data: NativeGrant): Promise<void>;
  consumeGrant(
    code: string,
    binding: Pick<NativeGrant, 'clientId' | 'redirectUri' | 'clientState' | 'codeChallenge'>,
  ): Promise<NativeGrant | undefined>;
}

interface NativeAuthRouterOptions {
  issuer: string;
  buildWorkOSAuthorizationUrl(state: string, codeChallenge: string): string;
  store?: NativeAuthStore;
  randomOpaqueValue?: () => string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isExactOpaqueValue(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_VALUE_PATTERN.test(value);
}

export function deriveS256Challenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function isValidPkceVerifier(value: unknown): value is string {
  return typeof value === 'string' && PKCE_VERIFIER_PATTERN.test(value);
}

export function parseNativePendingId(state: unknown): string | undefined {
  if (typeof state !== 'string' || state.length > 256) return undefined;
  try {
    const parsed = JSON.parse(state) as unknown;
    if (!isPlainRecord(parsed) || Object.keys(parsed).length !== 1) return undefined;
    return isExactOpaqueValue(parsed.native_pending_id) ? parsed.native_pending_id : undefined;
  } catch {
    return undefined;
  }
}

export async function consumeNativePendingAuth(
  pendingId: string,
  store: NativeAuthStore = nativeAuthDb,
): Promise<NativePendingAuth | undefined> {
  return store.consumePendingAuth(pendingId);
}

export function buildNativeErrorRedirect(
  pending: NativePendingAuth,
  error: 'access_denied' | 'server_error',
): string {
  if (pending.redirectUri !== NATIVE_REDIRECT_URI) {
    throw new Error('Native pending redirect URI invariant failed');
  }
  const redirect = new URL(NATIVE_REDIRECT_URI);
  redirect.searchParams.set('v', String(NATIVE_PROTOCOL_VERSION));
  redirect.searchParams.set('error', error);
  redirect.searchParams.set('state', pending.clientState);
  redirect.searchParams.set('iss', pending.issuer);
  return redirect.toString();
}

export async function issueNativeGrantRedirect(
  pending: NativePendingAuth,
  sealedSession: string,
  user: NativeGrantUser,
  store: NativeAuthStore = nativeAuthDb,
  randomOpaqueValue: () => string = () => crypto.randomBytes(32).toString('base64url'),
): Promise<string> {
  if (!sealedSession) throw new Error('WorkOS did not return a sealed session');
  if (pending.redirectUri !== NATIVE_REDIRECT_URI) {
    throw new Error('Native pending redirect URI invariant failed');
  }
  const code = randomOpaqueValue();
  if (!isExactOpaqueValue(code)) throw new Error('Native grant generator returned an invalid value');
  await store.setGrant(code, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    clientState: pending.clientState,
    codeChallenge: pending.codeChallenge,
    issuer: pending.issuer,
    sealedSession,
    user,
  });

  const redirect = new URL(NATIVE_REDIRECT_URI);
  redirect.searchParams.set('v', String(NATIVE_PROTOCOL_VERSION));
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', pending.clientState);
  redirect.searchParams.set('iss', pending.issuer);
  return redirect.toString();
}

export function createNativeAuthRouter(options: NativeAuthRouterOptions): Router {
  const router = Router();
  const store = options.store ?? nativeAuthDb;
  const randomOpaqueValue = options.randomOpaqueValue
    ?? (() => crypto.randomBytes(32).toString('base64url'));

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.post('/start', nativeAuthStartRateLimiter, async (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (!isPlainRecord(body)
      || !hasExactKeys(body, [
        'v', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method',
      ])
      || body.v !== NATIVE_PROTOCOL_VERSION
      || body.client_id !== NATIVE_CLIENT_ID
      || body.redirect_uri !== NATIVE_REDIRECT_URI
      || body.code_challenge_method !== 'S256'
      || !isExactOpaqueValue(body.state)
      || !isExactOpaqueValue(body.code_challenge)) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    try {
      const pendingId = randomOpaqueValue();
      if (!isExactOpaqueValue(pendingId)) throw new Error('Invalid pending id');
      const workosCodeVerifier = randomOpaqueValue();
      if (!isExactOpaqueValue(workosCodeVerifier)) throw new Error('Invalid WorkOS verifier');
      await store.setPendingAuth(pendingId, {
        clientId: NATIVE_CLIENT_ID,
        redirectUri: NATIVE_REDIRECT_URI,
        clientState: body.state,
        codeChallenge: body.code_challenge,
        workosCodeVerifier,
        issuer: options.issuer,
      });
      const workosState = JSON.stringify({ native_pending_id: pendingId });
      return res.json({
        authorization_url: options.buildWorkOSAuthorizationUrl(
          workosState,
          deriveS256Challenge(workosCodeVerifier),
        ),
        expires_in: Math.floor(nativeAuthDb.NATIVE_PENDING_TTL_MS / 1000),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to start native OAuth');
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.post('/token', nativeAuthTokenRateLimiter, async (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (!isPlainRecord(body)
      || !hasExactKeys(body, [
        'v', 'grant_type', 'client_id', 'redirect_uri', 'code', 'state', 'code_verifier',
      ])
      || body.v !== NATIVE_PROTOCOL_VERSION
      || body.client_id !== NATIVE_CLIENT_ID
      || body.redirect_uri !== NATIVE_REDIRECT_URI
      || body.grant_type !== 'authorization_code'
      || !isExactOpaqueValue(body.code)
      || !isExactOpaqueValue(body.state)
      || !isValidPkceVerifier(body.code_verifier)) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    try {
      const grant = await store.consumeGrant(body.code, {
        clientId: NATIVE_CLIENT_ID,
        redirectUri: NATIVE_REDIRECT_URI,
        clientState: body.state,
        codeChallenge: deriveS256Challenge(body.code_verifier),
      });
      if (!grant) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      return res.json({
        sealed_session: grant.sealedSession,
        user: {
          id: grant.user.id,
          email: grant.user.email,
          first_name: grant.user.firstName ?? null,
          last_name: grant.user.lastName ?? null,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to redeem native OAuth grant');
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  return router;
}

const cleanupTimer = setInterval(() => nativeAuthDb.cleanupExpired(), CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
