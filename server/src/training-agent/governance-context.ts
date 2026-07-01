/**
 * Compact-JWS issuance for `governance_context` tokens.
 *
 * Spec: docs/building/by-layer/L1/security.mdx §"AdCP JWS profile".
 *
 * Header:
 *   - alg: EdDSA (Ed25519)
 *   - typ: adcp-gov+jws  (byte-for-byte — no normalization, no structured-suffix stripping)
 *   - kid: from the governance-signing JWK
 *
 * Claims (per the 13-row claim table plus the audit-layer `plan_hash`):
 *   - iss, sub, aud, iat, exp, jti, phase, caller, check_id
 *   - media_buy_id  — conditional: present on purchase/modification/delivery; absent on intent
 *   - policy_decisions  — emitted when the GA evaluated specific policy IDs
 *   - plan_hash  — required audit-layer claim; never listed in `crit`
 *
 * No `crit` is emitted by default. The training agent does not introduce
 * profile extensions, so the `crit` array would be empty and is omitted.
 */

import { SignJWT, type JWTPayload } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { getGovernanceSigningKey } from './governance-signing.js';
import { computePlanHash } from './plan-hash.js';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-governance-context');

export const GOVERNANCE_JWS_TYP = 'adcp-gov+jws';

const INTENT_TTL_SECONDS = 15 * 60;
const EXECUTION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type GovernancePhase = 'intent' | 'purchase' | 'modification' | 'delivery';

export interface PolicyDecision {
  policy_id: string;
  outcome: string;
  confidence?: number;
}

export interface SignGovernanceContextInput {
  /** Governance agent identifier — HTTPS URL matching the brand.json entry. */
  issuer: string;
  /** Target seller — exact URL from `adagents.json`. */
  audience: string;
  /** Plan identifier the token authorizes. */
  planId: string;
  /** Lifecycle phase this token covers. */
  phase: GovernancePhase;
  /** Caller URL — orchestrator on intent, seller on execution phases. */
  caller: string;
  /** Check identifier — correlates to report_plan_outcome / audit logs. */
  checkId: string;
  /** Required on purchase/modification/delivery; MUST be absent on intent. */
  mediaBuyId?: string;
  /** Plan revision being attested to. Used to compute the `plan_hash` claim. */
  plan: Record<string, unknown>;
  /** Optional policy decision detail. Omit when sensitive — auditors fetch via audit_log_pointer. */
  policyDecisions?: PolicyDecision[];
  /** Optional pointer to full audit-log evidence. */
  auditLogPointer?: string;
}

export interface GovernanceContextClaims extends JWTPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  phase: GovernancePhase;
  caller: string;
  check_id: string;
  plan_hash: string;
  media_buy_id?: string;
  policy_decisions?: PolicyDecision[];
  audit_log_pointer?: string;
}

function ttlForPhase(phase: GovernancePhase): number {
  return phase === 'intent' ? INTENT_TTL_SECONDS : EXECUTION_TTL_SECONDS;
}

/**
 * Sign a compact-JWS `governance_context` token. The returned string is the
 * value callers persist and forward on subsequent governance calls.
 */
export async function signGovernanceContext(input: SignGovernanceContextInput): Promise<string> {
  if (input.phase === 'intent' && input.mediaBuyId !== undefined) {
    throw new Error('media_buy_id MUST be absent on intent-phase tokens');
  }
  if (input.phase !== 'intent' && !input.mediaBuyId) {
    // Spec requires media_buy_id on non-intent tokens. The training sandbox
    // emits a structurally-valid JWS without it so existing storyboards that
    // omit the field continue to round-trip; a seller running the full
    // 15-step verification would reject (step 12). Cert content surfaces
    // this gap rather than silently fabricating an id the seller will never
    // recognize.
    logger.warn(
      { phase: input.phase, planId: input.planId },
      'Emitting non-intent governance_context without media_buy_id — spec requires this field. Caller MUST supply target_seller and media_buy_id for production conformance.',
    );
  }

  const { kid, privateKey } = getGovernanceSigningKey();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlForPhase(input.phase);
  const planHash = computePlanHash(input.plan);

  const claims: GovernanceContextClaims = {
    iss: input.issuer,
    sub: input.planId,
    aud: input.audience,
    iat,
    exp,
    jti: uuidv7(),
    phase: input.phase,
    caller: input.caller,
    check_id: input.checkId,
    plan_hash: planHash,
    ...(input.mediaBuyId !== undefined ? { media_buy_id: input.mediaBuyId } : {}),
    ...(input.policyDecisions !== undefined ? { policy_decisions: input.policyDecisions } : {}),
    ...(input.auditLogPointer !== undefined ? { audit_log_pointer: input.auditLogPointer } : {}),
  };

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', typ: GOVERNANCE_JWS_TYP, kid })
    .sign(privateKey);
}
