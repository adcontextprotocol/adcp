/**
 * Outbound response signing for the training agent.
 *
 * Wraps an Express `res` so that successful JSON responses get RFC 9421
 * `Signature`, `Signature-Input`, and `Content-Digest` headers before the
 * body is committed. The signing key is the tenant's response-signing
 * material (`getTenantResponseSigningMaterial`), distinct from the
 * webhook-signing key per the `adcp_use` distinct-keys-per-purpose
 * invariant.
 *
 * The MCP transport (`StreamableHTTPServerTransport` with
 * `enableJsonResponse: true`) writes the JSON-RPC body directly to
 * `res.write` / `res.end`. To compute `Content-Digest` and set headers
 * before the body flushes, this wrapper buffers all writes, signs the
 * concatenated body at `end()` time, sets headers via `res.setHeader`,
 * then issues a single underlying `end()` with the buffered body.
 *
 * Streaming responses (text/event-stream) and non-2xx responses pass
 * through unsigned — the MCP transport falls back to SSE for some
 * tool calls, and signing an error body is not what the buyer is
 * verifying against.
 */
import type { Request, Response } from 'express';
import { signResponse, type ResponseLike, type SignerKey } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-response-signing');

/** Reconstruct the absolute request URL the SDK's response signer expects.
 *  Express's `req.originalUrl` is path+query only; the signer needs scheme
 *  and authority for `@authority` / `@target-uri` derivation. */
function absoluteRequestUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Mutate `res` so a successful JSON response gets signed before it flushes.
 *
 * @param signerKey  Tenant's response-signing key (must carry
 *                   `adcp_use: 'response-signing'`; the SDK enforces this).
 * @param tenantId   Used in log lines for failure correlation.
 */
export function wrapResponseForSigning(req: Request, res: Response, signerKey: SignerKey, tenantId: string): void {
  const chunks: Buffer[] = [];
  // Capture the originals — we must NOT call the wrapped versions when
  // flushing or we infinite-loop.
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origWriteHead = res.writeHead.bind(res) as Response['writeHead'];

  // Pending writeHead args — buffered when the MCP transport tries to flush
  // headers, replayed at end() time after signing headers have been added.
  let pendingStatus: number | undefined;
  let pendingStatusMessage: string | undefined;
  let pendingHeaders: Record<string, string | string[] | number> | undefined;

  function shouldSign(): boolean {
    const contentType = String(res.getHeader('content-type') || (pendingHeaders ? pendingHeaders['content-type'] || pendingHeaders['Content-Type'] || '' : ''));
    if (!String(contentType).includes('application/json')) return false;
    const status = pendingStatus ?? res.statusCode;
    if (status < 200 || status >= 300) return false;
    return true;
  }

  // Buffer writeHead — the MCP transport calls this to commit status +
  // headers before writing the body, which would flush headers and lock
  // us out of adding Signature / Signature-Input. Capture the args and
  // replay them at end() time after signing.
  (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = (...args: unknown[]) => {
    pendingStatus = typeof args[0] === 'number' ? (args[0] as number) : pendingStatus;
    if (typeof args[1] === 'string') {
      pendingStatusMessage = args[1] as string;
      if (args[2] && typeof args[2] === 'object') pendingHeaders = args[2] as typeof pendingHeaders;
    } else if (args[1] && typeof args[1] === 'object') {
      pendingHeaders = args[1] as typeof pendingHeaders;
    }
    if (pendingHeaders) {
      for (const [k, v] of Object.entries(pendingHeaders)) {
        if (Array.isArray(v)) res.setHeader(k, v as string[]);
        else if (v !== undefined) res.setHeader(k, v as string | number);
      }
    }
    if (pendingStatus !== undefined) res.statusCode = pendingStatus;
    return res;
  };

  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    if (chunk !== null && chunk !== undefined) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
    }
    const cb = rest.find(a => typeof a === 'function') as (() => void) | undefined;
    if (cb) queueMicrotask(cb);
    return true;
  };

  (res as unknown as { end: (...args: unknown[]) => Response }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== null && chunk !== undefined) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
    }
    const body = Buffer.concat(chunks).toString('utf8');

    if (shouldSign() && body.length > 0) {
      try {
        const responseLike: ResponseLike = {
          status: pendingStatus ?? res.statusCode,
          headers: { 'content-type': String(res.getHeader('content-type') || 'application/json') },
          body,
          request: {
            method: req.method,
            url: absoluteRequestUrl(req),
          },
        };
        const signed = signResponse(responseLike, signerKey);
        for (const [k, v] of Object.entries(signed.headers)) {
          if (typeof v === 'string') res.setHeader(k, v);
        }
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), tenantId }, 'response signing failed; shipping unsigned');
      }
    }

    // Now commit the headers (writeHead was deferred) + flush the body.
    if (!res.headersSent) {
      const status = pendingStatus ?? res.statusCode;
      if (pendingStatusMessage) origWriteHead(status, pendingStatusMessage);
      else origWriteHead(status);
    }
    return origEnd(body, ...rest as []);
  };
}
