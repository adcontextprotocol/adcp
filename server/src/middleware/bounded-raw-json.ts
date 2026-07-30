import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * Webhook payloads are metadata, not file uploads. Keep the unauthenticated
 * pre-verification buffer small enough to prevent memory exhaustion while
 * leaving ample room for inbound email text/HTML.
 */
export const WEBHOOK_RAW_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const rawJsonParser = express.raw({
  type: 'application/json',
  limit: WEBHOOK_RAW_BODY_LIMIT_BYTES,
});

export type RawJsonRequest = Request & { rawBody: string };

/**
 * Parse a bounded JSON request while retaining the exact bytes as UTF-8 for
 * webhook signature verification. Parser errors (including 413) are forwarded
 * to the application's normal Express error handler.
 */
export function boundedRawJson(req: Request, res: Response, next: NextFunction): void {
  rawJsonParser(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'Content-Type must be application/json' });
      return;
    }

    const rawBody = req.body.toString('utf8');
    try {
      req.body = JSON.parse(rawBody);
      (req as RawJsonRequest).rawBody = rawBody;
      next();
    } catch {
      res.status(400).json({ error: 'Invalid JSON' });
    }
  });
}

