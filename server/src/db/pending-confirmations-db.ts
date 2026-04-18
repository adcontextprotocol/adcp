import { query } from './client.js';

export interface PendingConfirmation {
  email: string;
  token: string;
  source: string;
  created_at: Date;
  expires_at: Date;
}

export class PendingConfirmationsDatabase {
  async upsert(data: {
    email: string;
    token: string;
    source: string;
    expiresAt: Date;
  }): Promise<void> {
    await query(
      `INSERT INTO pending_newsletter_confirmations (email, token, source, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         token = EXCLUDED.token,
         source = EXCLUDED.source,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()`,
      [data.email, data.token, data.source, data.expiresAt]
    );
  }

  async getByEmail(email: string): Promise<PendingConfirmation | null> {
    const result = await query<PendingConfirmation>(
      `SELECT * FROM pending_newsletter_confirmations WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  }

  async getByToken(token: string): Promise<PendingConfirmation | null> {
    const result = await query<PendingConfirmation>(
      `SELECT * FROM pending_newsletter_confirmations
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    return result.rows[0] || null;
  }

  async deleteByEmail(email: string): Promise<void> {
    await query(
      `DELETE FROM pending_newsletter_confirmations WHERE email = $1`,
      [email]
    );
  }

  async deleteExpired(): Promise<number> {
    const result = await query(
      `DELETE FROM pending_newsletter_confirmations WHERE expires_at <= NOW()`
    );
    return result.rowCount ?? 0;
  }
}

export const pendingConfirmationsDb = new PendingConfirmationsDatabase();
