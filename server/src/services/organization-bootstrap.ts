/**
 * Durable exact-credential first-owner onboarding.
 *
 * WorkOS writes happen outside PostgreSQL transactions. A persisted operation
 * supplies a stable provider external ID and idempotency key, while the final
 * local transaction atomically commits the organization, exact membership,
 * domain proof, audit receipt, legal consent, marketing choice, and epoch.
 * Prospect adoption intentionally remains fail-closed: ownership is never
 * recovered from an email, domain string, linked identity, or canonical user.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { PoolClient } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { parse as parseDomain } from 'tldts';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { COMPANY_TYPE_VALUES } from '../config/company-types.js';
import { VALID_REVENUE_TIERS } from '../db/organization-db.js';
import { validateOrganizationName } from '../middleware/validation.js';
import { getCompanyDomain, isFreeEmailDomain, normalizeEmail } from '../utils/email-domain.js';
import { isInvalidWorkOSJWTError, verifyWorkOSJWT } from '../auth/workos-jwt.js';
import { bumpAuthorizationEpochs } from '../db/authorization-epoch-db.js';
import { invalidateSessionsForUsers } from '../middleware/auth.js';
import { invalidateMembershipCache } from '../db/org-filters.js';
import type { AuthorizationSnapshot } from '../db/user-authorization-snapshot-db.js';
import { assertValidBrandDomain, FREE_EMAIL_PROVIDER_DOMAINS } from './identifier-normalization.js';
import { lockExactCredentialAuthorizationRows } from './exact-credential-authorization-lock.js';

const logger = createLogger('organization-bootstrap');
// One attempt performs several independently bounded (5s, zero-retry) WorkOS
// calls. Keep the lease longer than their cumulative worst case so a normal
// slow attempt cannot be stolen between provider phases.
const LEASE_SECONDS = 90;
const REPLAY_WINDOW_HOURS = 24;

export interface CreateOrgRequest {
  user: {
    id: string;
    authWorkosUserId?: string;
    email: string;
    authorizationSnapshot?: AuthorizationSnapshot;
    impersonator?: { email: string; reason: string | null };
  };
  accessToken?: string;
  authorizationHeader?: string;
  isApiKey: boolean;
  isStaticAdminApiKey: boolean;
  organization_name: unknown;
  is_personal: unknown;
  company_type?: unknown;
  revenue_tier?: unknown;
  marketing_opt_in?: unknown;
  agreements_accepted?: unknown;
  terms_version?: unknown;
  privacy_version?: unknown;
  clientIdempotencyKey?: string;
  isDevUser: boolean;
  requestContext: { ip: string; userAgent: string };
}

export type CreateOrgOutcome =
  | { kind: 'created'; orgId: string; name: string; operationId: string }
  | { kind: 'org_limit_reached' }
  | { kind: 'personal_workspace_exists' }
  | { kind: 'missing_organization_name' }
  | { kind: 'invalid_organization_name'; message: string }
  | { kind: 'invalid_company_type' }
  | { kind: 'invalid_revenue_tier' }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'agreement_acceptance_required' }
  | { kind: 'corporate_email_required' }
  | { kind: 'verified_corporate_email_required' }
  | { kind: 'domain_taken'; existingOrgId: string; existingOrgName: string; domain: string }
  | { kind: 'prospect_adoption_unavailable'; existingOrgId: string; existingOrgName: string; domain: string }
  | { kind: 'invalid_credential' }
  | { kind: 'impersonation_not_allowed' }
  | { kind: 'credential_changed' }
  | { kind: 'authorization_unavailable' }
  | { kind: 'idempotency_mismatch' }
  | { kind: 'onboarding_in_progress'; operationId?: string }
  | { kind: 'onboarding_retryable'; operationId: string }
  | { kind: 'onboarding_reconciliation_required'; operationId: string };

type ValidatedInput = {
  organizationName: string;
  isPersonal: boolean;
  companyType: string | null;
  revenueTier: string | null;
  marketingOptIn: boolean | null;
  clientIdempotencyKey: string | null;
  termsVersion: string;
  privacyVersion: string;
};

type CredentialState = {
  credential_exists: boolean;
  terminal_marker: boolean;
  banned: boolean;
  email: string | null;
  email_verified: boolean;
  identity_id: string | null;
  canonical_user_id: string | null;
  primary_count: string;
  binding_version: string | null;
  authorization_epoch: string;
};

type ProviderIdentity = {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
};

type OperationStatus =
  | 'pending_provider_organization'
  | 'pending_provider_membership'
  | 'pending_local_commit'
  | 'compensating'
  | 'completed'
  | 'failed'
  | 'manual_reconciliation';

type OnboardingOperation = {
  id: string;
  authenticated_workos_user_id: string;
  canonical_workos_user_id: string;
  identity_id: string;
  binding_version: string;
  authorization_epoch: string;
  credential_email: string;
  credential_email_verified: boolean;
  request_fingerprint: string;
  client_idempotency_key: string | null;
  organization_name: string;
  is_personal: boolean;
  company_type: string | null;
  revenue_tier: string | null;
  marketing_opt_in: boolean | null;
  verified_domain: string | null;
  terms_version: string;
  privacy_version: string;
  consent_ip: string | null;
  consent_user_agent: string | null;
  provider_idempotency_key: string;
  provider_external_id: string;
  workos_organization_id: string | null;
  workos_organization_name: string | null;
  workos_membership_id: string | null;
  status: OperationStatus;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  terminal_outcome: unknown;
};

type DomainConflict = {
  workos_organization_id: string;
  name: string;
  prospect_status: string | null;
  subscription_status: string | null;
};

class FinalizationBusinessError extends Error {
  constructor(readonly outcome: CreateOrgOutcome) {
    super(outcome.kind);
  }
}

class AuthorityChangedError extends Error {}
class ProviderUnavailableError extends Error {}
class ProviderDivergenceError extends Error {}

function validateInput(input: CreateOrgRequest): CreateOrgOutcome | ValidatedInput {
  if (typeof input.organization_name !== 'string' || input.organization_name.length === 0) {
    return { kind: 'missing_organization_name' };
  }
  const nameValidation = validateOrganizationName(input.organization_name);
  if (!nameValidation.valid) {
    return { kind: 'invalid_organization_name', message: nameValidation.error || 'invalid' };
  }
  if (input.is_personal !== undefined && typeof input.is_personal !== 'boolean') {
    return { kind: 'invalid_request', message: 'is_personal must be a boolean' };
  }
  if (input.company_type !== undefined && input.company_type !== null
      && (typeof input.company_type !== 'string'
        || !COMPANY_TYPE_VALUES.includes(input.company_type as never))) {
    return { kind: 'invalid_company_type' };
  }
  if (input.revenue_tier !== undefined && input.revenue_tier !== null
      && (typeof input.revenue_tier !== 'string'
        || !(VALID_REVENUE_TIERS as readonly string[]).includes(input.revenue_tier))) {
    return { kind: 'invalid_revenue_tier' };
  }
  if (input.marketing_opt_in !== undefined && typeof input.marketing_opt_in !== 'boolean') {
    return { kind: 'invalid_request', message: 'marketing_opt_in must be a boolean' };
  }
  if (input.agreements_accepted !== true) return { kind: 'agreement_acceptance_required' };
  if (typeof input.terms_version !== 'string' || typeof input.privacy_version !== 'string'
      || input.terms_version.length === 0 || input.privacy_version.length === 0
      || input.terms_version.length > 50 || input.privacy_version.length > 50) {
    return { kind: 'agreement_acceptance_required' };
  }
  const clientIdempotencyKey = input.clientIdempotencyKey?.trim() || null;
  if (clientIdempotencyKey && (clientIdempotencyKey.length < 8 || clientIdempotencyKey.length > 255
      || /[^\x21-\x7e]/.test(clientIdempotencyKey))) {
    return { kind: 'invalid_request', message: 'Idempotency-Key must be 8-255 visible ASCII characters' };
  }
  return {
    organizationName: input.organization_name.trim(),
    isPersonal: input.is_personal === true,
    companyType: typeof input.company_type === 'string' ? input.company_type : null,
    revenueTier: typeof input.revenue_tier === 'string' ? input.revenue_tier : null,
    marketingOptIn: typeof input.marketing_opt_in === 'boolean' ? input.marketing_opt_in : null,
    clientIdempotencyKey,
    termsVersion: input.terms_version,
    privacyVersion: input.privacy_version,
  };
}

function requestFingerprint(validated: ValidatedInput, provider: ProviderIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    organization_name: validated.organizationName,
    is_personal: validated.isPersonal,
    company_type: validated.companyType,
    revenue_tier: validated.revenueTier,
    marketing_opt_in: validated.marketingOptIn,
    provider_user_id: provider.id,
    provider_email: normalizeEmail(provider.email),
    provider_email_verified: provider.emailVerified,
    terms_version: validated.termsVersion,
    privacy_version: validated.privacyVersion,
  })).digest('hex');
}

function providerStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; statusCode?: unknown } | null;
  const value = candidate?.status ?? candidate?.statusCode;
  return typeof value === 'number' ? value : undefined;
}

function providerCode(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : undefined;
}

function isProviderNotFound(error: unknown): boolean {
  return providerStatus(error) === 404 || providerCode(error) === 'not_found';
}

function isAmbiguousProviderFailure(error: unknown): boolean {
  const status = providerStatus(error);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

function isTransientDatabaseFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (
    code.startsWith('08')
    || ['40001', '40P01', '53300', '53400', '55P03', '57014', '57P01', '57P02', '57P03'].includes(code)
    || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code)
  )) return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause !== undefined && cause !== error && isTransientDatabaseFailure(cause);
}

async function verifyPresentedCredential(input: CreateOrgRequest, actorId: string): Promise<CreateOrgOutcome | null> {
  if (input.isApiKey || input.isStaticAdminApiKey || input.isDevUser || !input.accessToken) {
    return { kind: 'invalid_credential' };
  }
  if (input.authorizationHeader !== undefined) {
    const match = /^Bearer[\t ]+([^\t ]+)[\t ]*$/i.exec(input.authorizationHeader);
    if (!match || match[1] !== input.accessToken) return { kind: 'invalid_credential' };
  }
  try {
    const verified = await verifyWorkOSJWT(input.accessToken);
    if (verified.isM2M || verified.sub !== actorId) return { kind: 'invalid_credential' };
    if (verified.expiresAt !== undefined && verified.expiresAt <= Date.now() / 1000) {
      return { kind: 'invalid_credential' };
    }
  } catch (error) {
    return isInvalidWorkOSJWTError(error)
      ? { kind: 'invalid_credential' }
      : { kind: 'authorization_unavailable' };
  }
  return null;
}

async function fetchProviderIdentity(workos: WorkOS, actorId: string): Promise<ProviderIdentity> {
  try {
    const user = await workos.userManagement.getUser(actorId);
    if (!user || user.id !== actorId || typeof user.email !== 'string'
        || typeof user.emailVerified !== 'boolean') {
      throw new ProviderDivergenceError('Provider identity did not match the exact credential');
    }
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      firstName: user.firstName,
      lastName: user.lastName,
    };
  } catch (error) {
    if (error instanceof ProviderDivergenceError) throw error;
    if (isProviderNotFound(error)) throw new AuthorityChangedError('Credential no longer exists');
    throw new ProviderUnavailableError('Provider identity unavailable');
  }
}

async function lockCredentialRows(db: PoolClient, actorId: string): Promise<void> {
  await lockExactCredentialAuthorizationRows(db, [actorId]);
}

async function lockIdentityAuthorizationRows(db: PoolClient, identityId: string): Promise<void> {
  const before = await db.query<{ workos_user_id: string }>(
    `SELECT workos_user_id FROM identity_workos_users
      WHERE identity_id = $1 ORDER BY workos_user_id`,
    [identityId],
  );
  const ids = before.rows.map(row => row.workos_user_id);
  if (ids.length === 0) throw new AuthorityChangedError('Identity has no active credentials');
  await lockExactCredentialAuthorizationRows(db, ids);
  // Identity lifecycle writers lock the binding before this identity row.
  // NOWAIT preserves that order without waiting while holding sibling rows.
  await db.query('SELECT id FROM identities WHERE id = $1 FOR UPDATE NOWAIT', [identityId]);
  const after = await db.query<{ workos_user_id: string }>(
    `SELECT workos_user_id FROM identity_workos_users
      WHERE identity_id = $1 ORDER BY workos_user_id`,
    [identityId],
  );
  if (after.rows.map(row => row.workos_user_id).join('\0') !== ids.join('\0')) {
    throw new AuthorityChangedError('Identity credential set changed');
  }
}

function currentVerifiedCorporateDomain(email: string): string | null {
  const extracted = getCompanyDomain(email);
  if (!extracted) return null;
  const canonical = domainToASCII(extracted).toLowerCase();
  try {
    assertValidBrandDomain(canonical);
    const parsed = parseDomain(canonical, { allowPrivateDomains: true });
    if (!parsed.publicSuffix || canonical === parsed.publicSuffix
        || isFreeEmailDomain(canonical)
        || FREE_EMAIL_PROVIDER_DOMAINS.includes(canonical)) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

async function readCredentialState(db: Pick<PoolClient, 'query'>, actorId: string): Promise<CredentialState> {
  const result = await db.query<CredentialState>(
    `SELECT (u.workos_user_id IS NOT NULL) AS credential_exists,
            EXISTS (
              SELECT 1 FROM registry_audit_log audit
               WHERE audit.workos_user_id = $1
                 AND audit.action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')
            ) AS terminal_marker,
            EXISTS (
              SELECT 1 FROM bans
               WHERE scope = 'platform'
                 AND (expires_at IS NULL OR expires_at > clock_timestamp())
                 AND ban_type = 'user' AND entity_id = $1
            ) AS banned,
            u.email, COALESCE(u.email_verified, false) AS email_verified,
            binding.identity_id,
            primary_binding.workos_user_id AS canonical_user_id,
            COALESCE(primary_binding.primary_count, 0)::text AS primary_count,
            binding.xmin::text AS binding_version,
            COALESCE(epoch.epoch, 0)::text AS authorization_epoch
       FROM (VALUES (1)) anchor(value)
       LEFT JOIN users u ON u.workos_user_id = $1
       LEFT JOIN identity_workos_users binding ON binding.workos_user_id = u.workos_user_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS primary_count, MIN(candidate.workos_user_id) AS workos_user_id
           FROM identity_workos_users candidate
          WHERE candidate.identity_id = binding.identity_id AND candidate.is_primary
       ) primary_binding ON TRUE
       LEFT JOIN authorization_epochs epoch ON epoch.workos_user_id = u.workos_user_id`,
    [actorId],
  );
  if (result.rows.length !== 1) throw new ProviderUnavailableError('Credential state unavailable');
  return result.rows[0];
}

function assertLiveCredential(
  state: CredentialState,
  snapshot: AuthorizationSnapshot,
  provider: ProviderIdentity,
  actorId: string,
): void {
  if (!state.credential_exists || state.terminal_marker || state.banned
      || !state.identity_id || !state.canonical_user_id || state.primary_count !== '1'
      || !state.binding_version) {
    throw new AuthorityChangedError('Credential is no longer active');
  }
  if (snapshot.authenticatedUserId !== actorId
      || snapshot.canonicalUserId !== state.canonical_user_id
      || snapshot.identityId !== state.identity_id
      || snapshot.bindingVersion !== state.binding_version
      || snapshot.authorizationEpoch !== state.authorization_epoch
      || normalizeEmail(snapshot.credential.email ?? '') !== normalizeEmail(state.email ?? '')
      || snapshot.credential.emailVerified !== state.email_verified
      || provider.id !== actorId
      || normalizeEmail(provider.email) !== normalizeEmail(state.email ?? '')
      || provider.emailVerified !== state.email_verified) {
    throw new AuthorityChangedError('Credential proof changed');
  }
}

function assertOperationAuthority(
  state: CredentialState,
  operation: OnboardingOperation,
  provider: ProviderIdentity,
): void {
  if (!operationAuthorityMatches(state, operation, provider)) {
    throw new AuthorityChangedError('Operation authority changed');
  }
}

function operationAuthorityMatches(
  state: CredentialState,
  operation: OnboardingOperation,
  provider: ProviderIdentity,
): boolean {
  return state.credential_exists && !state.terminal_marker && !state.banned
      && state.primary_count === '1'
      && state.identity_id === operation.identity_id
      && state.canonical_user_id === operation.canonical_workos_user_id
      && state.binding_version === operation.binding_version
      && state.authorization_epoch === operation.authorization_epoch
      && normalizeEmail(state.email ?? '') === normalizeEmail(operation.credential_email)
      && state.email_verified === operation.credential_email_verified
      && provider.id === operation.authenticated_workos_user_id
      && normalizeEmail(provider.email) === normalizeEmail(operation.credential_email)
      && provider.emailVerified === operation.credential_email_verified;
}

function domainOutcome(domain: string, existing: DomainConflict): CreateOrgOutcome {
  const adoptable = !existing.subscription_status
    && (!existing.prospect_status || !['joined', 'declined'].includes(existing.prospect_status));
  return adoptable
    ? {
      kind: 'prospect_adoption_unavailable',
      existingOrgId: existing.workos_organization_id,
      existingOrgName: existing.name,
      domain,
    }
    : {
      kind: 'domain_taken',
      existingOrgId: existing.workos_organization_id,
      existingOrgName: existing.name,
      domain,
    };
}

function terminalFailureOutcome(operation: OnboardingOperation): CreateOrgOutcome {
  const value = operation.terminal_outcome as Partial<CreateOrgOutcome> | null;
  switch (value?.kind) {
    case 'org_limit_reached':
    case 'personal_workspace_exists':
    case 'agreement_acceptance_required':
    case 'credential_changed':
    case 'authorization_unavailable':
      return value as CreateOrgOutcome;
    case 'domain_taken':
    case 'prospect_adoption_unavailable':
      if (typeof (value as { existingOrgId?: unknown }).existingOrgId === 'string'
          && typeof (value as { existingOrgName?: unknown }).existingOrgName === 'string'
          && typeof (value as { domain?: unknown }).domain === 'string') {
        return value as CreateOrgOutcome;
      }
      break;
  }
  // Legacy or corrupted terminal rows must stay fail-closed and must never be
  // projected as a different successful/retryable operation.
  return { kind: 'authorization_unavailable' };
}

async function findDomainConflict(db: Pick<PoolClient, 'query'>, domain: string): Promise<DomainConflict | null> {
  const result = await db.query<DomainConflict>(
    `SELECT o.workos_organization_id, o.name, o.prospect_status, o.subscription_status
       FROM organizations o
       LEFT JOIN organization_domains od
         ON od.workos_organization_id = o.workos_organization_id
      WHERE LOWER(od.domain) = LOWER($1)
         OR LOWER(o.email_domain) = LOWER($1)
      ORDER BY CASE WHEN LOWER(od.domain) = LOWER($1) THEN 0 ELSE 1 END,
               o.created_at ASC
      LIMIT 1`,
    [domain],
  );
  return result.rows[0] ?? null;
}

async function countIdentityOrganizations(db: Pick<PoolClient, 'query'>, identityId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT membership.workos_organization_id)::text AS count
       FROM identity_workos_users credential
       JOIN organization_memberships membership
         ON membership.workos_user_id = credential.workos_user_id
      WHERE credential.identity_id = $1`,
    [identityId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function identityHasPersonalWorkspace(db: Pick<PoolClient, 'query'>, identityId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM identity_workos_users credential
       JOIN organization_memberships membership
         ON membership.workos_user_id = credential.workos_user_id
       JOIN organizations organization
         ON organization.workos_organization_id = membership.workos_organization_id
      WHERE credential.identity_id = $1 AND organization.is_personal = true
      LIMIT 1`,
    [identityId],
  );
  return result.rowCount === 1;
}

async function currentAgreementVersions(db: Pick<PoolClient, 'query'>): Promise<{ terms: string; privacy: string } | null> {
  const result = await db.query<{ agreement_type: string; version: string }>(
    `SELECT DISTINCT ON (agreement_type) agreement_type, version
       FROM agreements
      WHERE agreement_type IN ('terms_of_service', 'privacy_policy')
      ORDER BY agreement_type, effective_date DESC,
               string_to_array(version, '.')::int[] DESC`,
  );
  const terms = result.rows.find(row => row.agreement_type === 'terms_of_service')?.version;
  const privacy = result.rows.find(row => row.agreement_type === 'privacy_policy')?.version;
  return terms && privacy ? { terms, privacy } : null;
}

type PrepareResult =
  | { kind: 'execute'; operation: OnboardingOperation; leaseToken: string }
  | { kind: 'cleanup'; operation: OnboardingOperation; leaseToken: string }
  | { kind: 'outcome'; outcome: CreateOrgOutcome };

async function prepareOperation(
  input: CreateOrgRequest,
  validated: ValidatedInput,
  provider: ProviderIdentity,
  actorId: string,
  snapshot: AuthorizationSnapshot,
): Promise<PrepareResult> {
  const pool = getPool();
  const db = await pool.connect();
  const fingerprint = requestFingerprint(validated, provider);
  const verifiedDomain = validated.isPersonal ? null : currentVerifiedCorporateDomain(provider.email);
  if (!validated.isPersonal && !verifiedDomain) {
    db.release();
    return { kind: 'outcome', outcome: { kind: 'corporate_email_required' } };
  }
  if (!validated.isPersonal && !provider.emailVerified) {
    db.release();
    return { kind: 'outcome', outcome: { kind: 'verified_corporate_email_required' } };
  }
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 606))', [`onboarding-user:${actorId}`]);
    // Always take a second scope lock. Corporate onboarding serializes the
    // verified domain; personal onboarding uses the exact credential so
    // provider-controlled identity data cannot bypass a security lock.
    const onboardingScope = verifiedDomain
      ? `onboarding-domain:${verifiedDomain}`
      : `onboarding-personal:${actorId}`;
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 606))', [onboardingScope]);
    await lockCredentialRows(db, actorId);
    let state = await readCredentialState(db, actorId);
    if (!state.identity_id) throw new AuthorityChangedError('Credential identity changed');
    await lockIdentityAuthorizationRows(db, state.identity_id);
    state = await readCredentialState(db, actorId);
    assertLiveCredential(state, snapshot, provider, actorId);

    // Run both lookups regardless of whether the caller supplied an
    // idempotency key. This keeps the authorization-sensitive replay path
    // independent of a user-controlled branch; NULL simply cannot match a
    // stored key, and keyed requests are excluded from the fallback query.
    const keyed = await db.query<OnboardingOperation>(
      `SELECT * FROM organization_onboarding_operations
        WHERE authenticated_workos_user_id = $1 AND client_idempotency_key = $2
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [actorId, validated.clientIdempotencyKey ?? null],
    );
    const keyedOperation = keyed.rows[0];
    if (keyedOperation) {
      if (keyedOperation.request_fingerprint !== fingerprint) {
        if (keyedOperation.status === 'manual_reconciliation' || keyedOperation.status === 'compensating') {
          await db.query('COMMIT');
          return { kind: 'outcome', outcome: {
            kind: 'onboarding_reconciliation_required', operationId: keyedOperation.id,
          } };
        }
        if (keyedOperation.status !== 'completed' && keyedOperation.status !== 'failed'
            && !operationAuthorityMatches(state, keyedOperation, provider)) {
          if (keyedOperation.lease_token && keyedOperation.lease_expires_at
              && new Date(keyedOperation.lease_expires_at).getTime() > Date.now()) {
            await db.query('COMMIT');
            return { kind: 'outcome', outcome: {
              kind: 'onboarding_in_progress', operationId: keyedOperation.id,
            } };
          }
          const leaseToken = randomUUID();
          const claimed = await db.query<OnboardingOperation>(
            `UPDATE organization_onboarding_operations
                SET lease_token = $2,
                    lease_expires_at = NOW() + ($3::text || ' seconds')::interval,
                    updated_at = NOW()
              WHERE id = $1 RETURNING *`,
            [keyedOperation.id, leaseToken, String(LEASE_SECONDS)],
          );
          await db.query('COMMIT');
          return { kind: 'cleanup', operation: claimed.rows[0], leaseToken };
        }
        await db.query('ROLLBACK');
        return { kind: 'outcome', outcome: { kind: 'idempotency_mismatch' } };
      }
      if (keyedOperation.status === 'completed') {
        await db.query('COMMIT');
        return { kind: 'outcome', outcome: {
          kind: 'created', orgId: keyedOperation.workos_organization_id!,
          name: keyedOperation.workos_organization_name || keyedOperation.organization_name,
          operationId: keyedOperation.id,
        } };
      }
      if (keyedOperation.status === 'failed') {
        await db.query('COMMIT');
        return { kind: 'outcome', outcome: terminalFailureOutcome(keyedOperation) };
      }
    }
    const replay = await db.query<OnboardingOperation>(
      `SELECT * FROM organization_onboarding_operations
        WHERE authenticated_workos_user_id = $1
          AND request_fingerprint = $2 AND status = 'completed'
          AND completed_at > NOW() - ($3::text || ' hours')::interval
          AND $4::text IS NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [actorId, fingerprint, String(REPLAY_WINDOW_HOURS), validated.clientIdempotencyKey ?? null],
    );
    const replayOperation = replay.rows[0];
    if (replayOperation) {
      await db.query('COMMIT');
      return { kind: 'outcome', outcome: {
        kind: 'created', orgId: replayOperation.workos_organization_id!,
        name: replayOperation.workos_organization_name || replayOperation.organization_name,
        operationId: replayOperation.id,
      } };
    }

    const activeResult = await db.query<OnboardingOperation>(
      `SELECT * FROM organization_onboarding_operations
        WHERE authenticated_workos_user_id = $1 AND status NOT IN ('completed', 'failed')
        FOR UPDATE`,
      [actorId],
    );
    const active = activeResult.rows[0];
    if (active) {
      if (active.status === 'manual_reconciliation') {
        await db.query('COMMIT');
        return { kind: 'outcome', outcome: {
          kind: 'onboarding_reconciliation_required', operationId: active.id,
        } };
      }
      if (active.status === 'compensating' && active.request_fingerprint !== fingerprint) {
        await db.query('COMMIT');
        return { kind: 'outcome', outcome: {
          kind: 'onboarding_reconciliation_required', operationId: active.id,
        } };
      }
      // Never let a changed request or credential state steal a live worker's
      // lease. That worker may be between the provider write and durable local
      // persistence; compensation here could otherwise miss the provider
      // object, mark the operation failed, and orphan the later write.
      if (active.lease_token && active.lease_expires_at
          && new Date(active.lease_expires_at).getTime() > Date.now()) {
        await db.query('COMMIT');
        return { kind: 'outcome', outcome: { kind: 'onboarding_in_progress', operationId: active.id } };
      }
      const sameAuthority = active.identity_id === state.identity_id
        && active.canonical_workos_user_id === state.canonical_user_id
        && active.binding_version === state.binding_version
        && active.authorization_epoch === state.authorization_epoch
        && normalizeEmail(active.credential_email) === normalizeEmail(provider.email)
        && active.credential_email_verified === provider.emailVerified;
      if (!sameAuthority || active.request_fingerprint !== fingerprint) {
        const leaseToken = randomUUID();
        await db.query(
          `UPDATE organization_onboarding_operations
              SET lease_token = $2, lease_expires_at = NOW() + ($3::text || ' seconds')::interval,
                  updated_at = NOW()
            WHERE id = $1`,
          [active.id, leaseToken, String(LEASE_SECONDS)],
        );
        await db.query('COMMIT');
        return { kind: 'cleanup', operation: { ...active, lease_token: leaseToken }, leaseToken };
      }
      const leaseToken = randomUUID();
      const claimed = await db.query<OnboardingOperation>(
        `UPDATE organization_onboarding_operations
            SET lease_token = $2, lease_expires_at = NOW() + ($3::text || ' seconds')::interval,
                updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [active.id, leaseToken, String(LEASE_SECONDS)],
      );
      await db.query('COMMIT');
      return { kind: 'execute', operation: claimed.rows[0], leaseToken };
    }

    if (await countIdentityOrganizations(db, state.identity_id!) >= 10) {
      await db.query('ROLLBACK');
      return { kind: 'outcome', outcome: { kind: 'org_limit_reached' } };
    }
    if (validated.isPersonal && await identityHasPersonalWorkspace(db, state.identity_id!)) {
      await db.query('ROLLBACK');
      return { kind: 'outcome', outcome: { kind: 'personal_workspace_exists' } };
    }
    if (verifiedDomain) {
      const existing = await findDomainConflict(db, verifiedDomain);
      if (existing) {
        await db.query('ROLLBACK');
        return { kind: 'outcome', outcome: domainOutcome(verifiedDomain, existing) };
      }
      const reserved = await db.query(
        `SELECT 1 FROM organization_onboarding_operations
          WHERE verified_domain = $1 AND status NOT IN ('completed', 'failed')
          LIMIT 1`,
        [verifiedDomain],
      );
      if (reserved.rowCount) {
        await db.query('ROLLBACK');
        return { kind: 'outcome', outcome: { kind: 'onboarding_in_progress' } };
      }
    }
    await db.query('LOCK TABLE agreements IN SHARE MODE NOWAIT');
    const agreements = await currentAgreementVersions(db);
    if (!agreements) throw new ProviderUnavailableError('Current legal agreements unavailable');
    if (agreements.terms !== validated.termsVersion
        || agreements.privacy !== validated.privacyVersion) {
      await db.query('ROLLBACK');
      return { kind: 'outcome', outcome: { kind: 'agreement_acceptance_required' } };
    }

    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const inserted = await db.query<OnboardingOperation>(
      `INSERT INTO organization_onboarding_operations (
         id, authenticated_workos_user_id, canonical_workos_user_id, identity_id,
         binding_version, authorization_epoch, credential_email, credential_email_verified,
         request_fingerprint, client_idempotency_key, organization_name, is_personal,
         company_type, revenue_tier, marketing_opt_in, verified_domain,
         terms_version, privacy_version, consent_ip, consent_user_agent,
         provider_idempotency_key, provider_external_id, lease_token, lease_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         NOW() + ($24::text || ' seconds')::interval
       ) RETURNING *`,
      [
        operationId, actorId, state.canonical_user_id, state.identity_id,
        state.binding_version, state.authorization_epoch, provider.email, provider.emailVerified,
        fingerprint, validated.clientIdempotencyKey, validated.organizationName, validated.isPersonal,
        validated.companyType, validated.revenueTier, validated.marketingOptIn, verifiedDomain,
        validated.termsVersion, validated.privacyVersion,
        input.requestContext.ip, input.requestContext.userAgent,
        randomUUID(), `adcp_onboarding_${operationId}`, leaseToken, String(LEASE_SECONDS),
      ],
    );
    await db.query('COMMIT');
    return { kind: 'execute', operation: inserted.rows[0], leaseToken };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (error instanceof AuthorityChangedError) return { kind: 'outcome', outcome: { kind: 'credential_changed' } };
    if ((error as { code?: string }).code === '23505') {
      return { kind: 'outcome', outcome: { kind: 'onboarding_in_progress' } };
    }
    logger.error({ error, actorId }, 'Failed to prepare organization onboarding operation');
    return { kind: 'outcome', outcome: { kind: 'authorization_unavailable' } };
  } finally {
    db.release();
  }
}

async function persistOperation(
  operationId: string,
  leaseToken: string,
  patch: {
    status?: OperationStatus;
    workosOrganizationId?: string;
    workosOrganizationName?: string;
    workosMembershipId?: string;
    errorCode?: string | null;
    releaseLease?: boolean;
  },
): Promise<OnboardingOperation> {
  let result;
  try {
    result = await getPool().query<OnboardingOperation>(
      `UPDATE organization_onboarding_operations
        SET status = COALESCE($3, status),
            workos_organization_id = COALESCE($4, workos_organization_id),
            workos_organization_name = COALESCE($5, workos_organization_name),
            workos_membership_id = COALESCE($6, workos_membership_id),
            last_error_code = $7,
            lease_token = CASE WHEN $8 THEN NULL ELSE lease_token END,
            lease_expires_at = CASE WHEN $8 THEN NULL ELSE lease_expires_at END,
            updated_at = NOW()
      WHERE id = $1 AND lease_token = $2
       RETURNING *`,
      [
        operationId, leaseToken, patch.status ?? null,
        patch.workosOrganizationId ?? null, patch.workosOrganizationName ?? null,
        patch.workosMembershipId ?? null, patch.errorCode ?? null,
        patch.releaseLease === true,
      ],
    );
  } catch {
    // UPDATE acknowledgement can be lost after PostgreSQL commits. Never
    // compensate a provider object on an ambiguous ledger write: a retry can
    // reconcile both the pre- and post-commit database states safely.
    throw new ProviderUnavailableError('Onboarding operation persistence unavailable');
  }
  if (result.rowCount !== 1) throw new ProviderDivergenceError('Operation lease changed');
  return result.rows[0];
}

async function renewOperationLease(operationId: string, leaseToken: string): Promise<void> {
  let result;
  try {
    result = await getPool().query(
      `UPDATE organization_onboarding_operations
          SET lease_expires_at = NOW() + ($3::text || ' seconds')::interval,
              updated_at = NOW()
        WHERE id = $1 AND lease_token = $2
          AND status NOT IN ('completed', 'failed', 'manual_reconciliation')`,
      [operationId, leaseToken, String(LEASE_SECONDS)],
    );
  } catch {
    throw new ProviderUnavailableError('Onboarding lease renewal unavailable');
  }
  if (result.rowCount !== 1) throw new ProviderDivergenceError('Operation lease changed');
}

async function liveOperationAuthority(
  workos: WorkOS,
  operation: OnboardingOperation,
  leaseToken: string,
): Promise<ProviderIdentity> {
  await renewOperationLease(operation.id, leaseToken);
  const provider = await fetchProviderIdentity(workos, operation.authenticated_workos_user_id);
  const state = await readCredentialState(getPool(), operation.authenticated_workos_user_id);
  assertOperationAuthority(state, operation, provider);
  return provider;
}

function validateProviderOrganization(value: unknown): { id: string; name: string } {
  const org = value as { id?: unknown; name?: unknown } | null;
  if (!org || typeof org.id !== 'string' || typeof org.name !== 'string') {
    throw new ProviderDivergenceError('Invalid provider organization response');
  }
  return { id: org.id, name: org.name };
}

async function ensureProviderOrganization(
  workos: WorkOS,
  operation: OnboardingOperation,
  leaseToken: string,
): Promise<OnboardingOperation> {
  if (operation.workos_organization_id) {
    await renewOperationLease(operation.id, leaseToken);
    try {
      const providerOrganization = validateProviderOrganization(
        await workos.organizations.getOrganizationByExternalId(operation.provider_external_id),
      );
      if (providerOrganization.id !== operation.workos_organization_id) {
        throw new ProviderDivergenceError('Stored provider organization no longer matches its external ID');
      }
      return operation;
    } catch (error) {
      if (error instanceof ProviderDivergenceError || isProviderNotFound(error)) {
        throw new ProviderDivergenceError('Stored provider organization is no longer authoritative');
      }
      throw new ProviderUnavailableError('Stored provider organization could not be confirmed');
    }
  }
  await liveOperationAuthority(workos, operation, leaseToken);
  let providerOrganization: { id: string; name: string } | null = null;
  try {
    providerOrganization = validateProviderOrganization(
      await workos.organizations.getOrganizationByExternalId(operation.provider_external_id),
    );
  } catch (error) {
    if (!isProviderNotFound(error)) {
      if (error instanceof ProviderDivergenceError) throw error;
      throw new ProviderUnavailableError('Provider organization lookup unavailable');
    }
  }
  if (!providerOrganization) {
    await renewOperationLease(operation.id, leaseToken);
    try {
      providerOrganization = validateProviderOrganization(
        await workos.organizations.createOrganization(
          {
            name: operation.organization_name,
            externalId: operation.provider_external_id,
            metadata: { onboarding_operation_id: operation.id },
          },
          { idempotencyKey: operation.provider_idempotency_key },
        ),
      );
    } catch (error) {
      if (providerStatus(error) === 409) {
        try {
          providerOrganization = validateProviderOrganization(
            await workos.organizations.getOrganizationByExternalId(operation.provider_external_id),
          );
        } catch {
          throw new ProviderUnavailableError('Provider organization conflict could not be reconciled');
        }
      } else if (isAmbiguousProviderFailure(error)) {
        throw new ProviderUnavailableError('Provider organization creation was not confirmed');
      } else {
        throw error;
      }
    }
  }
  operation = await persistOperation(operation.id, leaseToken, {
    status: 'pending_provider_membership',
    workosOrganizationId: providerOrganization.id,
    workosOrganizationName: providerOrganization.name,
  });
  await liveOperationAuthority(workos, operation, leaseToken);
  return operation;
}

type ProviderMembership = {
  id: string;
  userId: string;
  organizationId: string;
  status: string;
  role?: { slug?: string } | null;
};

async function readExactProviderMembership(workos: WorkOS, operation: OnboardingOperation): Promise<ProviderMembership | null> {
  let page;
  try {
    page = await workos.userManagement.listOrganizationMemberships({
      userId: operation.authenticated_workos_user_id,
      organizationId: operation.workos_organization_id!,
      statuses: ['active', 'inactive', 'pending'],
    });
  } catch {
    throw new ProviderUnavailableError('Provider membership lookup unavailable');
  }
  if (!page || !Array.isArray(page.data)) throw new ProviderDivergenceError('Invalid provider membership response');
  const rows = (page.data as ProviderMembership[]).filter(row => row
    && row.userId === operation.authenticated_workos_user_id
    && row.organizationId === operation.workos_organization_id);
  if (rows.length > 1) throw new ProviderDivergenceError('Provider membership state is ambiguous');
  return rows[0] ?? null;
}

function assertFirstOwnerMembership(operation: OnboardingOperation, membership: ProviderMembership): void {
  if (membership.userId !== operation.authenticated_workos_user_id
      || membership.organizationId !== operation.workos_organization_id
      || membership.status !== 'active' || membership.role?.slug !== 'owner'
      || typeof membership.id !== 'string') {
    throw new ProviderDivergenceError('Provider did not confirm the exact first owner');
  }
}

async function ensureProviderMembership(
  workos: WorkOS,
  operation: OnboardingOperation,
  leaseToken: string,
): Promise<OnboardingOperation> {
  await liveOperationAuthority(workos, operation, leaseToken);
  let membership = await readExactProviderMembership(workos, operation);
  if (!membership) {
    await renewOperationLease(operation.id, leaseToken);
    try {
      membership = await workos.userManagement.createOrganizationMembership({
        userId: operation.authenticated_workos_user_id,
        organizationId: operation.workos_organization_id!,
        roleSlug: 'owner',
      }) as ProviderMembership;
    } catch (error) {
      if (providerCode(error) === 'organization_membership_already_exists'
          || providerStatus(error) === 409) {
        membership = await readExactProviderMembership(workos, operation);
      } else if (isAmbiguousProviderFailure(error)) {
        throw new ProviderUnavailableError('Provider owner creation was not confirmed');
      } else {
        throw error;
      }
    }
  }
  if (!membership) throw new ProviderUnavailableError('Provider owner creation was not confirmed');
  assertFirstOwnerMembership(operation, membership);
  operation = await persistOperation(operation.id, leaseToken, {
    status: 'pending_local_commit', workosMembershipId: membership.id,
  });
  await liveOperationAuthority(workos, operation, leaseToken);
  return operation;
}

async function writeMarketingChoice(db: PoolClient, operation: OnboardingOperation): Promise<void> {
  if (operation.marketing_opt_in === null) return;
  const token = randomBytes(32).toString('hex');
  const inserted = await db.query<{ id: string; marketing_opt_in: boolean | null }>(
    `INSERT INTO user_email_preferences (workos_user_id, email, unsubscribe_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (workos_user_id) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, marketing_opt_in`,
    [operation.authenticated_workos_user_id, operation.credential_email, token],
  );
  const preference = inserted.rows[0];
  if (preference.marketing_opt_in !== null) return;
  await db.query(
    `UPDATE user_email_preferences
        SET marketing_opt_in = $2, marketing_opt_in_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND marketing_opt_in IS NULL`,
    [preference.id, operation.marketing_opt_in],
  );
  if (operation.marketing_opt_in) {
    await db.query('DELETE FROM user_email_category_preferences WHERE user_preference_id = $1', [preference.id]);
  } else {
    await db.query(
      `INSERT INTO user_email_category_preferences (user_preference_id, category_id, enabled)
       SELECT $1, id, false FROM email_categories
       ON CONFLICT (user_preference_id, category_id)
       DO UPDATE SET enabled = false, updated_at = NOW()`,
      [preference.id],
    );
  }
}

async function finalizeLocalOperation(
  workos: WorkOS,
  operation: OnboardingOperation,
  leaseToken: string,
): Promise<CreateOrgOutcome> {
  const db = await getPool().connect();
  let commitAttempted = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '8s'");
    const locked = await db.query<OnboardingOperation>(
      'SELECT * FROM organization_onboarding_operations WHERE id = $1 FOR UPDATE',
      [operation.id],
    );
    operation = locked.rows[0];
    if (!operation || operation.lease_token !== leaseToken) {
      throw new ProviderDivergenceError('Operation lease changed');
    }
    if (operation.status === 'completed') {
      await db.query('COMMIT');
      return {
        kind: 'created', orgId: operation.workos_organization_id!,
        name: operation.workos_organization_name || operation.organization_name,
        operationId: operation.id,
      };
    }
    await lockCredentialRows(db, operation.authenticated_workos_user_id);
    let state = await readCredentialState(db, operation.authenticated_workos_user_id);
    if (state.identity_id !== operation.identity_id) {
      throw new AuthorityChangedError('Credential identity changed');
    }
    await lockIdentityAuthorizationRows(db, operation.identity_id);
    state = await readCredentialState(db, operation.authenticated_workos_user_id);

    // These are the only bounded network reads made while local authorization
    // rows are locked. The enforcement WorkOS client has a 5s timeout and no
    // retries, so credential/domain state cannot drift across the local commit.
    const provider = await fetchProviderIdentity(workos, operation.authenticated_workos_user_id);
    assertOperationAuthority(state, operation, provider);
    const membership = await readExactProviderMembership(workos, operation);
    if (!membership) throw new ProviderDivergenceError('Provider owner disappeared before commit');
    assertFirstOwnerMembership(operation, membership);
    if (membership.id !== operation.workos_membership_id) {
      throw new ProviderDivergenceError('Provider owner changed before commit');
    }

    await db.query('LOCK TABLE agreements IN SHARE MODE NOWAIT');
    const agreements = await currentAgreementVersions(db);
    if (!agreements || agreements.terms !== operation.terms_version
        || agreements.privacy !== operation.privacy_version) {
      throw new FinalizationBusinessError({ kind: 'agreement_acceptance_required' });
    }
    if (await countIdentityOrganizations(db, operation.identity_id) >= 10) {
      throw new FinalizationBusinessError({ kind: 'org_limit_reached' });
    }
    if (operation.is_personal && await identityHasPersonalWorkspace(db, operation.identity_id)) {
      throw new FinalizationBusinessError({ kind: 'personal_workspace_exists' });
    }
    if (operation.verified_domain) {
      const existing = await findDomainConflict(db, operation.verified_domain);
      if (existing) throw new FinalizationBusinessError(domainOutcome(operation.verified_domain, existing));
    }

    await db.query(
      `INSERT INTO organizations
       (workos_organization_id, name, is_personal, company_type, revenue_tier, email_domain)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        operation.workos_organization_id, operation.workos_organization_name || operation.organization_name,
        operation.is_personal, operation.company_type, operation.revenue_tier,
        operation.verified_domain,
      ],
    );
    await db.query(
      `INSERT INTO organization_memberships
       (workos_user_id, workos_organization_id, workos_membership_id, email,
        first_name, last_name, role, seat_type, provisioning_source, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'contributor', 'webhook', NOW())`,
      [
        operation.authenticated_workos_user_id, operation.workos_organization_id,
        operation.workos_membership_id, provider.email,
        provider.firstName?.trim() || null, provider.lastName?.trim() || null,
      ],
    );
    if (operation.verified_domain) {
      await db.query(
        `INSERT INTO organization_domains
         (workos_organization_id, domain, is_primary, verified, source)
         VALUES ($1, $2, true, true, 'email_verification')`,
        [operation.workos_organization_id, operation.verified_domain],
      );
    }
    await db.query(
      `INSERT INTO registry_audit_log
       (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
       VALUES ($1::varchar, $2, 'organization_created', 'organization', $1::varchar, $3)`,
      [operation.workos_organization_id, operation.authenticated_workos_user_id, JSON.stringify({
        operation_id: operation.id,
        authenticated_workos_user_id: operation.authenticated_workos_user_id,
        canonical_workos_user_id: operation.canonical_workos_user_id,
        identity_id: operation.identity_id,
        binding_version: operation.binding_version,
        authorization_epoch: operation.authorization_epoch,
        authority: 'exact_credential_first_owner',
        provider_identity_verified: true,
        verified_domain: operation.verified_domain,
        is_personal: operation.is_personal,
        company_type: operation.company_type,
        revenue_tier: operation.revenue_tier,
      })],
    );
    for (const [agreementType, version] of [
      ['terms_of_service', operation.terms_version],
      ['privacy_policy', operation.privacy_version],
    ] as const) {
      const accepted = await db.query(
        `INSERT INTO user_agreement_acceptances
         (workos_user_id, email, agreement_type, agreement_version, ip_address,
          user_agent, workos_organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workos_user_id, agreement_type, agreement_version) DO NOTHING
         RETURNING id`,
        [
          operation.authenticated_workos_user_id, provider.email, agreementType, version,
          operation.consent_ip, operation.consent_user_agent, operation.workos_organization_id,
        ],
      );
      if (accepted.rowCount !== 1) {
        const existing = await db.query(
          `SELECT 1 FROM user_agreement_acceptances
            WHERE workos_user_id = $1 AND agreement_type = $2 AND agreement_version = $3`,
          [operation.authenticated_workos_user_id, agreementType, version],
        );
        if (existing.rowCount !== 1) throw new Error('Agreement acceptance was not recorded');
      }
    }
    await writeMarketingChoice(db, operation);
    const bumped = await bumpAuthorizationEpochs(db, [operation.authenticated_workos_user_id]);
    if (bumped.length !== 1) throw new Error('Authorization epoch was not advanced');
    const completed = await db.query(
      `UPDATE organization_onboarding_operations
          SET status = 'completed', completed_at = NOW(), lease_token = NULL,
              lease_expires_at = NULL, last_error_code = NULL, updated_at = NOW()
        WHERE id = $1 AND lease_token = $2 AND status = 'pending_local_commit'`,
      [operation.id, leaseToken],
    );
    if (completed.rowCount !== 1) throw new Error('Onboarding operation state changed');
    commitAttempted = true;
    await db.query('COMMIT');
    invalidateMembershipCache(operation.workos_organization_id!);
    invalidateSessionsForUsers([operation.authenticated_workos_user_id]);
    return {
      kind: 'created', orgId: operation.workos_organization_id!,
      name: operation.workos_organization_name || operation.organization_name,
      operationId: operation.id,
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (commitAttempted) {
      const recovered = await getPool().query<OnboardingOperation>(
        'SELECT * FROM organization_onboarding_operations WHERE id = $1', [operation.id],
      ).catch(() => ({ rows: [] as OnboardingOperation[] }));
      const row = recovered.rows[0];
      if (row?.status === 'completed') {
        return {
          kind: 'created', orgId: row.workos_organization_id!,
          name: row.workos_organization_name || row.organization_name,
          operationId: row.id,
        };
      }
      throw new ProviderUnavailableError('Local commit outcome is not yet confirmed');
    }
    throw error;
  } finally {
    db.release();
  }
}

async function markOperation(
  operationId: string,
  leaseToken: string,
  status: OperationStatus,
  errorCode: string,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE organization_onboarding_operations
        SET status = $3, last_error_code = $4, lease_token = NULL,
            lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1 AND lease_token = $2`,
    [operationId, leaseToken, status, errorCode],
  );
  return result.rowCount === 1;
}

async function beginCompensation(
  operation: OnboardingOperation,
  leaseToken: string,
  reason: string,
  outcome: CreateOrgOutcome,
): Promise<OnboardingOperation> {
  let result;
  try {
    result = await getPool().query<OnboardingOperation>(
      `UPDATE organization_onboarding_operations
          SET status = 'compensating', last_error_code = $3,
              terminal_outcome = $4::jsonb,
              lease_expires_at = NOW() + ($5::text || ' seconds')::interval,
              updated_at = NOW()
        WHERE id = $1 AND lease_token = $2
          AND status NOT IN ('completed', 'failed', 'manual_reconciliation')
        RETURNING *`,
      [operation.id, leaseToken, reason, JSON.stringify(outcome), String(LEASE_SECONDS)],
    );
  } catch {
    // The acknowledgement may have been lost after commit. No provider
    // deletion is safe until a later worker observes durable compensation.
    throw new ProviderUnavailableError('Compensation intent persistence unavailable');
  }
  if (result.rowCount !== 1) throw new ProviderDivergenceError('Operation lease changed');
  return result.rows[0];
}

async function compensateProviderOrganization(
  workos: WorkOS,
  operation: OnboardingOperation,
  leaseToken: string,
  reason: string,
  outcome: CreateOrgOutcome,
): Promise<boolean> {
  try {
    operation = await beginCompensation(operation, leaseToken, reason, outcome);
  } catch {
    // A successor owns the operation, or PostgreSQL cannot prove durable
    // compensation intent. In either case this worker must not delete.
    return false;
  }
  let organizationId = operation.workos_organization_id;
  if (!organizationId) {
    try {
      const provider = validateProviderOrganization(
        await workos.organizations.getOrganizationByExternalId(operation.provider_external_id),
      );
      organizationId = provider.id;
      operation = await persistOperation(operation.id, leaseToken, {
        status: 'compensating',
        workosOrganizationId: provider.id,
        workosOrganizationName: provider.name,
        errorCode: reason,
      });
    } catch (error) {
      if (isProviderNotFound(error)) {
        return markOperation(operation.id, leaseToken, 'failed', reason).catch(() => false);
      }
      await persistOperation(operation.id, leaseToken, {
        status: 'compensating', errorCode: `${reason}:lookup_unavailable`, releaseLease: true,
      }).catch(() => {});
      return false;
    }
  }
  const local = await getPool().query(
    'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
    [organizationId],
  ).catch(() => null);
  if (local === null || local.rowCount) {
    await markOperation(operation.id, leaseToken, 'manual_reconciliation', `${reason}:local_state_uncertain`).catch(() => {});
    return false;
  }
  try {
    await renewOperationLease(operation.id, leaseToken);
  } catch {
    return false;
  }
  try {
    await workos.organizations.deleteOrganization(organizationId);
    return markOperation(operation.id, leaseToken, 'failed', reason).catch(() => false);
  } catch (error) {
    if (isProviderNotFound(error)) {
      return markOperation(operation.id, leaseToken, 'failed', reason).catch(() => false);
    }
    try {
      await workos.organizations.getOrganizationByExternalId(operation.provider_external_id);
    } catch (checkError) {
      if (isProviderNotFound(checkError)) {
        return markOperation(operation.id, leaseToken, 'failed', reason).catch(() => false);
      }
    }
    await persistOperation(operation.id, leaseToken, {
      status: 'compensating', errorCode: `${reason}:delete_unconfirmed`, releaseLease: true,
    }).catch(() => {});
    return false;
  }
}

async function executeOperation(
  workos: WorkOS,
  operation: OnboardingOperation,
  leaseToken: string,
): Promise<CreateOrgOutcome> {
  if (operation.status === 'compensating') {
    const outcome = terminalFailureOutcome(operation);
    const cleaned = await compensateProviderOrganization(
      workos, operation, leaseToken, operation.last_error_code || outcome.kind, outcome,
    );
    return cleaned ? outcome
      : { kind: 'onboarding_reconciliation_required', operationId: operation.id };
  }
  try {
    operation = await ensureProviderOrganization(workos, operation, leaseToken);
    operation = await ensureProviderMembership(workos, operation, leaseToken);
    return await finalizeLocalOperation(workos, operation, leaseToken);
  } catch (error) {
    if (error instanceof FinalizationBusinessError) {
      const cleaned = await compensateProviderOrganization(
        workos, operation, leaseToken, error.outcome.kind, error.outcome,
      );
      return cleaned ? error.outcome
        : { kind: 'onboarding_reconciliation_required', operationId: operation.id };
    }
    if (error instanceof AuthorityChangedError) {
      const terminal: CreateOrgOutcome = { kind: 'credential_changed' };
      const cleaned = await compensateProviderOrganization(
        workos, operation, leaseToken, terminal.kind, terminal,
      );
      return cleaned ? { kind: 'credential_changed' }
        : { kind: 'onboarding_reconciliation_required', operationId: operation.id };
    }
    if (error instanceof ProviderDivergenceError) {
      await markOperation(operation.id, leaseToken, 'manual_reconciliation', 'provider_state_diverged').catch(() => {});
      return { kind: 'onboarding_reconciliation_required', operationId: operation.id };
    }
    if (error instanceof ProviderUnavailableError || isTransientDatabaseFailure(error)) {
      await persistOperation(operation.id, leaseToken, {
        errorCode: 'retryable_provider_or_database_failure', releaseLease: true,
      }).catch(() => {});
      return { kind: 'onboarding_retryable', operationId: operation.id };
    }
    logger.error({ error, operationId: operation.id }, 'Organization onboarding failed');
    const terminal: CreateOrgOutcome = { kind: 'authorization_unavailable' };
    const cleaned = await compensateProviderOrganization(
      workos, operation, leaseToken, 'non_retryable_provider_failure', terminal,
    );
    return cleaned ? { kind: 'authorization_unavailable' }
      : { kind: 'onboarding_reconciliation_required', operationId: operation.id };
  }
}

export async function performCreateOrganization(
  input: CreateOrgRequest,
  deps: { workos: WorkOS | null },
): Promise<CreateOrgOutcome> {
  const validated = validateInput(input);
  if ('kind' in validated) return validated;
  if (input.user.impersonator) return { kind: 'impersonation_not_allowed' };
  const actorId = input.user.authWorkosUserId ?? input.user.id;
  const credentialError = await verifyPresentedCredential(input, actorId);
  if (credentialError) return credentialError;
  const snapshot = input.user.authorizationSnapshot;
  if (!snapshot) return { kind: 'authorization_unavailable' };
  if (!deps.workos) return { kind: 'authorization_unavailable' };

  let provider: ProviderIdentity;
  try {
    provider = await fetchProviderIdentity(deps.workos, actorId);
  } catch (error) {
    return error instanceof AuthorityChangedError || error instanceof ProviderDivergenceError
      ? { kind: 'credential_changed' }
      : { kind: 'authorization_unavailable' };
  }

  const prepared = await prepareOperation(input, validated, provider, actorId, snapshot);
  if (prepared.kind === 'outcome') return prepared.outcome;
  if (prepared.kind === 'cleanup') {
    const cleaned = await compensateProviderOrganization(
      deps.workos, prepared.operation, prepared.leaseToken, 'superseded_or_changed_request',
      { kind: 'credential_changed' },
    );
    return cleaned ? { kind: 'credential_changed' }
      : { kind: 'onboarding_reconciliation_required', operationId: prepared.operation.id };
  }
  return executeOperation(deps.workos, prepared.operation, prepared.leaseToken);
}

export type OrganizationOnboardingReconciliationResult = {
  attempted: number;
  completed: number;
  compensated: number;
  retryable: number;
  manual: number;
};

export type ManualOrganizationOnboardingOperation = {
  id: string;
  authenticatedWorkosUserId: string;
  workosOrganizationId: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Return durable manual-reconciliation records for the operator escalation
 * worker. These rows are deliberately not executed automatically: their
 * provider/local authority state is ambiguous and requires human review.
 */
