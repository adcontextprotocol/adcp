import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { query, getPool } from '../db/client.js';
import { mergeUsers } from '../db/user-merge-db.js';
import { sendEmailLinkVerification } from '../notifications/email.js';
import { workos } from '../auth/workos-client.js';
import { CachedPostgresStore } from '../middleware/pg-rate-limit-store.js';

const logger = createLogger('account-linking');

const TOKEN_EXPIRY_HOURS = 24;

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

// Rate limiter for verification execution (strict — destructive action)
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
      const userId = req.user!.id;

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
        primary_email: req.user!.email,
        aliases: aliases.rows,
        pending: pending.rows,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list linked emails');
      return res.status(500).json({ error: 'Failed to list linked emails' });
    }
  });

  // POST /api/me/linked-emails — initiate email link verification
  router.post('/', requireAuth, sendVerificationLimiter, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
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
      if (normalizedEmail === req.user!.email.toLowerCase()) {
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
        primaryEmail: req.user!.email,
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
      logger.error({ error }, 'Failed to initiate email link');
      return res.status(500).json({ error: 'Failed to initiate email link' });
    }
  });

  // PUT /api/me/linked-emails/primary — swap a linked alias to be the primary email
  router.put('/primary', requireAuth, verifyExecuteLimiter, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { email } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const currentPrimary = req.user!.email.toLowerCase();

      if (normalizedEmail === currentPrimary) {
        return res.status(400).json({ error: 'This is already your primary email' });
      }

      const oldPrimary = req.user!.email;

      // DB-first, then WorkOS: if WorkOS fails we rollback cleanly.
      // If WorkOS succeeds but COMMIT fails (extremely rare), the user.updated
      // webhook will re-sync the email from WorkOS on the next event.
      let aliasEmail: string;
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock and verify the alias belongs to this user
        const alias = await client.query(
          `SELECT id, email FROM user_email_aliases
           WHERE workos_user_id = $1 AND LOWER(email) = $2 AND verified_at IS NOT NULL
           FOR UPDATE`,
          [userId, normalizedEmail]
        );

        if (alias.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Email is not linked to your account' });
        }

        aliasEmail = alias.rows[0].email;

        // Update users table with the new primary email
        await client.query(
          `UPDATE users SET email = $1, updated_at = NOW() WHERE workos_user_id = $2`,
          [aliasEmail, userId]
        );

        // Remove the new primary from aliases
        await client.query(
          `DELETE FROM user_email_aliases WHERE workos_user_id = $1 AND LOWER(email) = $2`,
          [userId, normalizedEmail]
        );

        // Add old primary as an alias
        await client.query(
          `INSERT INTO user_email_aliases (workos_user_id, email)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, oldPrimary]
        );

        // Update organization_memberships to reflect new email
        await client.query(
          `UPDATE organization_memberships SET email = $1, updated_at = NOW()
           WHERE workos_user_id = $2`,
          [aliasEmail, userId]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Update WorkOS (source of truth for auth) AFTER the transaction is
      // committed and the connection is released. This avoids holding a DB
      // connection idle while waiting on an external network call.
      // If WorkOS rejects the update the outer catch handles the error;
      // the DB change is already committed, and the user.updated webhook
      // will re-sync on the next WorkOS event if needed.
      await workos.userManagement.updateUser({ userId, email: aliasEmail });

      logger.info(
        { userId, oldPrimary, newPrimary: aliasEmail },
        'Primary email changed'
      );

      return res.json({ status: 'primary_updated', primary_email: aliasEmail });
    } catch (error: any) {
      // WorkOS may reject the email update (e.g. email already taken in WorkOS)
      if (error?.code === 'email_already_exists' || error?.status === 409) {
        return res.status(409).json({ error: 'This email is already associated with another account in our auth system' });
      }
      logger.error({ error }, 'Failed to set primary email');
      return res.status(500).json({ error: 'Failed to update primary email' });
    }
  });

  return router;
}

/**
 * Public verify endpoints — no auth required (opened from email inbox).
 * GET renders a confirmation page, POST executes the merge.
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
          `UPDATE email_link_tokens SET status = 'expired' WHERE id = $1`,
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
    } catch (error) {
      logger.error({ error }, 'Email link verification page failed');
      return renderVerifyPage(res, { success: false, message: 'Something went wrong. Please try again or contact support.' });
    }
  });

  // POST /verify-email-link — execute the merge (protected by FOR UPDATE lock)
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
        `SELECT id, primary_workos_user_id, target_email, target_workos_user_id, status, expires_at
         FROM email_link_tokens WHERE token = $1 FOR UPDATE`,
        [token]
      );

      const tokenRecord = tokenResult.rows[0];
      if (!tokenRecord) {
        await client.query('ROLLBACK');
        return renderVerifyPage(res, { success: false, message: 'This verification link is invalid.' });
      }

      if (tokenRecord.status !== 'pending' && tokenRecord.status !== 'processing') {
        await client.query('ROLLBACK');
        return renderVerifyPage(res, { success: false, message: 'This verification link has already been used.' });
      }

      if (new Date(tokenRecord.expires_at) < new Date()) {
        await client.query(
          `UPDATE email_link_tokens SET status = 'expired' WHERE id = $1`,
          [tokenRecord.id]
        );
        await client.query('COMMIT');
        return renderVerifyPage(res, { success: false, message: 'This verification link has expired. Please request a new one from your dashboard settings.' });
      }

      // Mark token as processing (prevents concurrent attempts, but allows retry on failure)
      await client.query(
        `UPDATE email_link_tokens SET status = 'processing' WHERE id = $1`,
        [tokenRecord.id]
      );

      await client.query('COMMIT');

      // Execute the merge outside the token lock (mergeUsers has its own transaction)
      let mergeSummary = null;

      try {
        if (tokenRecord.target_workos_user_id) {
          mergeSummary = await mergeUsers(
            tokenRecord.primary_workos_user_id,
            tokenRecord.target_workos_user_id,
            tokenRecord.primary_workos_user_id,
            workos
          );
        }

        // Record the email alias (use bare ON CONFLICT to handle both the
        // composite UNIQUE(workos_user_id, email) and the LOWER(email) index)
        await query(
          `INSERT INTO user_email_aliases (workos_user_id, email)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [tokenRecord.primary_workos_user_id, tokenRecord.target_email]
        );

        // Mark token as verified with merge summary
        await query(
          `UPDATE email_link_tokens SET status = 'verified', verified_at = NOW(), merge_summary = $2 WHERE id = $1`,
          [tokenRecord.id, mergeSummary ? JSON.stringify(mergeSummary) : null]
        );
      } catch (mergeError) {
        // Reset token to pending so the user can retry
        await query(
          `UPDATE email_link_tokens SET status = 'pending' WHERE id = $1`,
          [tokenRecord.id]
        ).catch((resetErr) => {
          logger.error({ error: resetErr, tokenId: tokenRecord.id }, 'Failed to reset token status after merge error — user cannot retry');
        });
        throw mergeError;
      }

      const totalMoved = mergeSummary
        ? mergeSummary.tables_merged.reduce((sum, t) => sum + t.rows_moved, 0)
        : 0;

      const message = mergeSummary
        ? `Your email <strong>${escapeHtml(tokenRecord.target_email)}</strong> has been linked to your account. ${totalMoved} records were consolidated from your previous account.`
        : `Your email <strong>${escapeHtml(tokenRecord.target_email)}</strong> has been linked to your account.`;

      logger.info(
        { primaryUserId: tokenRecord.primary_workos_user_id, targetEmail: tokenRecord.target_email, merged: !!mergeSummary },
        'Email link verification completed'
      );

      return renderVerifyPage(res, { success: true, message });
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ error, errorMessage: error?.message, errorCode: error?.code }, 'Email link verification failed');
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
        An existing account was found with this email. Confirming will merge that account into yours. This cannot be undone.
      </p>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Email Link - AgenticAdvertising.org</title>
  <link rel="icon" href="/addie-icon.svg" type="image/svg+xml">
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
  <link rel="icon" href="/addie-icon.svg" type="image/svg+xml">
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
