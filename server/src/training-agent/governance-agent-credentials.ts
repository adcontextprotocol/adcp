/**
 * Sandbox governance-agent credentials for sellers under hosted grading.
 *
 * Spec (docs/governance/campaign/specification.mdx, "Setup"): the buyer
 * registers the governance agent on the seller through `sync_governance`
 * with a credential the seller presents on `check_governance`, and the
 * governance agent "MUST resolve the credential to the registered agent URL,
 * require exact equality with `caller`". The public sandbox governance agent
 * is shared by every grader, so no single fixed credential can map to every
 * seller. The storyboards' literal `gov-token-xxxx…` therefore resolves to
 * nothing and a third-party seller's execution check is rejected.
 *
 * This module mints and verifies a stateless credential that binds one
 * seller agent URL to one hosted run:
 *
 *   adcp-sandbox-gov.v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>
 *
 * - Only trusted in-process code mints it (the hosted runner, for the agent
 *   under test), and substitutes it into its copy of the storyboard's
 *   `sync_governance` step. The seller receives it and presents it back.
 * - It authenticates only on the `/governance` tenant (see
 *   `buildGovernanceAgentCredentialAuthenticator`), resolves to exactly the
 *   bound seller URL, and is limited to seller operations on plans whose
 *   `plan_id` carries the run nonce (`isGovernanceAgentCredentialPlanInScope`).
 * - The key is derived from `TRAINING_GOVERNANCE_CREDENTIAL_SECRET`. Without
 *   that secret the feature is off: minting throws and nothing verifies.
 */

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AuthPrincipal, Authenticator } from '@adcp/sdk/server';
import { HOSTED_GRADER_BUYER_AGENT_URL } from './hosted-grader.js';

export const SANDBOX_GOVERNANCE_GRANT_TAG = 'adcp-sandbox-gov.v1.';
/** Principal prefix stamped on requests authenticated with a minted credential. */
export const SANDBOX_GOVERNANCE_GRANT_PRINCIPAL_TAG = 'static:governance-agent-credential:';
/** Audience claim: the credential is only for this deployment's governance tenant. */
const CREDENTIAL_AUDIENCE = 'adcp-training-agent/governance';
const SECRET_ENV = 'TRAINING_GOVERNANCE_CREDENTIAL_SECRET';
const HKDF_INFO = 'adcp-sandbox-gov-seller.v1';
const MIN_SECRET_LENGTH = 32;
export const GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS = 30 * 60;
const MAX_CREDENTIAL_LENGTH = 1024;
const MAX_AGENT_URL_LENGTH = 512;
const NONCE_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Hosts whose identities a minted credential must never assume: the
 * deployment itself (its tenants authenticate as `${base}/<tenant>`) and the
 * per-token identities the buyer-agent registry synthesizes.
 */
const RESERVED_HOST_SUFFIXES = ['agenticadvertising.org', 'adcontextprotocol.org'];

export interface GovernanceAgentCredentialClaims {
  /** Seller agent URL the credential authenticates as. */
  agentUrl: string;
  /** Hosted-run nonce; only plans whose id ends with `-${nonce}` are in scope. */
  nonce: string;
  iat: number;
  exp: number;
}

interface WireClaims {
  v: 1;
  aud: string;
  agent_url: string;
  nonce: string;
  iat: number;
  exp: number;
}

export interface MintGovernanceAgentCredentialOptions {
  /** Hosted-run nonce, the suffix appended to the run's governance plan ids. */
  nonce: string;
  ttlSeconds?: number;
  /** Epoch seconds. */
  now?: number;
  /** Tests only: allow an `http://127.0.0.1` / `http://localhost` seller. */
  allowLoopbackHttp?: boolean;
}

function credentialKey(): Buffer | undefined {
  const secret = process.env[SECRET_ENV];
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_INFO, 32));
}

