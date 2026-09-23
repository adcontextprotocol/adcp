import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { validate as validateUuid } from 'uuid';
import { createLogger } from '../logger.js';

const logger = createLogger('addie-chat-request');
const errorCodes = new Map([
  ['Invalid session', 'invalid_session'],
  ['An unambiguous organization selection is required', 'organization_selection_conflict'],
  ['CSRF validation failed', 'csrf_validation_failed'],
  ['Authentication service temporarily unavailable', 'authentication_unavailable'],
  ['Authorization service temporarily unavailable', 'authorization_unavailable'],
  ['Conversation not found', 'conversation_not_found'],
  ['turn_in_progress', 'turn_in_progress'],
  ['Malformed request body', 'malformed_request'],
]);

/** Transport correlation only; never use this caller-supplied ID as authority or idempotency. */
export function chatRequestCorrelation(req: Request, res: Response, next: NextFunction): void {
  // Also installed on the router for standalone hosts. The HTTP entry point
  // installs it before parsing/CSRF/auth so those rejections are covered too.
  if (res.locals.chatRequestId) return next();
  const supplied = req.headers['x-request-id'];
  const requestId = typeof supplied === 'string' && supplied.length === 36 && validateUuid(supplied)
    ? supplied.toLowerCase()
    : randomUUID();
  res.locals.chatRequestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  const startedAt = Date.now();
  // Log a fixed route family, not URL query strings, identities, cookies or bodies.
  let errorCode: string | undefined;
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      const payload = body as Record<string, unknown>;
      errorCode = typeof payload.error === 'string' ? errorCodes.get(payload.error) : undefined;
      return json({ ...payload, request_id: requestId });
    }
    return json(body);
  };
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      logger.warn({
        event: 'addie_chat_request_failed', request_id: requestId,
        route: '/api/addie/chat', method: req.method, status: res.statusCode,
        error_code: errorCode, duration_ms: Date.now() - startedAt,
      }, 'Addie chat HTTP request failed');
    }
  });
  res.on('close', () => {
    if (!res.writableFinished) {
      logger.warn({
        event: 'addie_chat_request_interrupted', request_id: requestId,
        route: '/api/addie/chat', method: req.method, duration_ms: Date.now() - startedAt,
      }, 'Addie chat connection closed before completion');
    }
  });
  next();
}

export function correlateChatStreamError(res: Response, data: unknown): Record<string, unknown> {
  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown> : {};
  logger.warn({
    event: 'addie_chat_stream_failed', request_id: res.locals.chatRequestId,
    recoverable: payload.recoverable === true,
  }, 'Addie chat stream failed');
  return { ...payload, request_id: res.locals.chatRequestId };
}
