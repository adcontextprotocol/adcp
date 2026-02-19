/**
 * Shared encryption utilities for at-rest token protection.
 *
 * Uses AES-256-GCM with PBKDF2 key derivation.
 * The salt parameter provides context isolation (e.g., organization_id).
 */

import crypto from 'crypto';

const ENCRYPTION_SECRET = process.env.AGENT_TOKEN_ENCRYPTION_SECRET;
if (!ENCRYPTION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('AGENT_TOKEN_ENCRYPTION_SECRET must be set in production');
}
const effectiveSecret = ENCRYPTION_SECRET || 'dev-secret-change-in-production';

export function deriveKey(salt: string): Buffer {
  return crypto.pbkdf2Sync(effectiveSecret, salt, 100000, 32, 'sha256');
}

export function encrypt(value: string, salt: string): { encrypted: string; iv: string } {
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();
  encrypted += ':' + authTag.toString('base64');

  return {
    encrypted,
    iv: iv.toString('base64'),
  };
}

export function decrypt(encrypted: string, iv: string, salt: string): string {
  const key = deriveKey(salt);
  const ivBuffer = Buffer.from(iv, 'base64');

  const [encryptedData, authTagBase64] = encrypted.split(':');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
