/**
 * Outbound response signing for the training agent.
 *
 * Wraps an Express `res` so that successful JSON responses get RFC 9421
 * `Signature`, `Signature-Input`, and `Content-Digest` headers before the
 * body is committed. The signing key is the tenant's response-signing
 * material (`getTenantResponseSigningMaterial`), distinct from the
 * webhook-signing key per the `adcp_use` distinct-keys-per-purpose
 * invariant the SDK enforces.
 *
 * The MCP transport (`StreamableHTTPServerTransport` with
 * `enableJsonResponse: true`) writes the JSON-RPC body directly to
 * `res.write` / `res.end`. To compute `Content-Digest` and set headers
 * before the body flushes, this wrapper:
 *
 *   1. Intercepts `res.writeHead` so the MCP transport's
 *      "headers-then-body" flush pattern can't commit headers until
 *      signing happens at `end()`.
 *   2. Buffers writes into `chunks: Buffer[]` until end().
 *   3. At end() time, signs the buffered body, sets signing headers,
 *      replays the deferred writeHead, then flushes via the original end().
 *
 * SSE / streaming bypass: if `writeHead` or `setHeader` observes
 * `Content-Type: text/event-stream`, the wrapper disengages — flushes
 * any buffered chunks via the original `write`, then routes subsequent
 * writes directly. Signing per-SSE-event isn't in the AdCP response-
 * signing profile and buffering SSE chunks until end() would break the
 * protocol entirely.
 *
 * Non-2xx and non-JSON responses pass through unsigned — buyer verifiers
 * treat unsigned errors as a hard miss, but a 500 is worse than a
 * missed signature.
 */
import type { Request, Response } from 'express';
import { signResponse, type ResponseLike, type SignerKey } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-response-signing');

/** Cap on buffered body bytes before we abandon signing and pass through.
 *  Defense in depth — the training agent's fixture data doesn't get this
 *  big in practice, but a misbehaving handler shouldn't be able to OOM the
 *  worker by buffering an unbounded response. */
const MAX_SIGNED_BODY_BYTES = 8 * 1024 * 1024;

/** Reconstruct the absolute request URL the SDK's response signer expects.
 *  Express's `req.originalUrl` is path+query only; the signer needs scheme
 *  and authority for `@authority` / `@target-uri` derivation. */
function absoluteRequestUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}${req.originalUrl}`;
}

/** Case-insensitive lookup against either Express-normalized headers
 *  (already lowercase) or raw `writeHead(status, headers)` headers
 *  (mixed case). */
function findHeader(headers: Record<string, string | string[] | number | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : (v === undefined ? undefined : String(v));
  }
  return undefined;
}

/** RFC 6839 — JSON content types include `application/json` plus any
 *  `+json` suffix (`application/vnd.api+json`, `application/problem+json`,
 *  `application/jose+json`). */
function isJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return lower.includes('application/json') || /\+json(\b|;)/.test(lower);
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
  let bufferedBytes = 0;
  /** Once true, the wrapper acts as a pass-through — buffered chunks have
   *  been flushed and subsequent writes go straight to the underlying
   *  stream. Set when SSE or oversize body is detected. */
  let passthrough = false;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origWriteHead = res.writeHead.bind(res) as Response['writeHead'];
  const origSetHeader = res.setHeader.bind(res);

  // Pending writeHead args — buffered when the MCP transport tries to flush
  // headers, replayed at end() time after signing headers have been added.
  let pendingStatus: number | undefined;
  let pendingStatusMessage: string | undefined;
  let pendingHeaders: Record<string, string | string[] | number | undefined> | undefined;

  function currentContentType(): string {
    return String(res.getHeader('content-type') || findHeader(pendingHeaders, 'content-type') || '');
  }

  function shouldSign(): boolean {
    if (passthrough) return false;
    const ct = currentContentType();
    if (!isJsonContentType(ct)) return false;
    const status = pendingStatus ?? res.statusCode;
    if (status < 200 || status >= 300) return false;
    return true;
  }

  function disengageAsPassthrough(reason: string): void {
    if (passthrough) return;
    passthrough = true;
    logger.debug({ tenantId, reason }, 'response signing disengaged; passing through unsigned');
    // Flush any deferred writeHead so the transport's own header bytes go
    // out before we start writing body chunks directly.
    if (!res.headersSent && pendingStatus !== undefined) {
      if (pendingStatusMessage !== undefined) origWriteHead(pendingStatus, pendingStatusMessage);
      else origWriteHead(pendingStatus);
    }
    // Flush any chunks we've already buffered.
    for (const c of chunks) origWrite(c);
    chunks.length = 0;
    bufferedBytes = 0;
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
    // Mirror pending headers into Express so getHeader() reflects them
    // even before we replay writeHead.
    if (pendingHeaders) {
      for (const [k, v] of Object.entries(pendingHeaders)) {
        if (Array.isArray(v)) origSetHeader(k, v as string[]);
        else if (v !== undefined) origSetHeader(k, v as string | number);
      }
    }
    if (pendingStatus !== undefined) res.statusCode = pendingStatus;
    // SSE detected via Content-Type — disengage immediately so chunked
    // event frames flow without buffering.
    if (isStreamingContentType(currentContentType())) {
      disengageAsPassthrough('sse-content-type-on-writeHead');
    }
    return res;
  };

  // Mirror setHeader so the wrapper sees Content-Type updates made via
  // setHeader instead of writeHead.
  (res as unknown as { setHeader: (...args: unknown[]) => Response }).setHeader = (name: unknown, value: unknown) => {
    origSetHeader(name as string, value as string);
    if (typeof name === 'string' && name.toLowerCase() === 'content-type' && isStreamingContentType(String(value))) {
      disengageAsPassthrough('sse-content-type-on-setHeader');
    }
    return res;
  };

  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    if (passthrough) return origWrite(chunk as Buffer | string, ...rest as []);
    if (chunk !== null && chunk !== undefined) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      bufferedBytes += buf.length;
      if (bufferedBytes > MAX_SIGNED_BODY_BYTES) {
        logger.warn({ tenantId, bufferedBytes }, 'response body exceeds signing cap; disengaging unsigned');
        chunks.push(buf);
        disengageAsPassthrough('body-size-cap');
        return true;
      }
      chunks.push(buf);
    }
    const cb = rest.find(a => typeof a === 'function') as (() => void) | undefined;
    if (cb) queueMicrotask(cb);
    return true;
  };

  (res as unknown as { end: (...args: unknown[]) => Response }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (passthrough) return origEnd(chunk as Buffer | string | undefined, ...rest as []);
    if (chunk !== null && chunk !== undefined) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
    }
    const body = Buffer.concat(chunks).toString('utf8');

    if (shouldSign() && body.length > 0) {
      try {
        const responseLike: ResponseLike = {
          status: pendingStatus ?? res.statusCode,
          headers: { 'content-type': currentContentType() || 'application/json' },
          body,
          request: {
            method: req.method,
            url: absoluteRequestUrl(req),
          },
        };
        const signed = signResponse(responseLike, signerKey);
        for (const [k, v] of Object.entries(signed.headers)) {
          if (typeof v === 'string') origSetHeader(k, v);
        }
        // Vary on the forwarding headers absoluteRequestUrl() reads so a
        // shared cache keyed only on path doesn't serve a signed body
        // back to a mismatched authority.
        origSetHeader('Vary', 'X-Forwarded-Host, X-Forwarded-Proto, Host');
      } catch (err) {
        // Don't break the request if signing fails — log and ship the
        // body unsigned. A 500 is worse than a missed signature; verifier
        // integration tests should assert headers present, not status==200.
        logger.error({ err: err instanceof Error ? err.message : String(err), tenantId }, 'response signing failed; shipping unsigned');
      }
    }

    if (!res.headersSent) {
      const status = pendingStatus ?? res.statusCode;
      if (pendingStatusMessage !== undefined) origWriteHead(status, pendingStatusMessage);
      else origWriteHead(status);
    }
    return origEnd(body, ...rest as []);
  };
}

function isStreamingContentType(ct: string): boolean {
  return ct.toLowerCase().includes('text/event-stream');
}
