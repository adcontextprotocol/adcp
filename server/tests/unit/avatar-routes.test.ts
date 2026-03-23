import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPublicAvatarRouter, createAvatarUserRouter } from '../../src/routes/avatar.js';

// Mock the auth middleware to pass through
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    _req.user = { id: 'user_test_123' };
    next();
  },
}));

// Mock the rate limit store to avoid DB dependency
vi.mock('../../src/middleware/pg-rate-limit-store.js', () => ({
  PostgresStore: class {
    init() { return Promise.resolve(); }
    increment() { return Promise.resolve({ totalHits: 1, resetTime: new Date() }); }
    decrement() { return Promise.resolve(); }
    resetKey() { return Promise.resolve(); }
  },
}));

// Mock the database client
const mockQueryResult = { rows: [] as any[] };
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(() => Promise.resolve(mockQueryResult)),
}));

import { query } from '../../src/db/client.js';
const mockQuery = vi.mocked(query);

function buildApp() {
  const app = express();
  app.use('/api/avatars', createPublicAvatarRouter());
  app.use('/api/me', createAvatarUserRouter());
  return app;
}

describe('Avatar routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryResult.rows = [];
  });

  describe('GET /api/avatars/:userId', () => {
    it('returns 404 when no avatar exists', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/avatars/user_test_123');
      expect(res.status).toBe(404);
    });

    it('serves avatar image with security headers', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes
      mockQueryResult.rows = [{ avatar_data: pngBuffer, avatar_mime_type: 'image/png' }];

      const app = buildApp();
      const res = await request(app).get('/api/avatars/user_test_123');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('public');
    });
  });

  describe('POST /api/me/avatar', () => {
    it('returns 400 when no file is uploaded', async () => {
      const app = buildApp();
      const res = await request(app).post('/api/me/avatar');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No file uploaded');
    });

    it('uploads a JPEG avatar and sets avatar_url', async () => {
      const app = buildApp();
      // Valid JPEG: starts with FF D8 FF
      const jpegBuffer = Buffer.alloc(100);
      jpegBuffer[0] = 0xFF;
      jpegBuffer[1] = 0xD8;
      jpegBuffer[2] = 0xFF;
      jpegBuffer[3] = 0xE0;

      const res = await request(app)
        .post('/api/me/avatar')
        .attach('avatar', jpegBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(200);
      expect(res.body.avatar_url).toBe('/api/avatars/user_test_123');
      // MIME type is derived from magic bytes, not client header
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET avatar_data'),
        expect.arrayContaining([expect.any(Buffer), 'image/jpeg', '/api/avatars/user_test_123', 'user_test_123']),
      );
    });

    it('uploads a PNG avatar', async () => {
      const app = buildApp();
      const pngBuffer = Buffer.alloc(100);
      pngBuffer[0] = 0x89;
      pngBuffer[1] = 0x50;
      pngBuffer[2] = 0x4E;
      pngBuffer[3] = 0x47;

      const res = await request(app)
        .post('/api/me/avatar')
        .attach('avatar', pngBuffer, { filename: 'photo.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.avatar_url).toBe('/api/avatars/user_test_123');
    });

    it('rejects files with invalid magic bytes', async () => {
      const app = buildApp();
      // Claim it is JPEG but content is actually HTML
      const htmlBuffer = Buffer.from('<html><script>alert(1)</script></html>');

      const res = await request(app)
        .post('/api/me/avatar')
        .attach('avatar', htmlBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('does not match');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects non-image content types via multer', async () => {
      const app = buildApp();
      const textBuffer = Buffer.from('not an image');

      const res = await request(app)
        .post('/api/me/avatar')
        .attach('avatar', textBuffer, { filename: 'file.txt', contentType: 'text/plain' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('JPEG and PNG');
    });
  });

  describe('DELETE /api/me/avatar', () => {
    it('removes avatar data and url', async () => {
      const app = buildApp();
      const res = await request(app).delete('/api/me/avatar');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('avatar_data = NULL'),
        ['user_test_123'],
      );
    });
  });
});