/** Whether this deployment can mint and verify governance-agent credentials. */
export function governanceAgentCredentialsEnabled(): boolean {
  return credentialKey() !== undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function isReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return RESERVED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Validate a seller agent URL for minting. Returns the exact string the
 * credential binds; callers must use the same string as the storyboard's
 * `seller_agent_url` (the intent `target_agent`, i.e. the token audience),
 * because the governance agent compares identities byte-for-byte.
 */
function mintableAgentUrl(agentUrl: string, allowLoopbackHttp: boolean): string {
  if (typeof agentUrl !== 'string' || agentUrl.length === 0 || agentUrl.length > MAX_AGENT_URL_LENGTH) {
    throw new Error('Governance agent credential requires a seller agent URL of at most 512 characters.');
  }
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch {
    throw new Error('Governance agent credential requires an absolute seller agent URL.');
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('Governance agent credential requires an HTTPS seller agent URL.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('Governance agent credential seller URL must not carry userinfo, query, or fragment.');
  }
  if (isReservedHost(url.hostname)) {
    throw new Error('Governance agent credential cannot be minted for an AgenticAdvertising.org or AdCP-operated host.');
  }
  return agentUrl;
}

function sign(key: Buffer, payloadSegment: string): Buffer {
  return createHmac('sha256', key).update(`${SANDBOX_GOVERNANCE_GRANT_TAG}${payloadSegment}`).digest();
}

/**
 * Mint a credential that authenticates as `agentUrl` on this deployment's
 * `/governance` tenant for one hosted run. Throws when the feature is not
 * configured or the URL is not mintable.
 */
export function mintGovernanceAgentCredential(
  agentUrl: string,
  options: MintGovernanceAgentCredentialOptions,
): string {
  const key = credentialKey();
  if (!key) throw new Error(`${SECRET_ENV} is not configured; governance agent credentials are disabled.`);
  const boundUrl = mintableAgentUrl(agentUrl, options.allowLoopbackHttp === true);
  if (!NONCE_PATTERN.test(options.nonce)) {
    throw new Error('Governance agent credential nonce must be 8-64 characters of [A-Za-z0-9-].');
  }
  const ttl = Math.min(
    Math.max(1, Math.floor(options.ttlSeconds ?? GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS)),
    GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS,
  );
  const iat = Math.floor(options.now ?? Date.now() / 1000);
  const claims: WireClaims = {
    v: 1,
    aud: CREDENTIAL_AUDIENCE,
    agent_url: boundUrl,
    nonce: options.nonce,
    iat,
    exp: iat + ttl,
  };
  const payloadSegment = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${SANDBOX_GOVERNANCE_GRANT_TAG}${payloadSegment}.${sign(key, payloadSegment).toString('base64url')}`;
}

/** Verify a presented credential. Returns its claims, or null. */
export function verifyGovernanceAgentCredential(
  token: unknown,
  now: number = Math.floor(Date.now() / 1000),
): GovernanceAgentCredentialClaims | null {
  if (typeof token !== 'string' || token.length > MAX_CREDENTIAL_LENGTH) return null;
  if (!token.startsWith(SANDBOX_GOVERNANCE_GRANT_TAG)) return null;
  const key = credentialKey();
  if (!key) return null;
  const rest = token.slice(SANDBOX_GOVERNANCE_GRANT_TAG.length);
  const parts = rest.split('.');
  if (parts.length !== 2) return null;
  const [payloadSegment, macSegment] = parts;
  if (!SEGMENT_PATTERN.test(payloadSegment) || !SEGMENT_PATTERN.test(macSegment)) return null;
  const expected = sign(key, payloadSegment);
  const presented = Buffer.from(macSegment, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let claims: Partial<WireClaims>;
  try {
    claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Partial<WireClaims>;
  } catch {
    return null;
  }
  if (
    claims.v !== 1
    || claims.aud !== CREDENTIAL_AUDIENCE
    || typeof claims.agent_url !== 'string'
    || typeof claims.nonce !== 'string'
    || !NONCE_PATTERN.test(claims.nonce)
    || typeof claims.iat !== 'number'
    || typeof claims.exp !== 'number'
    || claims.exp - claims.iat > GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS
    || claims.iat > now + 60
    || claims.exp <= now
  ) {
    return null;
  }
  return { agentUrl: claims.agent_url, nonce: claims.nonce, iat: claims.iat, exp: claims.exp };
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Authenticator for the governance tenant's routes only. It runs before the
 * shared chain so a minted credential is never forwarded to other verifiers.
 */
export function buildGovernanceAgentCredentialAuthenticator(): Authenticator {
  return async (req): Promise<AuthPrincipal | null> => {
    const token = bearerToken(req as unknown as Request);
    if (token?.startsWith(SANDBOX_GOVERNANCE_GRANT_TAG)) {
      const claims = verifyGovernanceAgentCredential(token);
      return claims ? { principal: governanceAgentCredentialPrincipal(claims) } : null;
    }
    if (token?.startsWith(HOSTED_GRADER_GRANT_TAG)) {
      const claims = verifyHostedGraderCredential(token);
      return claims ? { principal: hostedGraderCredentialPrincipal(claims) } : null;
    }
    return null;
  };
}

function governanceAgentCredentialPrincipal(claims: GovernanceAgentCredentialClaims): string {
  // Opaque and non-reversible: the principal feeds idempotency scoping and
  // logs, so it must not carry the credential itself.
  const digest = createHash('sha256').update(`${claims.agentUrl}\n${claims.nonce}`).digest('hex').slice(0, 32);
  return `${SANDBOX_GOVERNANCE_GRANT_PRINCIPAL_TAG}${digest}`;
}

export function isGovernanceAgentCredentialPrincipal(principal: string | undefined): boolean {
  return typeof principal === 'string' && principal.startsWith(SANDBOX_GOVERNANCE_GRANT_PRINCIPAL_TAG);
}

/** Resolve the credential on a request already authenticated as a governance-agent credential principal. */
export function governanceAgentCredentialFromRequest(req: Request): GovernanceAgentCredentialClaims | null {
  return verifyGovernanceAgentCredential(bearerToken(req));
}

/** Plans a credential may act on: those created in the same hosted run. */
export function isGovernanceAgentCredentialPlanInScope(
  claims: Pick<GovernanceAgentCredentialClaims, 'nonce'>,
  planId: string | undefined,
): boolean {
  return typeof planId === 'string' && planId.endsWith(`-${claims.nonce}`);
}

/** Shape the router stamps on `req.auth.extra` for a verified credential. */
export interface GovernanceAgentCredentialExtra {
  agent_url: string;
  nonce: string;
}

export const GOVERNANCE_AGENT_CREDENTIAL_EXTRA_KEY = 'governance_agent_credential';

/** Read the router-stamped credential scope from trusted auth `extra`. */
export function governanceAgentCredentialFromExtra(
  extra: Record<string, unknown> | undefined,
): Readonly<{ agentUrl: string; nonce: string }> | undefined {
  const value = extra?.[GOVERNANCE_AGENT_CREDENTIAL_EXTRA_KEY] as Partial<GovernanceAgentCredentialExtra> | undefined;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.agent_url !== 'string' || typeof value.nonce !== 'string') return undefined;
  return { agentUrl: value.agent_url, nonce: value.nonce };
}

/**
 * MCP methods and tools a governance-agent credential may use. The credential
 * exists for the seller's side of the governance loop only: execution checks
 * and seller adjustment reports. Plan setup, intent checks, outcome
 * reporting, audit reads, and every other governance-tenant tool stay with
 * buyer credentials.
 */
const ALLOWED_MCP_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list']);
const ALLOWED_TOOLS = new Set(['get_adcp_capabilities', 'check_governance', 'report_plan_adjustment']);

/** Whether a JSON-RPC body is within the credential's allowed surface. */
export function isGovernanceAgentCredentialRequestAllowed(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const message = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof message.method !== 'string') return false;
  if (ALLOWED_MCP_METHODS.has(message.method)) return true;
  return message.method === 'tools/call'
    && typeof message.params?.name === 'string'
    && ALLOWED_TOOLS.has(message.params.name);
}

// ── Hosted-grader buyer credential ──────────────────────────────────────
//
// Hosted grading authenticates to this governance tenant as one fixed buyer
// agent, HOSTED_GRADER_BUYER_AGENT_URL, so the intent token `caller` is an
// identity a third-party seller can map its grading credential to (#7758).
// The credential is minted only by in-process hosted-grading code, one per
// run, and is limited to the buyer side of that run: plan setup, intent
// checks, audit reads, and outcome reports on plans whose id carries the run
// nonce. It has its own tag, HKDF info, and audience, so a seller credential
// never verifies as a grader credential or the reverse.

export const HOSTED_GRADER_GRANT_TAG = 'adcp-sandbox-gov-grader.v1.';
/** Principal prefix stamped on requests authenticated with a grader credential. */
export const HOSTED_GRADER_GRANT_PRINCIPAL_TAG = 'static:governance-grader-credential:';
const GRADER_CREDENTIAL_AUDIENCE = 'adcp-training-agent/governance-grader';
const GRADER_HKDF_INFO = 'adcp-sandbox-gov-grader.v1';

export interface HostedGraderCredentialClaims {
  /** Always HOSTED_GRADER_BUYER_AGENT_URL. */
  agentUrl: string;
  /** Hosted-run nonce; only plans whose id ends with `-${nonce}` are in scope. */
  nonce: string;
  iat: number;
  exp: number;
}

function graderCredentialKey(): Buffer | undefined {
  const secret = process.env[SECRET_ENV];
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), GRADER_HKDF_INFO, 32));
}

function signGrader(key: Buffer, payloadSegment: string): Buffer {
  return createHmac('sha256', key).update(`${HOSTED_GRADER_GRANT_TAG}${payloadSegment}`).digest();
}

export interface MintHostedGraderCredentialOptions {
  /** Hosted-run nonce, the suffix appended to the run's governance plan ids. */
  nonce: string;
  ttlSeconds?: number;
  /** Epoch seconds. */
  now?: number;
}

/**
 * Mint a credential that authenticates as HOSTED_GRADER_BUYER_AGENT_URL on
 * this deployment's `/governance` tenant for one hosted run. Throws when the
 * feature is not configured.
 */
export function mintHostedGraderCredential(options: MintHostedGraderCredentialOptions): string {
  const key = graderCredentialKey();
  if (!key) throw new Error(`${SECRET_ENV} is not configured; hosted-grader governance credentials are disabled.`);
  if (!NONCE_PATTERN.test(options.nonce)) {
    throw new Error('Hosted-grader credential nonce must be 8-64 characters of [A-Za-z0-9-].');
  }
  const ttl = Math.min(
    Math.max(1, Math.floor(options.ttlSeconds ?? GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS)),
    GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS,
  );
  const iat = Math.floor(options.now ?? Date.now() / 1000);
  const claims: WireClaims = {
    v: 1,
    aud: GRADER_CREDENTIAL_AUDIENCE,
    agent_url: HOSTED_GRADER_BUYER_AGENT_URL,
    nonce: options.nonce,
    iat,
    exp: iat + ttl,
  };
  const payloadSegment = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${HOSTED_GRADER_GRANT_TAG}${payloadSegment}.${signGrader(key, payloadSegment).toString('base64url')}`;
}

/** Verify a presented hosted-grader credential. Returns its claims, or null. */
export function verifyHostedGraderCredential(
  token: unknown,
  now: number = Math.floor(Date.now() / 1000),
): HostedGraderCredentialClaims | null {
  if (typeof token !== 'string' || token.length > MAX_CREDENTIAL_LENGTH) return null;
  if (!token.startsWith(HOSTED_GRADER_GRANT_TAG)) return null;
  const key = graderCredentialKey();
  if (!key) return null;
  const parts = token.slice(HOSTED_GRADER_GRANT_TAG.length).split('.');
  if (parts.length !== 2) return null;
  const [payloadSegment, macSegment] = parts;
  if (!SEGMENT_PATTERN.test(payloadSegment) || !SEGMENT_PATTERN.test(macSegment)) return null;
  const expected = signGrader(key, payloadSegment);
  const presented = Buffer.from(macSegment, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let claims: Partial<WireClaims>;
  try {
    claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Partial<WireClaims>;
  } catch {
    return null;
  }
  if (
    claims.v !== 1
    || claims.aud !== GRADER_CREDENTIAL_AUDIENCE
    || claims.agent_url !== HOSTED_GRADER_BUYER_AGENT_URL
    || typeof claims.nonce !== 'string'
    || !NONCE_PATTERN.test(claims.nonce)
    || typeof claims.iat !== 'number'
    || typeof claims.exp !== 'number'
    || claims.exp - claims.iat > GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS
    || claims.iat > now + 60
    || claims.exp <= now
  ) {
    return null;
  }
  return { agentUrl: claims.agent_url, nonce: claims.nonce, iat: claims.iat, exp: claims.exp };
}

function hostedGraderCredentialPrincipal(claims: HostedGraderCredentialClaims): string {
  // Per-run and non-reversible, like the seller credential's principal.
  const digest = createHash('sha256').update(`${claims.agentUrl}\n${claims.nonce}`).digest('hex').slice(0, 32);
  return `${HOSTED_GRADER_GRANT_PRINCIPAL_TAG}${digest}`;
}

export function isHostedGraderCredentialPrincipal(principal: string | undefined): boolean {
  return typeof principal === 'string' && principal.startsWith(HOSTED_GRADER_GRANT_PRINCIPAL_TAG);
}

/** Resolve the credential on a request already authenticated as a hosted-grader principal. */
export function hostedGraderCredentialFromRequest(req: Request): HostedGraderCredentialClaims | null {
  return verifyHostedGraderCredential(bearerToken(req));
}

export const HOSTED_GRADER_CREDENTIAL_EXTRA_KEY = 'hosted_grader_credential';

/** Shape the router stamps on `req.auth.extra` for a verified grader credential. */
export interface HostedGraderCredentialExtra {
  agent_url: string;
  nonce: string;
}

/** Read the router-stamped grader scope from trusted auth `extra`. */
export function hostedGraderCredentialFromExtra(
  extra: Record<string, unknown> | undefined,
): Readonly<{ agentUrl: string; nonce: string }> | undefined {
  const value = extra?.[HOSTED_GRADER_CREDENTIAL_EXTRA_KEY] as Partial<HostedGraderCredentialExtra> | undefined;
  if (!value || typeof value !== 'object') return undefined;
  if (value.agent_url !== HOSTED_GRADER_BUYER_AGENT_URL || typeof value.nonce !== 'string') return undefined;
  return { agentUrl: value.agent_url, nonce: value.nonce };
}

/**
 * Tools a hosted-grader credential may call: the buyer side of one governed
 * run. Plan scope and intent-only checks are enforced in the handlers.
 */
const GRADER_ALLOWED_TOOLS = new Set([
  'get_adcp_capabilities',
  'sync_plans',
  'check_governance',
  'get_plan_audit_logs',
  'report_plan_outcome',
]);

/** Whether a JSON-RPC body is within the grader credential's allowed surface. */
export function isHostedGraderCredentialRequestAllowed(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const message = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof message.method !== 'string') return false;
  if (ALLOWED_MCP_METHODS.has(message.method)) return true;
  return message.method === 'tools/call'
    && typeof message.params?.name === 'string'
    && GRADER_ALLOWED_TOOLS.has(message.params.name);
}
