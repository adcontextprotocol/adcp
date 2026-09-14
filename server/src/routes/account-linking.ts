import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { requireAuth, type ValidatedApiKey } from '../middleware/auth.js';
import { query, getPool } from '../db/client.js';
import { sendEmailLinkVerification } from '../notifications/email.js';
import { CachedPostgresStore } from '../middleware/pg-rate-limit-store.js';
import { EmailMutationError, getEmailMutationStatus, setPrimaryEmail } from '../services/email-mutation.js';

const logger = createLogger('account-linking');

const TOKEN_EXPIRY_HOURS = 24;

async function sendEmailMutationFailure(res: Response, userId: string, error: unknown): Promise<Response> {
  try {
    const status = await getEmailMutationStatus(userId);
    if (status.reconciliation_required) return res.status(503).json(status);
    if ((error as { code?: unknown } | null)?.code === '55P03') {
      return res.status(409).json({
        error: 'credential_busy', retryable: true,
        message: 'An email change is already in progress. Please retry.',
      });
    }
  } catch { /* Status is unknown; do not invent a durable operation. */ }
  return res.status(503).json({
    error: 'Failed to update email', status_unknown: true,
    message: 'We could not confirm the email change. Reload to check its status or contact support before trying again.',
  });
}

// Rate limiter for sending verification emails (per authenticated user)
const sendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('link-email-send:'),
  keyGenerator: (req) => req.user?.id || req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
});

// Rate limiter for verification page views (generous — just prevents abuse)
const verifyViewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('verify-email-view:'),
  keyGenerator: (req) => req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
});

// Rate limiter for verification and email mutation execution
const verifyExecuteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('verify-email-exec:'),
  keyGenerator: (req) => req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
});

/**
 * User-facing routes for linking email addresses.
 * Mounted at /api/me/linked-emails
 */
