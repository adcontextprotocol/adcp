/**
 * Avatar upload and serving routes.
 *
 * POST /api/me/avatar — upload a profile photo (JPEG/PNG, max 2MB)
 * DELETE /api/me/avatar — remove uploaded avatar
 * GET /api/avatars/:userId — serve avatar image (public)
 */

import { Router } from 'express';
import multer, { MulterError } from 'multer';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { PostgresStore } from '../middleware/pg-rate-limit-store.js';
import { query } from '../db/client.js';

const logger = createLogger('avatar-routes');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG files are accepted'));
    }
  },
});

const avatarUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresStore('avatar:'),
  keyGenerator: (req) => (req as any).user?.id || req.ip || 'unknown',
  handler: (_req, res) => {
    res.status(429).json({ error: 'Upload rate limit exceeded. Try again later.' });
  },
});

/** Validate file content matches JPEG or PNG magic bytes. */
function isValidImageContent(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  return isJpeg || isPng;
}

/** Derive MIME type from magic bytes rather than trusting client-supplied Content-Type. */
function mimeFromMagicBytes(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  return 'image/jpeg';
}

/** Wrap multer to return JSON errors instead of raw HTML. */
function handleUpload(req: any, res: any, next: any) {
  upload.single('avatar')(req, res, (err: any) => {
    if (err) {
      const message = err instanceof MulterError ? err.message : err.message || 'Upload failed';
      return res.status(400).json({ error: message });
    }
    next();
  });
}

/**
 * Public router for serving avatars. Mount at /api/avatars.
 */
export function createPublicAvatarRouter(): Router {
  const router = Router();

  router.get('/:userId', async (req, res) => {
    try {
      const result = await query<{ avatar_data: Buffer; avatar_mime_type: string }>(
        'SELECT avatar_data, avatar_mime_type FROM users WHERE workos_user_id = $1 AND avatar_data IS NOT NULL',
        [req.params.userId],
      );

      if (result.rows.length === 0 || !result.rows[0].avatar_data) {
        return res.status(404).send('No avatar');
      }

      const { avatar_data, avatar_mime_type } = result.rows[0];
      res.set({
        'Content-Type': avatar_mime_type || 'image/jpeg',
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(avatar_data);
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'Failed to serve avatar');
      res.status(500).send('Internal error');
    }
  });

  return router;
}

/**
 * User router for uploading/deleting avatars. Mount at /api/me.
 */
export function createAvatarUserRouter(): Router {
  const router = Router();

  router.post('/avatar', requireAuth, avatarUploadLimiter, handleUpload, async (req, res) => {
    try {
      const userId = req.user!.id;

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      if (!isValidImageContent(req.file.buffer)) {
        return res.status(400).json({ error: 'File content does not match a valid JPEG or PNG image' });
      }

      const validatedMime = mimeFromMagicBytes(req.file.buffer);
      const avatarUrl = `/api/avatars/${userId}`;

      await query(
        `UPDATE users SET avatar_data = $1, avatar_mime_type = $2, avatar_url = $3 WHERE workos_user_id = $4`,
        [req.file.buffer, validatedMime, avatarUrl, userId],
      );

      logger.info({ userId }, 'Avatar uploaded');
      res.json({ avatar_url: avatarUrl });
    } catch (err) {
      logger.error({ err }, 'Avatar upload failed');
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  router.delete('/avatar', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;

      await query(
        `UPDATE users SET avatar_data = NULL, avatar_mime_type = NULL, avatar_url = NULL WHERE workos_user_id = $1`,
        [userId],
      );

      logger.info({ userId }, 'Avatar removed');
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Avatar removal failed');
      res.status(500).json({ error: 'Removal failed' });
    }
  });

  return router;
}
