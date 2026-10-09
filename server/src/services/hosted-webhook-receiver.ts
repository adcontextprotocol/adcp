import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { ComplyOptions } from '@adcp/sdk/testing';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('hosted-webhook-receiver');
const PORT_FIRST = 18080;
const PORT_LAST = 18127;
const LEASE_MINUTES = 45;
const activePorts = new Set<number>();
let nextPort = PORT_FIRST;

export interface HostedWebhookReceiverLease {
  options: NonNullable<ComplyOptions['webhook_receiver']>;
  release(): Promise<void>;
}

export interface HostedWebhookReceiverTarget {
  machineId: string;
  port: number;
}

export class HostedWebhookReceiverUnavailableError extends Error {
  readonly code = 'hosted_webhook_receiver_unavailable';

  constructor() {
    super('Hosted webhook receiver is unavailable; compliance evidence is incomplete');
  }
}

function isFlyPrivateIp(value: string | undefined): value is string {
  return Boolean(value && isIP(value) === 6 && value.toLowerCase().startsWith('fdaa:'));
}

function isFlyMachineId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8,24}$/.test(value));
}

function publicBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function reservePort(): number | null {
  for (let i = PORT_FIRST; i <= PORT_LAST; i++) {
    const port = nextPort;
    nextPort = port === PORT_LAST ? PORT_FIRST : port + 1;
    if (!activePorts.has(port)) {
      activePorts.add(port);
      return port;
    }
  }
  return null;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Creates a private listener route for one hosted comply() call. The SDK owns
 * the listener and appends a fresh /_adcp_receiver/<uuid> path per storyboard.
 * The web ingress relays that exact path via Fly 6PN; it never sees SDK state.
 *
 * Development callers have no public ingress and continue to use the SDK's
 * local defaults. Production callers fail closed if the relay is unavailable.
 */
export async function createHostedWebhookReceiverLease(): Promise<HostedWebhookReceiverLease | null> {
  if (process.env.NODE_ENV !== 'production') return null;

  const privateIp = process.env.FLY_PRIVATE_IP;
  const machineId = process.env.FLY_MACHINE_ID;
  const baseUrl = publicBaseUrl(process.env.BASE_URL);
  const port = reservePort();
  if (!isFlyPrivateIp(privateIp) || !isFlyMachineId(machineId) || !baseUrl || port === null) {
    if (port !== null) activePorts.delete(port);
    throw new HostedWebhookReceiverUnavailableError();
  }

  const token = randomBytes(32).toString('hex');
  const hash = tokenHash(token);
  try {
    const pool = getPool();
    await pool.query('DELETE FROM compliance_webhook_receiver_leases WHERE expires_at <= NOW()');
    await pool.query(
      `INSERT INTO compliance_webhook_receiver_leases (token_hash, machine_id, port, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))`,
      [hash, machineId, port, LEASE_MINUTES],
    );
  } catch (error) {
    activePorts.delete(port);
    logger.error({ err: error }, 'Could not register hosted webhook receiver');
    throw new HostedWebhookReceiverUnavailableError();
  }

  let released = false;
  return {
    options: {
      mode: 'proxy_url',
      host: privateIp,
      port,
      public_url: `${baseUrl}/api/compliance-receiver/${token}`,
    },
    async release() {
      if (released) return;
      released = true;
      activePorts.delete(port);
      try {
        await getPool().query('DELETE FROM compliance_webhook_receiver_leases WHERE token_hash = $1', [hash]);
      } catch (error) {
        // The lookup still expires after 45 minutes. A dead listener cannot
        // return passing evidence even when cleanup is temporarily delayed.
        logger.warn({ err: error }, 'Could not delete hosted webhook receiver lease');
      }
    },
  };
}

/** A token is a bearer route capability; callers only receive the private target. */
export async function findHostedWebhookReceiverTarget(token: string): Promise<HostedWebhookReceiverTarget | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const result = await getPool().query<{ machine_id: string; port: number }>(
    `SELECT machine_id, port
     FROM compliance_webhook_receiver_leases
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [tokenHash(token)],
  );
  const row = result.rows[0];
  if (!row || !isFlyMachineId(row.machine_id) || !Number.isInteger(row.port)
      || row.port < PORT_FIRST || row.port > PORT_LAST) return null;
  return { machineId: row.machine_id, port: row.port };
}
