import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('referral-codes-db');

export type ReferralCodeStatus = 'active' | 'revoked' | 'expired';
export type ReferralStatus = 'pending' | 'accepted' | 'converted' | 'expired';

export interface ReferralCode {
  id: number;
  code: string;
  referrer_org_id: string;
  referrer_user_id: string;
  referrer_user_name: string;
  referrer_user_email: string | null;
  target_company_name: string | null;
  discount_percent: number | null;
  max_uses: number | null;
  used_count: number;
  status: ReferralCodeStatus;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Referral {
  id: number;
  referral_code_id: number;
  referral_code: string;
  referrer_org_id: string;
  referrer_user_id: string;
  target_company_name: string | null;
  referred_org_id: string | null;
  referred_user_id: string | null;
  referred_company_name: string | null;
  referred_contact_email: string | null;
  status: ReferralStatus;
  accepted_at: Date | null;
  expires_at: Date | null;
  converted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AcceptedReferral extends Referral {
  discount_percent: number | null;
  days_remaining: number;
}

export interface ReferralDashboardRow {
  code_id: number;
  code: string;
  referrer_org_id: string;
  referrer_user_id: string;
  referrer_org_name: string | null;
  target_company_name: string | null;
  discount_percent: number | null;
  max_uses: number | null;
  used_count: number;
  code_status: ReferralCodeStatus;
  expires_at: Date | null;
  code_created_at: Date;
  referral_id: number | null;
  referred_org_id: string | null;
  referred_user_id: string | null;
  referred_company_name: string | null;
  referred_contact_email: string | null;
  referral_status: ReferralStatus | null;
  converted_at: Date | null;
  referred_at: Date | null;
  referred_org_name: string | null;
  referred_org_membership_tier: string | null;
}

export interface CreateReferralCodeInput {
  referrer_org_id: string;
  referrer_user_id: string;
  referrer_user_name: string;
  referrer_user_email?: string;
  target_company_name?: string;
  discount_percent?: number;
  max_uses?: number;
  expires_at?: Date;
  custom_code?: string;
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createReferralCode(input: CreateReferralCodeInput): Promise<ReferralCode> {
  const code = input.custom_code?.toUpperCase() || generateCode();

  const result = await query<ReferralCode>(
    `INSERT INTO referral_codes
       (code, referrer_org_id, referrer_user_id, referrer_user_name, referrer_user_email,
        target_company_name, discount_percent, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      code,
      input.referrer_org_id,
      input.referrer_user_id,
      input.referrer_user_name,
      input.referrer_user_email || null,
      input.target_company_name || null,
      input.discount_percent || null,
      input.max_uses || null,
      input.expires_at || null,
    ]
  );

  const created = result.rows[0];
  logger.info(
    { codeId: created.id, code: created.code, referrerOrg: input.referrer_org_id, targetCompany: input.target_company_name },
    'Referral code created'
  );

  return created;
}

export async function getReferralCode(code: string): Promise<ReferralCode | null> {
  const result = await query<ReferralCode>(
    'SELECT * FROM referral_codes WHERE code = $1',
    [code.toUpperCase()]
  );
  return result.rows[0] || null;
}

export async function listReferralCodes(referrerOrgId: string): Promise<ReferralDashboardRow[]> {
  const result = await query<ReferralDashboardRow>(
    `SELECT * FROM referral_dashboard
     WHERE referrer_org_id = $1
     ORDER BY code_created_at DESC`,
    [referrerOrgId]
  );
  return result.rows;
}

export async function listAllReferralCodes(): Promise<ReferralDashboardRow[]> {
  const result = await query<ReferralDashboardRow>(
    `SELECT * FROM referral_dashboard ORDER BY code_created_at DESC, referral_id DESC`
  );
  return result.rows;
}

export async function revokeReferralCode(id: number, referrerOrgId: string): Promise<ReferralCode | null> {
  const result = await query<ReferralCode>(
    `UPDATE referral_codes
     SET status = 'revoked', updated_at = NOW()
     WHERE id = $1 AND referrer_org_id = $2 AND status = 'active'
     RETURNING *`,
    [id, referrerOrgId]
  );

  if (result.rows[0]) {
    logger.info({ codeId: id, referrerOrg: referrerOrgId }, 'Referral code revoked');
  }

  return result.rows[0] || null;
}

/**
 * Accept a referral code on behalf of an org that just signed up.
 * Creates the referral record in 'accepted' state and starts the 30-day countdown.
 * Atomically increments used_count to prevent over-use.
 */
export async function acceptReferralCode(
  code: string,
  referredOrgId: string,
  referredUserId: string
): Promise<Referral | null> {
  const referralCode = await getReferralCode(code);

  if (!referralCode) {
    logger.warn({ code }, 'Referral code not found');
    return null;
  }

  if (referralCode.status !== 'active') {
    logger.warn({ code, status: referralCode.status }, 'Referral code is not active');
    return null;
  }

  if (referralCode.expires_at && referralCode.expires_at < new Date()) {
    await query(
      `UPDATE referral_codes SET status = 'expired', updated_at = NOW() WHERE id = $1`,
      [referralCode.id]
    );
    logger.warn({ code }, 'Referral code expired');
    return null;
  }

  if (referralCode.max_uses !== null && referralCode.used_count >= referralCode.max_uses) {
    logger.warn({ code }, 'Referral code has reached max uses');
    return null;
  }

  // Atomically increment used_count and create the referral in 'accepted' state
  const referralResult = await query<Referral>(
    `WITH updated_code AS (
       UPDATE referral_codes
       SET used_count = used_count + 1, updated_at = NOW()
       WHERE id = $1
         AND status = 'active'
         AND (max_uses IS NULL OR used_count < max_uses)
       RETURNING id, referrer_org_id, referrer_user_id, target_company_name
     )
     INSERT INTO referrals
       (referral_code_id, referral_code, referrer_org_id, referrer_user_id,
        target_company_name, referred_org_id, referred_user_id,
        status, accepted_at, expires_at)
     SELECT
       uc.id, $2, uc.referrer_org_id, uc.referrer_user_id,
       uc.target_company_name, $3, $4,
       'accepted', NOW(), NOW() + INTERVAL '30 days'
     FROM updated_code uc
     RETURNING *`,
    [referralCode.id, code.toUpperCase(), referredOrgId, referredUserId]
  );

  if (referralResult.rows.length === 0) {
    logger.warn({ code }, 'Referral code could not be accepted (race condition or already maxed)');
    return null;
  }

  const referral = referralResult.rows[0];
  const notes = referralCode.target_company_name
    ? `Referred via code ${code} (targeted for ${referralCode.target_company_name})`
    : `Referred via code ${code}`;

  // Create stakeholder relationship: referrer becomes owner of the referred org.
  // This runs outside the CTE transaction intentionally — stakeholder assignment
  // is best-effort. A failure here does not roll back the referral acceptance.
  try {
    await query(
      `INSERT INTO org_stakeholders (organization_id, user_id, user_name, user_email, role, notes)
       VALUES ($1, $2, $3, $4, 'owner', $5)
       ON CONFLICT (organization_id, user_id) DO UPDATE
         SET role = 'owner', notes = $5, updated_at = NOW()`,
      [
        referredOrgId,
        referralCode.referrer_user_id,
        referralCode.referrer_user_name,
        referralCode.referrer_user_email,
        notes,
      ]
    );
  } catch (err) {
    logger.warn({ err, code, referredOrgId }, 'Could not assign stakeholder after referral acceptance');
  }

  logger.info(
    { referralId: referral.id, code, referredOrg: referredOrgId, referrerOrg: referralCode.referrer_org_id },
    'Referral code accepted'
  );

  return referral;
}

/**
 * Get the active accepted referral for an org, including the discount percent from the source code.
 * Lazily marks the referral as expired if the 30-day window has passed.
 * Returns null if no active referral exists.
 */
export async function getAcceptedReferralForOrg(orgId: string): Promise<AcceptedReferral | null> {
  const result = await query<AcceptedReferral & { raw_expires_at: Date }>(
    `SELECT r.*, rc.discount_percent,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (r.expires_at - NOW())) / 86400.0)::int) AS days_remaining
     FROM referrals r
     JOIN referral_codes rc ON rc.id = r.referral_code_id
     WHERE r.referred_org_id = $1
       AND r.status = 'accepted'
     LIMIT 1`,
    [orgId]
  );

  const referral = result.rows[0];
  if (!referral) return null;

  // Lazily expire if the window has passed
  if (referral.expires_at && referral.expires_at < new Date()) {
    await query(
      `UPDATE referrals SET status = 'expired', updated_at = NOW() WHERE id = $1`,
      [referral.id]
    );
    logger.info({ referralId: referral.id, orgId }, 'Accepted referral expired (30-day window passed)');
    return null;
  }

  return referral;
}

/**
 * Record a referral from an invoice request, where no org exists yet.
 * Tracks company name and contact email for later reconciliation.
 */
export async function redeemReferralCodeForInvoice(
  code: string,
  companyName: string,
  contactEmail: string
): Promise<Referral | null> {
  const referralCode = await getReferralCode(code);

  if (!referralCode || referralCode.status !== 'active') return null;
  if (referralCode.expires_at && referralCode.expires_at < new Date()) return null;
  if (referralCode.max_uses !== null && referralCode.used_count >= referralCode.max_uses) return null;

  const result = await query<Referral>(
    `WITH updated_code AS (
       UPDATE referral_codes
       SET used_count = used_count + 1, updated_at = NOW()
       WHERE id = $1
         AND status = 'active'
         AND (max_uses IS NULL OR used_count < max_uses)
       RETURNING id, referrer_org_id, referrer_user_id, target_company_name
     )
     INSERT INTO referrals
       (referral_code_id, referral_code, referrer_org_id, referrer_user_id,
        target_company_name, referred_company_name, referred_contact_email, status)
     SELECT
       uc.id, $2, uc.referrer_org_id, uc.referrer_user_id,
       uc.target_company_name, $3, $4, 'pending'
     FROM updated_code uc
     RETURNING *`,
    [referralCode.id, code.toUpperCase(), companyName, contactEmail]
  );

  const referral = result.rows[0] || null;
  if (referral) {
    logger.info(
      { referralId: referral.id, code, company: companyName },
      'Referral code redeemed for invoice'
    );
  }
  return referral;
}

/**
 * Mark an accepted referral as converted after successful payment.
 * Called from the Stripe checkout.session.completed webhook.
 */
export async function convertReferral(referredOrgId: string): Promise<Referral | null> {
  // Both 'pending' (invoice path) and 'accepted' (online path) referrals are
  // converted on payment. The unique partial index prevents two 'accepted' rows
  // for the same org; the invoice and online paths are mutually exclusive in
  // normal usage, so this UPDATE affects at most one row.
  const result = await query<Referral>(
    `UPDATE referrals
     SET status = 'converted', converted_at = NOW(), updated_at = NOW()
     WHERE referred_org_id = $1 AND status IN ('pending', 'accepted')
     RETURNING *`,
    [referredOrgId]
  );

  if (result.rows[0]) {
    logger.info({ referralId: result.rows[0].id, referredOrg: referredOrgId }, 'Referral converted');
  }

  return result.rows[0] || null;
}