export async function listManualOrganizationOnboardingOperations(
  limit = 10,
): Promise<ManualOrganizationOnboardingOperation[]> {
  const boundedLimit = Math.max(0, Math.min(limit, 25));
  if (boundedLimit === 0) return [];
  const result = await getPool().query<{
    id: string;
    authenticated_workos_user_id: string;
    workos_organization_id: string | null;
    last_error_code: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT operation.id, operation.authenticated_workos_user_id,
            operation.workos_organization_id, operation.last_error_code,
            operation.created_at, operation.updated_at
       FROM organization_onboarding_operations operation
      WHERE operation.status = 'manual_reconciliation'
        AND NOT EXISTS (
          SELECT 1
            FROM addie_escalations escalation
           WHERE escalation.dedup_key =
                 'organization-onboarding-reconciliation:' || operation.id::text
             AND escalation.status IN ('open', 'acknowledged', 'in_progress')
        )
      ORDER BY operation.updated_at, operation.created_at
      LIMIT $1`,
    [boundedLimit],
  );
  return result.rows.map(row => ({
    id: row.id,
    authenticatedWorkosUserId: row.authenticated_workos_user_id,
    workosOrganizationId: row.workos_organization_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function claimReconciliationOperation(excludedIds: string[]): Promise<{
  operation: OnboardingOperation;
  leaseToken: string;
} | null> {
  const leaseToken = randomUUID();
  const result = await getPool().query<OnboardingOperation>(
    `UPDATE organization_onboarding_operations operation
        SET lease_token = $2,
            lease_expires_at = NOW() + ($3::text || ' seconds')::interval,
            updated_at = NOW()
      WHERE operation.id = (
        SELECT candidate.id
          FROM organization_onboarding_operations candidate
         WHERE candidate.status IN (
                 'pending_provider_organization',
                 'pending_provider_membership',
                 'pending_local_commit',
                 'compensating'
               )
           AND (candidate.lease_token IS NULL OR candidate.lease_expires_at <= NOW())
           AND NOT (candidate.id = ANY($1::uuid[]))
         ORDER BY candidate.updated_at, candidate.created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING operation.*`,
    [excludedIds, leaseToken, String(LEASE_SECONDS)],
  );
  return result.rows[0] ? { operation: result.rows[0], leaseToken } : null;
}

/**
 * Resume provider/local operations whose request worker stopped or returned a
 * retryable response. Each operation is fenced by the same durable lease and
 * revalidates the exact current credential before any authority commit.
 */
export async function reconcilePendingOrganizationOnboarding(
  workos: WorkOS,
  limit = 2,
): Promise<OrganizationOnboardingReconciliationResult> {
  const result: OrganizationOnboardingReconciliationResult = {
    attempted: 0, completed: 0, compensated: 0, retryable: 0, manual: 0,
  };
  const attemptedIds: string[] = [];
  for (let index = 0; index < Math.max(0, Math.min(limit, 10)); index++) {
    const claimed = await claimReconciliationOperation(attemptedIds);
    if (!claimed) break;
    attemptedIds.push(claimed.operation.id);
    result.attempted++;
    const outcome = await executeOperation(workos, claimed.operation, claimed.leaseToken);
    if (outcome.kind === 'created') result.completed++;
    else if (outcome.kind === 'onboarding_retryable') result.retryable++;
    else if (outcome.kind === 'onboarding_reconciliation_required') result.manual++;
    else result.compensated++;
  }
  return result;
}
