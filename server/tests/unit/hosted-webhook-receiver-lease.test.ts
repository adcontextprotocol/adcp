import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../src/db/client.js', () => ({ getPool: () => ({ query }) }));

import {
  createHostedWebhookReceiverLease,
  findHostedWebhookReceiverTarget,
  HostedWebhookReceiverUnavailableError,
} from '../../src/services/hosted-webhook-receiver.js';

afterEach(() => {
  vi.unstubAllEnvs();
  query.mockReset();
});

describe('hosted webhook receiver lease', () => {
  it('stores a hash of a run-scoped token and deletes the lease on completion', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_URL', 'https://agenticadvertising.org');
    vi.stubEnv('FLY_PRIVATE_IP', 'fdaa:1:2:3::4');
    vi.stubEnv('FLY_MACHINE_ID', '784dd123abcd45');
    query.mockResolvedValue({ rows: [] });

    const lease = await createHostedWebhookReceiverLease();
    expect(lease?.options).toMatchObject({
      mode: 'proxy_url',
      host: 'fdaa:1:2:3::4',
    });
    const token = lease?.options.public_url?.split('/').pop();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const hash = createHash('sha256').update(token!).digest('hex');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO compliance_webhook_receiver_leases');
    expect(query.mock.calls[1][1]).toEqual([hash, '784dd123abcd45', lease?.options.port, 45]);
    expect(query.mock.calls[1][1]).not.toContain(token);

    query.mockResolvedValueOnce({ rows: [{ machine_id: '784dd123abcd45', port: lease?.options.port }] });
    await expect(findHostedWebhookReceiverTarget(token!)).resolves.toEqual({
      machineId: '784dd123abcd45', port: lease?.options.port,
    });
    expect(query.mock.calls[2][1]).toEqual([hash]);

    await lease?.release();
    await lease?.release();
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith('DELETE FROM compliance_webhook_receiver_leases WHERE token_hash'))).toHaveLength(1);
  });

  it('rejects missing Fly private identity instead of publishing an unusable callback', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_URL', 'https://agenticadvertising.org');
    vi.stubEnv('FLY_PRIVATE_IP', '');
    vi.stubEnv('FLY_MACHINE_ID', '784dd123abcd45');
    await expect(createHostedWebhookReceiverLease()).rejects.toBeInstanceOf(HostedWebhookReceiverUnavailableError);
    expect(query).not.toHaveBeenCalled();
  });
});
