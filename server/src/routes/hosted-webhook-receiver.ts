import { request as httpRequest } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import {
  findHostedWebhookReceiverTarget,
  type HostedWebhookReceiverTarget,
} from '../services/hosted-webhook-receiver.js';

const logger = createLogger('hosted-webhook-receiver-ingress');
const MAX_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16_384;
const PROXY_TIMEOUT_MS = 10_000;
const CALLBACK_PATH = /^\/api\/compliance-receiver\/([0-9a-f]{64})\/_adcp_receiver\/[0-9a-f-]{36}\/step\/[A-Za-z0-9_]+\/[A-Za-z0-9_-]+\/?$/;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'cookie', 'set-cookie', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto',
]);

type TargetLookup = (token: string) => Promise<HostedWebhookReceiverTarget | null>;
type AddressResolver = (machineId: string) => Promise<string>;

async function resolveFlyMachineAddress(machineId: string): Promise<string> {
  const appName = process.env.FLY_APP_NAME;
  if (!/^[0-9a-f]{8,24}$/.test(machineId) || !appName || !/^[a-z0-9-]+$/.test(appName)) {
    throw new Error('Invalid hosted webhook receiver machine');
  }
  // Machine-specific DNS restricts the relay to this Fly app. Resolve once,
  // validate the 6PN address, then dial that pinned IP to avoid DNS rebinding.
  const result = await dnsLookup(`${machineId}.vm.${appName}.internal`, { family: 6 });
  if (result.family !== 6 || isIP(result.address) !== 6 || !result.address.toLowerCase().startsWith('fdaa:')) {
    throw new Error('Hosted webhook receiver machine did not resolve inside Fly 6PN');
  }
  return result.address;
}

/**
 * Public HTTPS ingress for SDK callback listeners on private Fly machines.
 * The route token is random and short-lived; only POSTs to SDK step paths are
 * relayed. Its database target is constrained to Fly 6PN and a fixed port range.
 * The SDK listener owns schema validation, challenge responses, and evidence.
 */
export function createHostedWebhookReceiverRouter(
  findTarget: TargetLookup = findHostedWebhookReceiverTarget,
  resolveAddress: AddressResolver = resolveFlyMachineAddress,
): Router {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const rawBody = express.raw({ type: () => true, limit: MAX_BODY_BYTES, inflate: false });

  router.post('/:token/_adcp_receiver/:receiverId/step/:stepId/:operationId', limiter, rawBody, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // The SDK accepts a query on callback paths and uses it in the logical
    // signed target. Validate the path, then relay the original URL intact.
    const match = CALLBACK_PATH.exec(req.originalUrl.split('?', 1)[0]);
    if (!match || match[1] !== req.params.token) return res.status(404).end();
    if (!Buffer.isBuffer(req.body)) return res.status(400).end();

    let target: HostedWebhookReceiverTarget | null;
    try {
      target = await findTarget(match[1]);
    } catch (error) {
      logger.warn({ err: error }, 'Hosted webhook receiver lookup unavailable');
      return res.status(503).end();
    }
    if (!target) return res.status(404).end();
    if (!/^[0-9a-f]{8,24}$/.test(target.machineId) || !Number.isInteger(target.port)
        || target.port < 18080 || target.port > 18127) return res.status(503).end();

    let address: string;
    let publicHost: string;
    try {
      address = await resolveAddress(target.machineId);
      publicHost = new URL(process.env.BASE_URL || '').host;
      if (!publicHost || req.headers.host?.toLowerCase() !== publicHost.toLowerCase()) {
        return res.status(400).end();
      }
    } catch (error) {
      logger.warn({ err: error }, 'Hosted webhook receiver target unavailable');
      return res.status(503).end();
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    // Preserve the public authority for RFC 9421 signatures while connecting
    // to the runner's private address. The body bytes are forwarded unchanged.
    headers.host = publicHost;
    headers['content-length'] = String(req.body.length);

    await new Promise<void>(resolve => {
      let finished = false;
      const finish = (status: number, body?: Buffer, responseHeaders?: Record<string, string>) => {
        if (finished) return;
        finished = true;
        if (responseHeaders?.['content-type']) res.setHeader('Content-Type', responseHeaders['content-type']);
        if (responseHeaders?.['retry-after']) res.setHeader('Retry-After', responseHeaders['retry-after']);
        res.status(status).end(body);
        resolve();
      };
      const upstream = httpRequest({
        hostname: address,
        port: target.port,
        method: 'POST',
        path: req.originalUrl,
        headers,
        timeout: PROXY_TIMEOUT_MS,
      }, upstreamRes => {
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamRes.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            upstreamRes.destroy();
            finish(502);
          } else {
            chunks.push(chunk);
          }
        });
        upstreamRes.on('end', () => {
          finish(upstreamRes.statusCode || 502, Buffer.concat(chunks), {
            'content-type': String(upstreamRes.headers['content-type'] || ''),
            'retry-after': String(upstreamRes.headers['retry-after'] || ''),
          });
        });
        upstreamRes.on('error', () => finish(502));
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => finish(503));
      upstream.end(req.body);
    });
  });

  // The mounted prefix must terminate here. Falling through would expose the
  // bearer route token to generic path logging and body-parser error handlers.
  router.use((error: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.type === 'entity.too.large' ? 413 : 400).end();
  });
  router.use((_req, res) => res.status(404).end());

  return router;
}