export function createAccountLinkingRouter(): Router {
  const router = Router();

  // GET /api/me/linked-emails — list linked emails and pending tokens
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authWorkosUserId ?? req.user!.id;

      const mutationStatus = await getEmailMutationStatus(userId);
      const credential = await query('SELECT email FROM users WHERE workos_user_id = $1', [userId]);
      const aliases = await query(
        `SELECT id, email, verified_at, created_at
         FROM user_email_aliases
         WHERE workos_user_id = $1
         ORDER BY created_at`,
        [userId]
      );

      const pending = await query(
        `SELECT id, target_email, created_at, expires_at
         FROM email_link_tokens
         WHERE primary_workos_user_id = $1 AND status = 'pending' AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [userId]
      );

      return res.json({
        credential_id: userId,
        primary_email: credential.rows[0]?.email,
        ...mutationStatus,
        aliases: aliases.rows,
        pending: pending.rows,
      });
    } catch {
      logger.error('Failed to list linked emails');
      return res.status(500).json({ error: 'Failed to list linked emails' });
    }
  });

  // POST /api/me/linked-emails — initiate email link verification
  router.post('/', requireAuth, sendVerificationLimiter, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authWorkosUserId ?? req.user!.id;
      const mutationStatus = await getEmailMutationStatus(userId);
      if (mutationStatus.reconciliation_required) return res.status(409).json(mutationStatus);
      const { email } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      if (normalizedEmail.length > 255) {
        return res.status(400).json({ error: 'Email address is too long' });
      }

      // Basic email validation
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      // Can't link your own email
      const credential = await query('SELECT email FROM users WHERE workos_user_id = $1', [userId]);
      if (normalizedEmail === credential.rows[0]?.email.toLowerCase()) {
        return res.status(400).json({ error: 'This is already your primary email' });
      }

      // Check if already linked
      const existingAlias = await query(
        `SELECT 1 FROM user_email_aliases WHERE workos_user_id = $1 AND LOWER(email) = $2`,
        [userId, normalizedEmail]
      );
      if (existingAlias.rows.length > 0) {
        return res.status(409).json({ error: 'This email is already linked to your account' });
      }

      // Cap total pending tokens per user
      const pendingCount = await query(
        `SELECT COUNT(*) as count FROM email_link_tokens
         WHERE primary_workos_user_id = $1 AND status IN ('pending', 'processing') AND expires_at > NOW()`,
        [userId]
      );
      if (parseInt(pendingCount.rows[0].count, 10) >= 5) {
        return res.status(429).json({ error: 'Too many pending verifications. Please complete or wait for existing ones to expire.' });
      }

      // Check for pending verification for this specific email
      const existingPending = await query(
        `SELECT 1 FROM email_link_tokens
         WHERE primary_workos_user_id = $1 AND LOWER(target_email) = $2
         AND status IN ('pending', 'processing') AND expires_at > NOW()`,
        [userId, normalizedEmail]
      );
      if (existingPending.rows.length > 0) {
        return res.status(409).json({ error: 'A verification is already pending for this email. Check your inbox.' });
      }

      // Check if another user already claimed this email as an alias
      const claimedByOther = await query(
        `SELECT 1 FROM user_email_aliases WHERE LOWER(email) = $1 AND workos_user_id != $2`,
        [normalizedEmail, userId]
      );
      if (claimedByOther.rows.length > 0) {
        return res.status(409).json({ error: 'This email is already linked to another account' });
      }

      // Look up whether this email has an existing WorkOS user in our DB
      const targetUser = await query(
        `SELECT workos_user_id, email, first_name, last_name
         FROM users WHERE LOWER(email) = $1 AND workos_user_id != $2`,
        [normalizedEmail, userId]
      );
      const targetWorkosUserId = targetUser.rows[0]?.workos_user_id || null;

      // Block the self-service "merge two existing accounts" path. Without
      // the old delete-the-secondary side effect, the existing confused-
      // deputy attack (attacker requests a link to victim's email; victim
      // confirms; attacker becomes primary, victim is rebound non-primary
      // and silently routes into the attacker's workspace) would be silent
      // and persistent. Consolidating two real accounts is now admin-only —
      // see /admin/people for the bind tool. Bare alias adds (where the
      // target email has no existing WorkOS user) are unaffected.
      if (targetWorkosUserId) {
        logger.info(
          { userId, targetEmail: normalizedEmail, targetWorkosUserId },
          'Refused self-service merge of two existing accounts; admin tool required'
        );
        return res.status(409).json({
          error: 'This email already has an AAO account',
          message: 'Combining two existing accounts requires admin assistance — please contact support.',
        });
      }

      // Generate verification token
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

      await query(
        `INSERT INTO email_link_tokens (
          token, primary_workos_user_id, target_email, target_workos_user_id, expires_at
        ) VALUES ($1, $2, $3, $4, $5)`,
        [token, userId, normalizedEmail, targetWorkosUserId, expiresAt]
      );

      // Send verification email
      const primaryName = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(' ') || req.user!.email;
      await sendEmailLinkVerification({
        to: normalizedEmail,
        token,
        primaryUserName: primaryName,
        primaryEmail: credential.rows[0]?.email ?? req.user!.email,
      });

      logger.info(
        { userId, targetEmail: normalizedEmail, hasExistingAccount: !!targetWorkosUserId },
        'Email link verification sent'
      );

      // Don't reveal whether target email has an existing account
      // (prevents account enumeration). The verification email explains what will happen.
      return res.json({
        status: 'verification_sent',
      });
    } catch (error) {
      logger.error('Failed to initiate email link');
      return sendEmailMutationFailure(res, req.user!.authWorkosUserId ?? req.user!.id, error);
    }
  });

  // Email ownership and the provider mutation are scoped to the credential
  // that authenticated, even when the session also carries a canonical person.
  router.put('/primary', requireAuth, verifyExecuteLimiter, async (req: Request, res: Response) => {
    // Only a real member credential hydrated from the primary database can
    // change email. Synthetic/API-key principals are not email credentials.
    const snapshot = req.user?.authorizationSnapshot;
    if ((req as Request & { apiKey?: ValidatedApiKey }).apiKey || !snapshot
        || snapshot.authenticatedUserId !== (req.user!.authWorkosUserId ?? req.user!.id)) {
      return res.status(403).json({ error: 'A member login is required to change primary email' });
    }
    const userId = snapshot.authenticatedUserId;
    try {
      const result = await setPrimaryEmail({
        userId, email: req.body?.email, actorUserId: userId, operationId: req.body?.operation_id,
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof EmailMutationError) return res.status(error.status).json(error.body);
      // Provider exceptions may contain request headers, tokens, or bodies.
      logger.error('Failed to set primary email');
      return sendEmailMutationFailure(res, userId, error);
    }
  });

  return router;
}

/**
 * Public verify endpoints — no auth required (opened from email inbox).
 * GET renders a confirmation page, POST records a verified email alias.
 */
export function handleEmailLinkVerification(app: {
  get: (path: string, ...handlers: any[]) => void;
  post: (path: string, ...handlers: any[]) => void;
}): void {

  // GET /verify-email-link — show confirmation page
  app.get('/verify-email-link', verifyViewLimiter, async (req: Request, res: Response) => {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return renderVerifyPage(res, { success: false, message: 'Missing verification token.' });
    }

    try {
      const tokenResult = await query(
        `SELECT id, primary_workos_user_id, target_email, target_workos_user_id, status, expires_at
         FROM email_link_tokens WHERE token = $1`,
        [token]
      );

      const tokenRecord = tokenResult.rows[0];
      if (!tokenRecord) {
        return renderVerifyPage(res, { success: false, message: 'This verification link is invalid.' });
      }

      if (tokenRecord.status !== 'pending') {
        return renderVerifyPage(res, { success: false, message: 'This verification link has already been used.' });
      }

      if (new Date(tokenRecord.expires_at) < new Date()) {
        await query(
          `UPDATE email_link_tokens SET status = 'expired'
           WHERE id = $1 AND status = 'pending' AND expires_at < NOW()`,
          [tokenRecord.id]
        );
        return renderVerifyPage(res, { success: false, message: 'This verification link has expired. Please request a new one from your dashboard settings.' });
      }

      // Render confirmation page with a form that POSTs
      return renderConfirmPage(res, {
        targetEmail: tokenRecord.target_email,
        hasMerge: !!tokenRecord.target_workos_user_id,
        token: token as string,
      });
    } catch {
      logger.error('Email link verification page failed');
      return renderVerifyPage(res, { success: false, message: 'Something went wrong. Please try again or contact support.' });
    }
  });

  // POST /verify-email-link — verify the alias (protected by FOR UPDATE lock)
  app.post('/verify-email-link', express.urlencoded({ extended: false }), verifyExecuteLimiter, async (req: Request, res: Response) => {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return renderVerifyPage(res, { success: false, message: 'Missing verification token.' });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock the token row to prevent concurrent verification
      const tokenResult = await client.query(
        `SELECT *, expires_at::text AS expires_at_exact
         FROM email_link_tokens WHERE token = $1 FOR UPDATE`,
        [token]
      );

      const tokenRecord = tokenResult.rows[0];
      if (!tokenRecord) {
        await client.query('ROLLBACK');
        return renderVerifyPage(res, { success: false, message: 'This verification link is invalid.' });
      }

      if (tokenResult.rowCount !== 1 || tokenResult.rows.length !== 1) {
        throw new Error('Unexpected verification token cardinality');
      }

      const replay = tokenRecord.status === 'verified';
      if (!replay && tokenRecord.status !== 'pending' && tokenRecord.status !== 'processing') {
        await client.query('ROLLBACK');
        return renderVerifyPage(res, { success: false, message: 'This verification link has already been used.' });
      }

      // Legacy processing is retryable only with no terminal evidence. Never
      // reset a token after failure: rollback restores its locked entry state.
      if ((!replay && tokenRecord.verified_at !== null) || tokenRecord.merge_summary !== null) {
        throw new Error('Unexpected verification token evidence');
      }

      const finishToken = async (status: 'verified' | 'expired' | 'revoked') => {
        const updated = await client.query(
          `UPDATE email_link_tokens SET status = $7::varchar,
             verified_at = CASE WHEN $7 = 'verified' THEN NOW() ELSE verified_at END
           WHERE id = $1 AND token = $2 AND primary_workos_user_id = $3
             AND target_email = $4 AND target_workos_user_id IS NOT DISTINCT FROM $5
             AND status = $6 AND verified_at IS NULL AND merge_summary IS NULL
             AND expires_at = $8
           RETURNING *`,
          [tokenRecord.id, token, tokenRecord.primary_workos_user_id, tokenRecord.target_email,
            tokenRecord.target_workos_user_id, tokenRecord.status, status, tokenRecord.expires_at_exact]
        );
        const assertTerminal = (result: typeof updated) => {
          const row = result.rows[0];
          if (result.rowCount !== 1 || result.rows.length !== 1 || row.id !== tokenRecord.id
              || row.token !== token || row.primary_workos_user_id !== tokenRecord.primary_workos_user_id
              || row.target_email !== tokenRecord.target_email
              || row.target_workos_user_id !== tokenRecord.target_workos_user_id
              || row.status !== status || row.merge_summary !== null
              || (status === 'verified' ? !row.verified_at : row.verified_at !== null)
              || new Date(row.expires_at).getTime() !== new Date(tokenRecord.expires_at).getTime()) {
            throw new Error('Verification token transition failed');
          }
        };
        assertTerminal(updated);
        // RETURNING precedes AFTER triggers; check the persisted state too.
        assertTerminal(await client.query('SELECT * FROM email_link_tokens WHERE id = $1', [tokenRecord.id]));
      };

      if (!replay && new Date(tokenRecord.expires_at) < new Date()) {
        await finishToken('expired');
        await client.query('COMMIT');
        return renderVerifyPage(res, { success: false, message: 'This verification link has expired. Please request a new one from your dashboard settings.' });
      }

      // Use migration 592's existing nonblocking credential fence throughout
      // the rechecks, including replay. No new cross-email writer protocol.
      await client.query('SELECT lock_email_writer($1)', [tokenRecord.primary_workos_user_id]);
      const mutationStatus = await getEmailMutationStatus(tokenRecord.primary_workos_user_id, client);
      if (mutationStatus.reconciliation_required) {
        await client.query('ROLLBACK');
        return renderVerifyPage(res, { success: false, message: mutationStatus.message! });
      }

      if (tokenRecord.target_workos_user_id !== null) {
        // Defense in depth: initiation now refuses tokens with a target
        // WorkOS user (see POST /api/me/linked-emails), but in-flight
        // tokens issued before that block landed must also be refused
        // here. The merge-existing-accounts path is admin-only.
        if (replay) throw new Error('Conflicting verification replay');
        await finishToken('revoked');
        await client.query('COMMIT');
        logger.info(
          {
            tokenId: tokenRecord.id,
            primaryUserId: tokenRecord.primary_workos_user_id,
            targetWorkosUserId: tokenRecord.target_workos_user_id,
          },
          'Refused self-service merge at verify time; admin tool required'
        );
        return renderVerifyPage(res, {
          success: false,
          message: 'This email already has an AAO account. Combining accounts requires admin assistance — please contact support.',
        });
      }

      const principal = await client.query(
        'SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR KEY SHARE',
        [tokenRecord.primary_workos_user_id]
      );
      if (principal.rowCount !== 1 || principal.rows.length !== 1
          || principal.rows[0].workos_user_id !== tokenRecord.primary_workos_user_id) {
        throw new Error('Verification principal is unavailable');
      }
      // This sees credentials created since issuance. A different credential
      // inserted AFTER this check is a residual cross-table writer race.
      const credentials = await client.query(
        'SELECT workos_user_id FROM users WHERE LOWER(email) = LOWER($1)', [tokenRecord.target_email]
      );
      if (credentials.rowCount !== 0 || credentials.rows.length !== 0) {
        throw new Error('Verification email already has a credential');
      }

      if (!replay) {
        const inserted = await client.query(
          `INSERT INTO user_email_aliases (workos_user_id, email)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING workos_user_id, email, verified_at`,
          [tokenRecord.primary_workos_user_id, tokenRecord.target_email]
        );
        if (inserted.rowCount !== inserted.rows.length || ![0, 1].includes(inserted.rows.length)
            || (inserted.rows.length === 1 && (inserted.rows[0].workos_user_id !== tokenRecord.primary_workos_user_id
              || inserted.rows[0].email !== tokenRecord.target_email || !inserted.rows[0].verified_at))) {
          throw new Error('Verification alias insert failed');
        }
      }

      // Check ownership even after INSERT, and lock existing aliases through
      // commit. Zero rows (including a suppressed INSERT) is never success.
      const checkOwner = async () => {
        const owner = await client.query(
          `SELECT workos_user_id, email, verified_at FROM user_email_aliases
           WHERE LOWER(email) = LOWER($1) FOR UPDATE`, [tokenRecord.target_email]
        );
        if (owner.rowCount !== 1 || owner.rows.length !== 1
            || owner.rows[0].workos_user_id !== tokenRecord.primary_workos_user_id
            || !owner.rows[0].verified_at || (replay && !tokenRecord.verified_at)) {
          throw new Error('Verification alias ownership conflict');
        }
      };
      await checkOwner();
      if (!replay) {
        await finishToken('verified');
        await checkOwner();
      }
      await client.query('COMMIT');

      const message = `Your email <strong>${escapeHtml(tokenRecord.target_email)}</strong> is now linked to your account.`;

      if (!replay) logger.info(
        { primaryUserId: tokenRecord.primary_workos_user_id, targetEmail: tokenRecord.target_email },
        'Email link verification completed'
      );

      return renderVerifyPage(res, { success: true, message });
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Email link verification failed');
      return renderVerifyPage(res, { success: false, message: 'Something went wrong during verification. Please try again or contact support.' });
    } finally {
      client.release();
    }
  });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderConfirmPage(res: Response, opts: { targetEmail: string; hasMerge: boolean; token: string }): void {
  const mergeWarning = opts.hasMerge
    ? `<p style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 12px; font-size: 13px; margin-top: 16px;">
        An existing account was found with this email. These accounts remain separate. Please contact support for assistance.
      </p>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Email Link - AgenticAdvertising.org</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f8fafc;
      color: #334155;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 48px;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h1 { font-size: 24px; margin: 0 0 16px; color: #1a1a1a; }
    p { font-size: 15px; line-height: 1.6; margin: 0; }
    .actions { margin-top: 24px; display: flex; gap: 8px; justify-content: center; }
    .btn {
      padding: 10px 20px;
      border-radius: 6px;
      border: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
    }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #f1f5f9; color: #334155; }
    .btn-secondary:hover { background: #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Confirm Email Link</h1>
    <p>Link <strong>${escapeHtml(opts.targetEmail)}</strong> to your account?</p>
    ${mergeWarning}
    <form method="POST" action="/verify-email-link" class="actions">
      <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
      <a href="/account" class="btn btn-secondary">Cancel</a>
      <button type="submit" class="btn btn-primary">Confirm</button>
    </form>
  </div>
</body>
</html>`);
}

function renderVerifyPage(res: Response, opts: { success: boolean; message: string }): void {
  const icon = opts.success ? '&#10003;' : '&#10007;';
  const iconColor = opts.success ? '#16a34a' : '#dc2626';
  const title = opts.success ? 'Email Linked' : 'Verification Failed';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - AgenticAdvertising.org</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f8fafc;
      color: #334155;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 48px;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .icon {
      font-size: 48px;
      color: ${iconColor};
      margin-bottom: 16px;
    }
    h1 { font-size: 24px; margin: 0 0 16px; color: #1a1a1a; }
    p { font-size: 15px; line-height: 1.6; margin: 0; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .actions { margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${opts.message}</p>
    <div class="actions">
      <a href="/account">Go to Account</a>
    </div>
  </div>
</body>
</html>`);
}
